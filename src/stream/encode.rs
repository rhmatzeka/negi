//! H.264 with the Mac's hardware encoder (VideoToolbox), tuned for a remote screen: real
//! time, no frame reordering, low-latency rate control, and a keyframe only when asked.

use std::ffi::c_void;
use std::ptr;
use std::sync::Mutex;

use core_foundation::base::{CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::{CFString, CFStringRef};
use screencapturekit::cm::CMTime;

type OSStatus = i32;
type Session = *mut c_void;
type SampleBuffer = *mut c_void;

const H264: u32 = u32::from_be_bytes(*b"avc1");

type OutputCallback = extern "C" fn(refcon: *mut c_void, frame: *mut c_void, status: OSStatus, flags: u32, sample: SampleBuffer);

#[link(name = "VideoToolbox", kind = "framework")]
unsafe extern "C" {
    fn VTCompressionSessionCreate(
        allocator: *const c_void,
        width: i32,
        height: i32,
        codec: u32,
        encoder_specification: *const c_void,
        source_attributes: *const c_void,
        compressed_allocator: *const c_void,
        callback: OutputCallback,
        refcon: *mut c_void,
        out: *mut Session,
    ) -> OSStatus;
    fn VTSessionSetProperty(session: Session, key: CFStringRef, value: *const c_void) -> OSStatus;
    fn VTCompressionSessionPrepareToEncodeFrames(session: Session) -> OSStatus;
    fn VTCompressionSessionEncodeFrame(
        session: Session,
        image: *mut c_void,
        pts: CMTime,
        duration: CMTime,
        properties: *const c_void,
        frame_refcon: *mut c_void,
        flags_out: *mut u32,
    ) -> OSStatus;
    fn VTCompressionSessionCompleteFrames(session: Session, until: CMTime) -> OSStatus;
    fn VTCompressionSessionInvalidate(session: Session);

    static kVTCompressionPropertyKey_RealTime: CFStringRef;
    static kVTCompressionPropertyKey_AllowFrameReordering: CFStringRef;
    static kVTCompressionPropertyKey_ProfileLevel: CFStringRef;
    static kVTProfileLevel_H264_Main_AutoLevel: CFStringRef;
    static kVTCompressionPropertyKey_AverageBitRate: CFStringRef;
    static kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration: CFStringRef;
    static kVTCompressionPropertyKey_ExpectedFrameRate: CFStringRef;
    static kVTEncodeFrameOptionKey_ForceKeyFrame: CFStringRef;
    static kVTVideoEncoderSpecification_EnableLowLatencyRateControl: CFStringRef;
}

#[link(name = "CoreMedia", kind = "framework")]
unsafe extern "C" {
    fn CMSampleBufferGetSampleAttachmentsArray(sample: SampleBuffer, create: u8) -> *const c_void;
    fn CMSampleBufferGetFormatDescription(sample: SampleBuffer) -> *const c_void;
    fn CMSampleBufferGetDataBuffer(sample: SampleBuffer) -> *mut c_void;
    fn CMSampleBufferGetPresentationTimeStamp(sample: SampleBuffer) -> CMTime;
    fn CMBlockBufferGetDataLength(block: *mut c_void) -> usize;
    fn CMBlockBufferCopyDataBytes(block: *mut c_void, offset: usize, length: usize, to: *mut c_void) -> OSStatus;
    fn CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
        format: *const c_void,
        index: usize,
        set: *mut *const u8,
        size: *mut usize,
        count: *mut usize,
        header_length: *mut i32,
    ) -> OSStatus;
    static kCMSampleAttachmentKey_NotSync: CFStringRef;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFArrayGetCount(array: *const c_void) -> isize;
    fn CFArrayGetValueAtIndex(array: *const c_void, index: isize) -> *const c_void;
    fn CFDictionaryGetValue(dict: *const c_void, key: *const c_void) -> *const c_void;
    fn CFBooleanGetValue(boolean: *const c_void) -> u8;
    fn CFRelease(cf: *const c_void);
}

