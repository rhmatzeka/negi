//! The screen as live H.264 over the socket, and input back the other way. The wire format
//! is in docs/SPEC.md, under `/api/screen`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex, Once};
use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::App;
use super::screen::{refuse, say};
use crate::store::Device;
use crate::stream::capture::Capture;
use crate::stream::encode::Encoded;
use crate::stream::input::{self, Input};
use crate::stream::login;

/// About what a desktop needs while it moves; still, it costs nothing.
const BITRATE: u32 = 3_000_000;
/// Pictures waiting for the socket. More would only be latency.
const QUEUE: usize = 4;
/// Captures running at once. Each holds the hardware encoder; a pile of them stalls the next.
const AT_ONCE: usize = 2;
static RUNNING: AtomicUsize = AtomicUsize::new(0);
/// How long macOS may take to start a capture before the phone is told to use screen sharing.
const START_WITHIN: Duration = Duration::from_secs(5);

/// One of the captures allowed at once, given back when dropped.
struct Slot;
impl Slot {
    fn take() -> Option<Self> {
        RUNNING
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| (n < AT_ONCE).then_some(n + 1))
            .ok()
            .map(|_| Slot)
    }
}
impl Drop for Slot {
    fn drop(&mut self) {
        RUNNING.fetch_sub(1, Ordering::AcqRel);
    }
}

pub(super) async fn bridge(app: Arc<App>, mut ws: WebSocket, device: Device, token: String, hello: &Value) {
    // `NEGI_NO_VIDEO` makes the server refuse, as a Mac without the permission does; the
    // tests use it to check that the page falls back to screen sharing.
    if std::env::var_os("NEGI_NO_VIDEO").is_some() {
        refuse(&mut ws, json!({ "error": "live video is turned off", "video": false })).await;
        return;
    }
    // Over video a paired phone sees and drives the Mac, so it first proves the Mac's own
    // password once, as screen sharing would have asked for it.
    if !device.screen {
        let account = login::account().unwrap_or_default();
        refuse(&mut ws, json!({ "error": "the Mac's password is needed", "password": account })).await;
        return;
    }
    let width = hello.get("width").and_then(Value::as_u64).unwrap_or(1280).min(4096) as u32;
    let (tx, mut rx) = mpsc::channel::<Encoded>(QUEUE);
    // After a picture is dropped the ones that follow cannot be decoded; they are dropped
    // too, until the keyframe asked for arrives.
    let skipping = Arc::new(AtomicBool::new(false));
    let behind = Arc::new(AtomicBool::new(false));
    let sink = {
        let (skipping, behind) = (skipping.clone(), behind.clone());
        move |picture: Encoded| {
            if picture.key {
                skipping.store(false, Ordering::Release);
            } else if skipping.load(Ordering::Acquire) {
                return;
            }
            if let Err(mpsc::error::TrySendError::Full(_)) = tx.try_send(picture) {
                skipping.store(true, Ordering::Release);
                behind.store(true, Ordering::Release);
            }
        }
    };
    let Some(slot) = Slot::take() else {
        refuse(&mut ws, json!({ "error": "the screen is already shown on two devices", "video": false })).await;
        return;
    };
    let starting = tokio::task::spawn_blocking(move || Capture::start(width, BITRATE, sink));
    let capture = match tokio::time::timeout(START_WITHIN, starting).await {
        Err(_) => {
            refuse(&mut ws, json!({ "error": "the capture did not start in time", "video": false })).await;
            return;
        }
        Ok(Ok(Ok(capture))) => capture,
        Ok(Ok(Err(why))) => {
            refuse(&mut ws, json!({ "error": why, "video": false })).await;
            return;
        }
        Ok(Err(_)) => {
            refuse(&mut ws, json!({ "error": "the capture failed to start", "video": false })).await;
            return;
        }
    };
    // macOS offers to open the setting once per run; after that the page says what is missing.
    static ASKED: Once = Once::new();
    let mut ask = false;
    ASKED.call_once(|| ask = true);
    let control = input::allowed(ask);
    let g = capture.geometry;
    let ok = json!({ "ok": true, "build": super::build(), "video": { "width": g.width, "height": g.height }, "input": control });
    if say(&mut ws, ok).await.is_err() {
        return;
    }
    // The first picture is a keyframe already; it waits in the queue for this ok.
    app.store.audit(&device.id, "screen opened (video)");
    let mut input = Input::new(g);
    let mut check = tokio::time::interval(Duration::from_secs(15));
    check.reset();
    loop {
        tokio::select! {
            picture = rx.recv() => {
                let Some(picture) = picture else { break };
                let mut message = Vec::with_capacity(9 + picture.data.len());
                message.push(u8::from(picture.key));
                message.extend_from_slice(&picture.micros.to_be_bytes());
                message.extend_from_slice(&picture.data);
                if ws.send(Message::Binary(message.into())).await.is_err() {
                    break;
                }
                if behind.swap(false, Ordering::AcqRel) {
                    capture.keyframe();
                }
            }
            msg = ws.recv() => match msg {
                Some(Ok(Message::Text(text))) => {
                    let Ok(said) = serde_json::from_str::<Value>(&text) else { continue };
                    if let Some([x, y, mask]) = said.get("p").and_then(Value::as_array).map(Vec::as_slice) {
                        input.pointer(x.as_f64().unwrap_or(0.0), y.as_f64().unwrap_or(0.0), mask.as_u64().unwrap_or(0) as u8);
                    } else if let Some([sym, down]) = said.get("k").and_then(Value::as_array).map(Vec::as_slice) {
                        input.key(sym.as_u64().unwrap_or(0) as u32, down.as_bool().unwrap_or(false));
                    } else if said.get("key").is_some() {
                        capture.keyframe();
                    }
                }
                Some(Ok(Message::Close(_)) | Err(_)) | None => break,
                Some(Ok(_)) => {}
            },
            // A device unpaired while it watches stops watching.
            _ = check.tick() => {
                if app.store.device(&token).is_none() {
                    break;
                }
            }
        }
    }
    // Let go of anything still held, so the Mac is not left with a button or key down.
    input.release();
    // Stopping waits on macOS; it does so off the server's own threads.
    tokio::task::spawn_blocking(move || {
        drop(capture);
        drop(slot);
    });
    app.store.audit(&device.id, "screen closed");
}

