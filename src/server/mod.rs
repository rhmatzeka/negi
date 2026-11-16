//! The HTTP and WebSocket front. Binds loopback only; a tailnet proxy is the way in.

mod fits;
mod guard;
mod mac;
mod screen;
mod socket;
mod upload;
#[cfg(target_os = "macos")]
mod video;

use std::hash::{DefaultHasher, Hash, Hasher};
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, LazyLock};

use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::serve::ListenerExt;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

pub use guard::admit;

use crate::hub::Hub;
use crate::store::{Origin, PairError, Store};
use crate::tmux::Tmux;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The largest message a socket may send.
const MAX_MESSAGE: usize = 256 * 1024;

#[derive(Debug, Clone, Default)]
pub struct Config {
    /// Names this server answers to besides loopback: the machine's tailnet name and
    /// addresses. Anything else is refused, which is what stops DNS rebinding.
    pub hosts: Vec<String>,
    /// The tailnet logins allowed in. With none, only loopback requests are served.
    pub trusted_users: Vec<String>,
}

pub struct App {
    pub hub: Hub,
    /// Windows phones have sized for themselves; see [`fits`].
    pub fits: fits::Fits,
    pub store: Store,
    pub tmux: Tmux,
    pub config: Config,
}

pub fn router(app: Arc<App>) -> Router {
    Router::new()
        .route(
            "/api/health",
            get(|| async { Json(json!({ "ok": true, "version": VERSION })) }),
        )
        .route("/api/pair", post(pair))
        .route(
            "/api/upload",
            post(upload::upload).layer(DefaultBodyLimit::max(upload::MAX_UPLOAD)),
        )
        .route("/api/ws", get(upgrade))
        .route("/api/screen", get(screen))
        .route("/api/screen/seal", post(screen::seal))
        .route("/api/screen/verify", post(verify_screen))
        .route("/api/mac", get(mac::status))
        .route("/api/speed/down", get(mac::down))
        .route(
            "/api/speed/up",
            post(mac::up).layer(DefaultBodyLimit::max(mac::MAX_SPEED_BYTES)),
        )
        .route("/api/speed/internet", post(mac::internet))
        .fallback(interface)
        .layer(middleware::from_fn_with_state(app.clone(), guard))
        .with_state(app)
}

pub async fn serve(app: Arc<App>, port: u16) -> std::io::Result<()> {
    let listener =
        tokio::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).await?;
    eprintln!("negi listening on http://{}", listener.local_addr()?);
    // A click, a key or a picture is sent at once, not held back to be sent with the next.
    let listener = listener.tap_io(|tcp| {
        let _ = tcp.set_nodelay(true);
    });
    axum::serve(listener, router(app)).await
}

/// The built interface (`web/dist`), compiled into the binary.
#[derive(rust_embed::RustEmbed)]
#[folder = "web/dist"]
struct Interface;

/// Names the interface this binary carries: a hash of its page. A page that is told a
/// different name than the one it was loaded with is an old one, and reloads itself.
pub fn build() -> &'static str {
    static BUILD: LazyLock<String> = LazyLock::new(|| {
        let mut hasher = DefaultHasher::new();
        if let Some(page) = Interface::get("index.html") {
            page.data.hash(&mut hasher);
        }
        format!("{:016x}", hasher.finish())
    });
    &BUILD
}

/// Serves the interface. It is a single-page app, so any path that is not a file of its
/// own gets the page, and the page's router takes it from there.
async fn interface(uri: axum::http::Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    if path.starts_with("api/") {
        return refuse(StatusCode::NOT_FOUND, "no such endpoint");
    }
    let (name, file) = match Interface::get(path) {
        Some(file) if !path.is_empty() => (path, file),
        _ => match Interface::get("index.html") {
            Some(file) => ("index.html", file),
            None => return refuse(StatusCode::NOT_FOUND, "the interface is not built"),
        },
    };
    // The page carries the name of its build, so it can tell when the server has a newer one
    // whichever socket it hears that from first.
    let body = if name == "index.html" {
        String::from_utf8_lossy(&file.data)
            .replacen("<head>", &format!("<head><meta name=\"negi-build\" content=\"{}\">", build()), 1)
            .into_bytes()
    } else {
        file.data.into_owned()
    };
    // Files under assets/ carry a hash of their content in their name, so they never
    // change; everything else is revalidated so a new build shows up at once.
    let cache = if name.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    (
        [
            (header::CONTENT_TYPE, file.metadata.mimetype()),
            (header::CACHE_CONTROL, cache),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::REFERRER_POLICY, "no-referrer"),
            // Scripts come from this server only. Styles may be inline: the animation and
            // drawer libraries set them on elements as they move.
            (
                header::CONTENT_SECURITY_POLICY,
                "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; \
                 frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
            ),
        ],
        body,
    )
        .into_response()
}