/// One encoded picture: Annex B, with SPS and PPS in front when it is a keyframe.
pub struct Encoded {
    pub key: bool,
    /// Microseconds on the encoder's own clock.
    pub micros: u64,
    pub data: Vec<u8>,
}

/// Where encoded pictures go. Called on VideoToolbox's own thread.
pub type Sink = Box<dyn Fn(Encoded) + Send + Sync>;

pub struct Encoder {
    // With the last stamp given, so stamps only go forward whichever thread encodes.
    session: Mutex<(Session, u64)>,
    // Owned here, handed to VideoToolbox as the callback's refcon; freed after the session.
    sink: *mut Sink,
}

// The session is used under its lock; VideoToolbox calls the sink from its own thread.
unsafe impl Send for Encoder {}
unsafe impl Sync for Encoder {}

impl Encoder {
    pub fn new(width: u32, height: u32, bitrate: u32, sink: Sink) -> Result<Self, String> {
        let sink = Box::into_raw(Box::new(sink));
        let mut session: Session = ptr::null_mut();
        let status = unsafe {
            let spec = CFDictionary::from_CFType_pairs(&[(
                CFString::wrap_under_get_rule(kVTVideoEncoderSpecification_EnableLowLatencyRateControl).as_CFType(),
                CFBoolean::true_value().as_CFType(),
            )]);
            VTCompressionSessionCreate(
                ptr::null(),
                width as i32,
                height as i32,
                H264,
                spec.as_concrete_TypeRef().cast(),
                ptr::null(),
                ptr::null(),
                output,
                sink.cast(),
                &mut session,
            )
        };
        if status != 0 || session.is_null() {
            drop(unsafe { Box::from_raw(sink) });
            return Err(format!("the hardware encoder refused to start ({status})"));
        }
        let yes = CFBoolean::true_value();
        let no = CFBoolean::false_value();
        unsafe {
            let set = |key: CFStringRef, value: &CFType| VTSessionSetProperty(session, key, value.as_CFTypeRef());
            set(kVTCompressionPropertyKey_RealTime, &yes.as_CFType());
            set(kVTCompressionPropertyKey_AllowFrameReordering, &no.as_CFType());
            set(
                kVTCompressionPropertyKey_ProfileLevel,
                &CFString::wrap_under_get_rule(kVTProfileLevel_H264_Main_AutoLevel).as_CFType(),
            );
            set(kVTCompressionPropertyKey_AverageBitRate, &CFNumber::from(bitrate as i32).as_CFType());
            // Keyframes are big; they are made when a viewer joins or asks, not on a timer.
            set(kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, &CFNumber::from(3600).as_CFType());
            set(kVTCompressionPropertyKey_ExpectedFrameRate, &CFNumber::from(30).as_CFType());
            VTCompressionSessionPrepareToEncodeFrames(session);
        }
        Ok(Self { session: Mutex::new((session, 0)), sink })
    }

    /// Encodes one picture, stamped `micros`.
    ///
    /// # Safety
    /// `image` must be a live `CVPixelBuffer` of the size the encoder was made for.
    pub unsafe fn encode(&self, image: *mut c_void, micros: u64, key: bool) {
        let mut guard = self.session.lock().unwrap_or_else(|e| e.into_inner());
        let (session, last) = &mut *guard;
        if session.is_null() {
            return;
        }
        let micros = micros.max(*last + 1);
        *last = micros;
        let force = key.then(|| {
            CFDictionary::from_CFType_pairs(&[(
                unsafe { CFString::wrap_under_get_rule(kVTEncodeFrameOptionKey_ForceKeyFrame) }.as_CFType(),
                CFBoolean::true_value().as_CFType(),
            )])
        });
        let properties = force.as_ref().map_or(ptr::null(), |d| d.as_concrete_TypeRef().cast());
        unsafe {
            VTCompressionSessionEncodeFrame(
                *session,
                image,
                CMTime::new(micros as i64, 1_000_000),
                CMTime::INVALID,
                properties,
                ptr::null_mut(),
                ptr::null_mut(),
            );
        }
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        let mut guard = self.session.lock().unwrap_or_else(|e| e.into_inner());
        let session = &mut guard.0;
        unsafe {
            VTCompressionSessionCompleteFrames(*session, CMTime::INVALID);
            VTCompressionSessionInvalidate(*session);
            CFRelease(session.cast_const());
            *session = ptr::null_mut();
            drop(Box::from_raw(self.sink));
        }
    }
}