/// Wrong passwords a device may try before it waits.
const TRIES: u32 = 5;
const WAIT: Duration = Duration::from_secs(300);
static FAILED: LazyLock<Mutex<HashMap<String, (u32, Instant)>>> = LazyLock::new(Default::default);

#[derive(Deserialize)]
pub(super) struct Proof {
    password: String,
}

/// `POST /api/screen/verify`: the Mac's password, checked by macOS, lets the sending device
/// use live video from now on. The password is not kept.
pub(super) async fn verify(State(app): State<Arc<App>>, headers: HeaderMap, Json(proof): Json<Proof>) -> Response {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    let Some(device) = token.and_then(|t| app.store.device(t)) else {
        return super::refuse(StatusCode::UNAUTHORIZED, "this device is not paired");
    };
    if proof.password.len() > 256 {
        return super::refuse(StatusCode::BAD_REQUEST, "too long");
    }
    {
        let failed = FAILED.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((count, at)) = failed.get(&device.id)
            && *count >= TRIES
            && at.elapsed() < WAIT
        {
            return super::refuse(StatusCode::TOO_MANY_REQUESTS, "too many wrong passwords; try again in a few minutes");
        }
    }
    let right = tokio::task::spawn_blocking(move || login::check(&proof.password)).await.unwrap_or(false);
    let mut failed = FAILED.lock().unwrap_or_else(|e| e.into_inner());
    if !right {
        let entry = failed.entry(device.id.clone()).or_insert((0, Instant::now()));
        if entry.1.elapsed() >= WAIT {
            *entry = (0, Instant::now());
        }
        entry.0 += 1;
        entry.1 = Instant::now();
        app.store.audit(&device.id, "screen password refused");
        return super::refuse(StatusCode::FORBIDDEN, "wrong password");
    }
    failed.remove(&device.id);
    drop(failed);
    if let Err(e) = app.store.allow_screen(&device.id) {
        return super::refuse(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());
    }
    app.store.audit(&device.id, "screen allowed by the Mac's password");
    Json(json!({ "ok": true })).into_response()
}
