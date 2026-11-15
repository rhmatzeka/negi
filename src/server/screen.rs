//! A way through to this machine's own screen sharing (VNC, port 5900). negi only carries
//! bytes; the screen sharing server decides what is shown and asks for its own login.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use super::App;

/// Where the machine's screen sharing listens: port 5900 on loopback, or the port named
/// in `NEGI_VNC_PORT`, which is how the tests point it at a stand-in.
fn vnc() -> SocketAddr {
    let port = std::env::var("NEGI_VNC_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(5900);
    SocketAddr::new(std::net::IpAddr::V4(Ipv4Addr::LOCALHOST), port)
}
const HELLO_TIMEOUT: Duration = Duration::from_secs(5);

/// The first message is `{"token": ..., "sealed"?: ...}`, as text. The answer is
/// `{"ok": true, "build": ..., "login": ...}` or `{"error": ...}`; after an ok, every binary
/// message is VNC, both ways. `login` is what `sealed` held, when it was sealed for this device.
pub(super) async fn bridge(app: Arc<App>, mut ws: WebSocket) {
    let hello = match tokio::time::timeout(HELLO_TIMEOUT, ws.recv()).await {
        Ok(Some(Ok(Message::Text(text)))) => serde_json::from_str::<Value>(&text).unwrap_or_default(),
        _ => Value::Null,
    };
    let token = hello.get("token").and_then(Value::as_str).map(str::to_owned);
    let Some(device) = token.as_deref().and_then(|t| app.store.device(t)) else {
        let _ = say(&mut ws, json!({ "error": "this device is not paired" })).await;
        return;
    };
    let vnc = match TcpStream::connect(vnc()).await {
        Ok(stream) => stream,
        Err(_) => {
            let _ = say(&mut ws, json!({ "error": "screen sharing is off" })).await;
            return;
        }
    };
    // A click or a key is a few bytes; held back to be sent with more, it is felt as lag.
    let _ = vnc.set_nodelay(true);
    app.store.audit(&device.id, "screen opened");
    // A login this device asked us to keep, opened again for it alone.
    let login = hello
        .get("sealed")
        .and_then(Value::as_str)
        .and_then(|sealed| app.store.unseal(&device.id, sealed))
        .and_then(|plain| serde_json::from_slice::<Value>(&plain).ok());
    if say(&mut ws, json!({ "ok": true, "build": super::build(), "login": login })).await.is_err() {
        return;
    }
    let (mut from_vnc, mut to_vnc) = vnc.into_split();
    let mut buffer = vec![0u8; 256 * 1024];
    let mut check = tokio::time::interval(Duration::from_secs(15));
    check.reset();
    loop {
        tokio::select! {
            read = from_vnc.read(&mut buffer) => match read {
                Ok(n) if n > 0 => {
                    if ws.send(Message::Binary(buffer[..n].to_vec().into())).await.is_err() {
                        break;
                    }
                }
                _ => break,
            },
            msg = ws.recv() => match msg {
                Some(Ok(Message::Binary(bytes))) => {
                    if to_vnc.write_all(&bytes).await.is_err() {
                        break;
                    }
                }
                Some(Ok(Message::Close(_)) | Err(_)) | None => break,
                Some(Ok(_)) => {}
            },
            // A device unpaired while it watches stops watching.
            _ = check.tick() => {
                if token.as_deref().and_then(|t| app.store.device(t)).is_none() {
                    break;
                }
            }
        }
    }
    app.store.audit(&device.id, "screen closed");
}

async fn say(ws: &mut WebSocket, value: Value) -> Result<(), axum::Error> {
    ws.send(Message::Text(value.to_string().into())).await
}

/// `POST /api/screen/seal`: seals a screen sharing login for the sending device, which keeps
/// it and offers it back on its next connection.
pub(super) async fn seal(State(app): State<Arc<App>>, headers: HeaderMap, Json(login): Json<Login>) -> Response {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    let Some(device) = token.and_then(|t| app.store.device(t)) else {
        return super::refuse(StatusCode::UNAUTHORIZED, "this device is not paired");
    };
    if login.password.len() > 256 || login.username.len() > 256 {
        return super::refuse(StatusCode::BAD_REQUEST, "too long");
    }
    let plain = serde_json::to_vec(&login).expect("a login serialises");
    match app.store.seal(&device.id, &plain) {
        Ok(sealed) => {
            app.store.audit(&device.id, "screen login kept");
            Json(json!({ "sealed": sealed })).into_response()
        }
        Err(e) => super::refuse(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

#[derive(Serialize, Deserialize)]
pub(super) struct Login {
    #[serde(default)]
    username: String,
    password: String,
}
