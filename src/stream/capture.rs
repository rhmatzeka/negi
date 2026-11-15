//! The main display, captured at the size it is sent and encoded as it arrives. A still screen
//! sends nothing; the last picture is kept to make a keyframe from on demand.

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use core_graphics::display::CGDisplay;
use screencapturekit::cm::SCFrameStatus;
use screencapturekit::prelude::*;

use super::encode::{Encoded, Encoder};

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRetain(cf: *const c_void) -> *const c_void;
    fn CFRelease(cf: *const c_void);
}

/// Asking macOS for its displays takes about half a second; the answer is kept a while.
/// Never asked while the lock is held, so a slow answer stalls only the one who asked.
static CONTENT: Mutex<Option<(Instant, Arc<SCShareableContent>)>> = Mutex::new(None);
const CONTENT_FOR: Duration = Duration::from_secs(600);

fn content(fresh: bool) -> Result<Arc<SCShareableContent>, String> {
    if !fresh {
        let kept = CONTENT.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((at, content)) = kept.as_ref()
            && at.elapsed() < CONTENT_FOR
        {
            return Ok(content.clone());
        }
    }
    let content = Arc::new(SCShareableContent::get().map_err(|_| "negi may not record the screen".to_owned())?);
    *CONTENT.lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), content.clone()));
    Ok(content)
}

/// What the capture is: its size in pixels, and the display's place on the desktop in points.
#[derive(Clone, Copy, Debug)]
pub struct Geometry {
    pub width: u32,
    pub height: u32,
    pub origin: (f64, f64),
    pub size: (f64, f64),
}

/// A retained `CVPixelBuffer`.
struct Picture(*mut c_void);
unsafe impl Send for Picture {}
impl Drop for Picture {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0.cast_const()) };
    }
}

struct Shared {
    encoder: Encoder,
    started: Instant,
    want_key: AtomicBool,
    last: Mutex<Option<Picture>>,
}

impl Shared {
    fn micros(&self) -> u64 {
        self.started.elapsed().as_micros() as u64
    }
}

pub struct Capture {
    stream: SCStream,
    shared: Arc<Shared>,
    pub geometry: Geometry,
}

impl Capture {
    /// Starts capturing the main display `width` pixels wide (at most its own pixels).
    /// Fails when this process may not record the screen.
    pub fn start(width: u32, bitrate: u32, sink: impl Fn(Encoded) + Send + Sync + 'static) -> Result<Self, String> {
        let main = CGDisplay::main().id;
        let mut displays = content(false)?.displays();
        // A display plugged in or out since: look again.
        if !displays.iter().any(|d| d.display_id() == main) {
            displays = content(true)?.displays();
        }
        let display = displays
            .iter()
            .find(|d| d.display_id() == main)
            .or(displays.first())
            .ok_or("no display to capture")?;
        let frame = display.frame();
        let points = (display.width().max(1), display.height().max(1));
        let pixels = CGDisplay::new(display.display_id()).pixels_wide().max(points.0 as u64) as u32;
        // Even sizes: the encoder works in 2x2 blocks of colour.
        let width = width.clamp(320, pixels) & !1;
        let height = ((width as u64 * points.1 as u64 / points.0 as u64) as u32).max(2) & !1;
        let geometry = Geometry {
            width,
            height,
            origin: (frame.origin.x, frame.origin.y),
            size: (frame.size.width, frame.size.height),
        };

        let encoder = Encoder::new(width, height, bitrate, Box::new(sink))?;
        let shared = Arc::new(Shared {
            encoder,
            started: Instant::now(),
            want_key: AtomicBool::new(true),
            last: Mutex::new(None),
        });

        let filter = SCContentFilter::create()
            .with_display(display)
            .with_excluding_windows(&[])
            .build()
            .map_err(|e| e.to_string())?;
        // The page draws the pointer where the finger puts it, at once; in the picture it would
        // trail by a whole round trip.
        let config = SCStreamConfiguration::new()
            .with_width(width)
            .with_height(height)
            .with_pixel_format(PixelFormat::YCbCr_420v)
            .with_minimum_frame_interval(&CMTime::new(1, 30))
            .with_shows_cursor(false)
            .with_queue_depth(5);
        let mut stream = SCStream::new(&filter, &config).map_err(|e| e.to_string())?;
        let on_frame = shared.clone();
        stream
            .add_output_handler(
                move |sample: CMSampleBuffer, kind: SCStreamOutputType| {
                    if kind != SCStreamOutputType::Screen {
                        return;
                    }
                    let status = sample.frame_info().and_then(|info| info.frame_status);
                    if !matches!(status, Some(SCFrameStatus::Complete | SCFrameStatus::Started)) {
                        return;
                    }
                    let image = sample.image_buffer_ptr_borrowed();
                    if image.is_null() {
                        return;
                    }
                    let key = on_frame.want_key.swap(false, Ordering::AcqRel);
                    // The picture is ScreenCaptureKit's, alive for this call, at the configured size.
                    unsafe { on_frame.encoder.encode(image, on_frame.micros(), key) };
                    let kept = Picture(unsafe { CFRetain(image.cast_const()) }.cast_mut());
                    *on_frame.last.lock().unwrap_or_else(|e| e.into_inner()) = Some(kept);
                },
                SCStreamOutputType::Screen,
            )
            .map_err(|e| e.to_string())?;
        stream.start_capture().map_err(|_| "negi may not record the screen".to_owned())?;
        Ok(Self { stream, shared, geometry })
    }

    /// A keyframe as soon as possible: from the last picture now, so a still screen shows at
    /// once, and from the next one too.
    pub fn keyframe(&self) {
        let last = self.shared.last.lock().unwrap_or_else(|e| e.into_inner());
        match last.as_ref() {
            // Retained by `last` while it is encoded.
            Some(picture) => unsafe { self.shared.encoder.encode(picture.0, self.shared.micros(), true) },
            None => self.shared.want_key.store(true, Ordering::Release),
        }
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        let _ = self.stream.stop_capture();
    }
}