pub(super) fn refuse(status: StatusCode, why: &str) -> Response {
    (status, Json(json!({ "error": why }))).into_response()
}

/// Every request passes here before any handler.
async fn guard(State(app): State<Arc<App>>, request: Request, next: Next) -> Response {
    let writes = request.method() != Method::GET || request.headers().contains_key(header::UPGRADE);
    match admit(request.headers(), &app.config, writes) {
        Ok(()) => next.run(request).await,
        Err(why) => refuse(StatusCode::FORBIDDEN, why),
    }
}

async fn screen(State(app): State<Arc<App>>, ws: WebSocketUpgrade) -> Response {
    ws.max_message_size(MAX_MESSAGE)
        .on_upgrade(move |socket| screen::bridge(app, socket))
}

#[derive(Deserialize)]
struct PairRequest {
    code: String,
    label: String,
}

async fn pair(State(app): State<Arc<App>>, headers: HeaderMap, Json(body): Json<PairRequest>) -> Response {
    let value = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    // The guard has already required this header on anything that came through the proxy.
    let origin = Origin {
        via: value("tailscale-user-login").unwrap_or("this computer").to_owned(),
        agent: browser(value("user-agent").unwrap_or("")),
    };
    match app.store.redeem_from(&body.code, &body.label, &origin) {
        Ok(token) => Json(json!({ "token": token, "label": body.label.trim() })).into_response(),
        Err(PairError::Refused) => refuse(StatusCode::FORBIDDEN, "that code is not valid"),
        Err(PairError::BadLabel) => refuse(
            StatusCode::BAD_REQUEST,
            "a device name has 1 to 40 characters",
        ),
        Err(PairError::Full) => refuse(
            StatusCode::CONFLICT,
            "too many devices are paired; revoke one first",
        ),
        Err(PairError::Io(e)) => refuse(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

/// A browser's user agent, shortened to what a person would call it: "Safari on iPhone".
fn browser(agent: &str) -> String {
    let device = [("iPhone", "iPhone"), ("iPad", "iPad"), ("Android", "Android"), ("Macintosh", "Mac"), ("Windows", "Windows"), ("Linux", "Linux")]
        .iter()
        .find(|(needle, _)| agent.contains(needle))
        .map(|(_, name)| *name);
    // Order matters: Chrome's agent names Safari too, Edge's names Chrome.
    let app = [("Edg/", "Edge"), ("CriOS", "Chrome"), ("FxiOS", "Firefox"), ("Firefox/", "Firefox"), ("Chrome/", "Chrome"), ("Safari/", "Safari")]
        .iter()
        .find(|(needle, _)| agent.contains(needle))
        .map(|(_, name)| *name);
    match (app, device) {
        (Some(app), Some(device)) => format!("{app} on {device}"),
        (Some(name), None) | (None, Some(name)) => name.to_owned(),
        (None, None) => String::new(),
    }
}

async fn upgrade(State(app): State<Arc<App>>, ws: WebSocketUpgrade) -> Response {
    ws.max_message_size(MAX_MESSAGE)
        .on_upgrade(move |socket| socket::session(app, socket))
}

#[cfg(target_os = "macos")]
use video::verify as verify_screen;

#[cfg(not(target_os = "macos"))]
async fn verify_screen() -> Response {
    refuse(StatusCode::NOT_FOUND, "live video is only on macOS")
}

#[cfg(test)]
mod tests {
    use super::browser;

    #[test]
    fn a_user_agent_reads_as_a_person_would_say_it() {
        let iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 27_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Mobile/15E148 Safari/604.1";
        let chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
        assert_eq!(browser(iphone), "Safari on iPhone");
        assert_eq!(browser(chrome), "Chrome on Mac");
        assert_eq!(browser("curl/8.9"), "");
    }
}