extern "C" fn output(refcon: *mut c_void, _frame: *mut c_void, status: OSStatus, _flags: u32, sample: SampleBuffer) {
    if status != 0 || sample.is_null() || refcon.is_null() {
        return;
    }
    let sink = unsafe { &*(refcon as *const Sink) };
    let key = unsafe { is_key(sample) };
    let mut data = Vec::new();
    if key {
        unsafe { parameter_sets(sample, &mut data) };
    }
    let block = unsafe { CMSampleBufferGetDataBuffer(sample) };
    if block.is_null() {
        return;
    }
    let length = unsafe { CMBlockBufferGetDataLength(block) };
    let mut avcc = vec![0u8; length];
    if unsafe { CMBlockBufferCopyDataBytes(block, 0, length, avcc.as_mut_ptr().cast()) } != 0 {
        return;
    }
    annex_b(&avcc, &mut data);
    let pts = unsafe { CMSampleBufferGetPresentationTimeStamp(sample) };
    let micros = if pts.timescale > 0 { (pts.value as i128 * 1_000_000 / pts.timescale as i128) as u64 } else { 0 };
    sink(Encoded { key, micros, data });
}

/// A picture is a keyframe unless it is marked as depending on another.
unsafe fn is_key(sample: SampleBuffer) -> bool {
    unsafe {
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, 0);
        if attachments.is_null() || CFArrayGetCount(attachments) == 0 {
            return true;
        }
        let first = CFArrayGetValueAtIndex(attachments, 0);
        let not_sync = CFDictionaryGetValue(first, kCMSampleAttachmentKey_NotSync.cast());
        not_sync.is_null() || CFBooleanGetValue(not_sync) == 0
    }
}

unsafe fn parameter_sets(sample: SampleBuffer, out: &mut Vec<u8>) {
    unsafe {
        let format = CMSampleBufferGetFormatDescription(sample);
        if format.is_null() {
            return;
        }
        let mut count = 0usize;
        let none = ptr::null_mut();
        CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, 0, none, ptr::null_mut(), &mut count, ptr::null_mut());
        for index in 0..count {
            let (mut set, mut size) = (ptr::null::<u8>(), 0usize);
            if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, index, &mut set, &mut size, ptr::null_mut(), ptr::null_mut()) == 0 && !set.is_null() {
                out.extend_from_slice(&START);
                out.extend_from_slice(std::slice::from_raw_parts(set, size));
            }
        }
    }
}

const START: [u8; 4] = [0, 0, 0, 1];

/// VideoToolbox writes each NAL unit after its length in four bytes; a browser's decoder,
/// given no description, wants them after start codes.
pub fn annex_b(avcc: &[u8], out: &mut Vec<u8>) {
    let mut at = 0;
    while at + 4 <= avcc.len() {
        let length = u32::from_be_bytes([avcc[at], avcc[at + 1], avcc[at + 2], avcc[at + 3]]) as usize;
        let end = at + 4 + length;
        if end > avcc.len() {
            break;
        }
        out.extend_from_slice(&START);
        out.extend_from_slice(&avcc[at + 4..end]);
        at = end;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn length_prefixes_become_start_codes() {
        let avcc = [0, 0, 0, 2, 0x65, 0xaa, 0, 0, 0, 1, 0x41];
        let mut out = Vec::new();
        annex_b(&avcc, &mut out);
        assert_eq!(out, [0, 0, 0, 1, 0x65, 0xaa, 0, 0, 0, 1, 0x41]);
    }

    #[test]
    fn a_truncated_unit_is_left_out() {
        let avcc = [0, 0, 0, 1, 0x41, 0, 0, 0, 9, 0x41];
        let mut out = Vec::new();
        annex_b(&avcc, &mut out);
        assert_eq!(out, [0, 0, 0, 1, 0x41]);
    }
}
