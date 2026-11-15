//! The server over real sockets: who gets in, and a phone's whole conversation.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::Scratch;
use futures_util::{SinkExt, StreamExt};
use negi::hub::{Hub, Timing};
use negi::server::{self, App, Config};
use negi::store::Store;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>;

struct Running {
    app: Arc<App>,
    port: u16,
    state: std::path::PathBuf,
}

impl Drop for Running {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.state);
    }
}

async fn start(s: &Scratch) -> Running {
    let state = std::env::temp_dir().join(format!("negi-server-{}-{}", std::process::id(), rand()));
    let config = Config {
        hosts: vec!["mac.example.ts.net".into()],
        trusted_user: Some("me@example.com".into()),
    };
    let app = Arc::new(App {
        hub: Hub::start(
            s.tmux.clone(),
            Timing {
                grace: Duration::from_millis(150),
            },
        ),
        store: Store::open(&state).unwrap(),
        tmux: s.tmux.clone(),
        config,
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let router = server::router(app.clone());
    tokio::spawn(async move { axum::serve(listener, router).await });
    Running { app, port, state }
}

fn rand() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    std::collections::hash_map::RandomState::new()
        .build_hasher()
        .finish()
}

/// One HTTP request by hand, so every header is exactly what the test says.
async fn http(
    port: u16,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &str,
) -> (u16, String) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let mut request = format!(
        "{method} {path} HTTP/1.1\r\nConnection: close\r\nContent-Length: {}\r\n",
        body.len()
    );
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str("\r\n");
    request.push_str(body);
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).await.unwrap();
    let status = response.split_whitespace().nth(1).unwrap().parse().unwrap();
    let body = response
        .split_once("\r\n\r\n")
        .map(|(_, b)| b.to_owned())
        .unwrap_or_default();
    (status, body)
}

async fn pair(run: &Running) -> String {
    let code = run.app.store.start_pairing().unwrap();
    let local = format!("127.0.0.1:{}", run.port);
    let body = json!({ "code": code, "label": "test phone" }).to_string();
    let (status, text) = http(
        run.port,
        "POST",
        "/api/pair",
        &[("Host", &local), ("Content-Type", "application/json")],
        &body,
    )
    .await;
    assert_eq!(status, 200, "{text}");
    serde_json::from_str::<Value>(&text).unwrap()["token"]
        .as_str()
        .unwrap()
        .to_owned()
}

async fn connect(run: &Running, headers: &[(&str, &str)]) -> Result<Phone, WsError> {
    let mut request = format!("ws://127.0.0.1:{}/api/ws", run.port)
        .into_client_request()
        .unwrap();
    for (name, value) in headers {
        request.headers_mut().insert(
            axum::http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
            axum::http::HeaderValue::from_str(value).unwrap(),
        );
    }
    tokio_tungstenite::connect_async(request)
        .await
        .map(|(socket, _)| Phone {
            socket,
            seen: Vec::new(),
        })
}

async fn say(socket: &mut Phone, value: Value) {
    socket
        .socket
        .send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}

/// A socket plus the messages already read past, so a test can ask for an ack and a
/// screen update in either order: which arrives first is a race the protocol allows.
struct Phone {
    socket: Socket,
    seen: Vec<Value>,
}

async fn next(phone: &mut Phone, t: &str, pick: impl Fn(&Value) -> bool) -> Value {
    if let Some(i) = phone.seen.iter().position(|m| m["t"] == t && pick(m)) {
        return phone.seen.remove(i);
    }
    let found = async {
        loop {
            let Some(Ok(Message::Text(text))) = phone.socket.next().await else {
                continue;
            };
            let msg: Value = serde_json::from_str(&text).unwrap();
            if msg["t"] == t && pick(&msg) {
                return msg;
            }
            phone.seen.push(msg);
        }
    };
    tokio::time::timeout(Duration::from_secs(8), found)
        .await
        .unwrap_or_else(|_| panic!("no {t} message"))
}

#[tokio::test]
async fn only_known_hosts_and_the_trusted_user_get_an_answer() {
    let s = Scratch::new();
    let run = start(&s).await;
    let local = format!("127.0.0.1:{}", run.port);
    let me = ("Tailscale-User-Login", "me@example.com");

    assert_eq!(
        http(run.port, "GET", "/api/health", &[("Host", &local)], "")
            .await
            .0,
        200
    );
    assert_eq!(
        http(run.port, "GET", "/", &[("Host", &local)], "").await.0,
        200
    );
    assert_eq!(
        http(
            run.port,
            "GET",
            "/api/health",
            &[("Host", "mac.example.ts.net"), me],
            ""
        )
        .await
        .0,
        200
    );

    assert_eq!(
        http(
            run.port,
            "GET",
            "/api/health",
            &[("Host", "evil.example")],
            ""
        )
        .await
        .0,
        403
    );
    assert_eq!(
        http(run.port, "GET", "/", &[("Host", "evil.example"), me], "")
            .await
            .0,
        403
    );
    assert_eq!(
        http(
            run.port,
            "GET",
            "/api/health",
            &[("Host", "mac.example.ts.net")],
            ""
        )
        .await
        .0,
        403
    );
    let guest = ("Tailscale-User-Login", "guest@example.com");
    assert_eq!(
        http(
            run.port,
            "GET",
            "/api/health",
            &[("Host", "mac.example.ts.net"), guest],
            ""
        )
        .await
        .0,
        403
    );
    let posing = [("Host", local.as_str()), ("X-Forwarded-For", "100.64.0.9")];
    assert_eq!(
        http(run.port, "GET", "/api/health", &posing, "").await.0,
        403
    );
}

#[tokio::test]
async fn pairing_takes_the_code_once_and_refuses_other_sites() {
    let s = Scratch::new();
    let run = start(&s).await;
    let local = format!("127.0.0.1:{}", run.port);
    let json_type = ("Content-Type", "application/json");
    let code = run.app.store.start_pairing().unwrap();
    let body = json!({ "code": code, "label": "phone" }).to_string();

    let cross = [
        ("Host", local.as_str()),
        json_type,
        ("Origin", "https://evil.example"),
    ];
    assert_eq!(
        http(run.port, "POST", "/api/pair", &cross, &body).await.0,
        403
    );
    let wrong = json!({ "code": "AAAAAAAA", "label": "phone" }).to_string();
    assert_eq!(
        http(
            run.port,
            "POST",
            "/api/pair",
            &[("Host", &local), json_type],
            &wrong
        )
        .await
        .0,
        403
    );

    let own = format!("http://{local}");
    let same = [
        ("Host", local.as_str()),
        json_type,
        ("Origin", own.as_str()),
    ];
    let (status, text) = http(run.port, "POST", "/api/pair", &same, &body).await;
    assert_eq!(status, 200, "{text}");
    assert_eq!(
        http(run.port, "POST", "/api/pair", &same, &body).await.0,
        403,
        "the code is spent"
    );
    assert_eq!(run.app.store.devices().len(), 1);
}

#[tokio::test]
async fn a_socket_must_say_who_it_is() {
    let s = Scratch::new();
    s.session("a", "cat");
    let run = start(&s).await;
    let token = pair(&run).await;

    let mut stranger = connect(&run, &[]).await.unwrap();
    say(
        &mut stranger,
        json!({ "t": "hello", "token": "0".repeat(64) }),
    )
    .await;
    assert_eq!(
        next(&mut stranger, "bye", |_| true).await["reason"],
        "unpaired"
    );

    let mut skipping = connect(&run, &[]).await.unwrap();
    say(
        &mut skipping,
        json!({ "t": "watch", "pane": "%0", "open": true }),
    )
    .await;
    next(&mut skipping, "bye", |_| true).await;

    let cross = connect(&run, &[("Origin", "https://evil.example")]).await;
    assert!(
        matches!(cross, Err(WsError::Http(r)) if r.status() == 403),
        "a page elsewhere cannot open the socket"
    );

    let mut phone = connect(&run, &[]).await.unwrap();
    say(&mut phone, json!({ "t": "hello", "token": token })).await;
    assert_eq!(
        next(&mut phone, "ready", |_| true).await["device"],
        "test phone"
    );
    assert_eq!(
        next(&mut phone, "tree", |_| true).await["sessions"][0]["name"],
        "a"
    );
}

#[tokio::test]
async fn a_phone_reads_types_and_manages_through_one_socket() {
    let s = Scratch::new();
    let pane = s.session("a", "cat");
    let run = start(&s).await;
    let token = pair(&run).await;
    let mut phone = connect(&run, &[]).await.unwrap();
    say(&mut phone, json!({ "t": "hello", "token": token })).await;
    let tree = next(&mut phone, "tree", |_| true).await;
    let session = tree["sessions"][0]["id"].as_str().unwrap().to_owned();

    say(
        &mut phone,
        json!({ "t": "watch", "pane": pane, "open": true }),
    )
    .await;
    next(&mut phone, "screen", |m| m["pane"] == pane.as_str()).await;

    say(
        &mut phone,
        json!({ "t": "text", "id": 1, "pane": pane, "text": "typed on a phone", "enter": true }),
    )
    .await;
    next(&mut phone, "rows", |m| {
        m["set"].to_string().contains("typed on a phone")
    })
    .await;
    assert_eq!(next(&mut phone, "ack", |m| m["id"] == 1).await["ok"], true);

    say(
        &mut phone,
        json!({ "t": "keys", "id": 2, "pane": pane, "keys": ["x", "Enter"] }),
    )
    .await;
    assert_eq!(next(&mut phone, "ack", |m| m["id"] == 2).await["ok"], true);
    say(
        &mut phone,
        json!({ "t": "keys", "id": 3, "pane": pane, "keys": ["Enter; kill-server"] }),
    )
    .await;
    let refused = next(&mut phone, "ack", |m| m["id"] == 3).await;
    assert_eq!(
        (refused["ok"].clone(), refused["error"].clone()),
        (json!(false), json!("not a key name"))
    );
    say(
        &mut phone,
        json!({ "t": "keys", "id": 4, "pane": "a:0.0", "keys": ["x"] }),
    )
    .await;
    assert_eq!(next(&mut phone, "ack", |m| m["id"] == 4).await["ok"], false);

    say(
        &mut phone,
        json!({ "t": "history", "id": 5, "pane": pane, "lines": 100 }),
    )
    .await;
    assert!(next(&mut phone, "ack", |m| m["id"] == 5).await["lines"].is_array());

    say(&mut phone, json!({ "t": "new-window", "id": 6, "session": session, "name": "made #{here}", "cwd": "/tmp" })).await;
    let made = next(&mut phone, "ack", |m| m["id"] == 6).await;
    assert_eq!(made["ok"], true, "{made}");
    let tree = next(&mut phone, "tree", |m| {
        m["sessions"][0]["windows"].as_array().unwrap().len() == 2
    })
    .await;
    assert_eq!(tree["sessions"][0]["windows"][1]["name"], "made #{here}");
    say(
        &mut phone,
        json!({ "t": "new-window", "id": 7, "session": session, "cwd": "/no/such/folder" }),
    )
    .await;
    assert_eq!(
        next(&mut phone, "ack", |m| m["id"] == 7).await["error"],
        "that folder does not exist"
    );

    say(
        &mut phone,
        json!({ "t": "kill-pane", "id": 8, "pane": pane }),
    )
    .await;
    assert_eq!(
        next(&mut phone, "gone", |_| true).await["pane"],
        pane.as_str()
    );

    let audit = std::fs::read_to_string(run.state.join("audit.log")).unwrap();
    assert!(audit.contains("text %0 bytes=16 enter=true"), "{audit}");
    assert!(
        !audit.contains("typed on a phone"),
        "the audit file never holds the text"
    );
}

#[tokio::test]
async fn a_session_can_be_started_when_tmux_is_not_running() {
    let s = Scratch::new();
    let run = start(&s).await;
    let token = pair(&run).await;
    let mut phone = connect(&run, &[]).await.unwrap();
    say(&mut phone, json!({ "t": "hello", "token": token })).await;
    assert_eq!(next(&mut phone, "tree", |_| true).await["server"], false);

    say(
        &mut phone,
        json!({ "t": "new-session", "id": 1, "name": "first", "cwd": "/tmp" }),
    )
    .await;
    let made = next(&mut phone, "ack", |m| m["id"] == 1).await;
    assert_eq!(made["ok"], true, "{made}");
    let tree = next(&mut phone, "tree", |m| m["server"] == true).await;
    assert_eq!(tree["sessions"][0]["name"], "first");
    assert_eq!(
        tree["sessions"][0]["windows"][0]["panes"][0]["id"],
        made["pane"]
    );
}

#[tokio::test]
async fn a_paired_device_can_send_a_file_and_gets_its_path() {
    let s = Scratch::new();
    let run = start(&s).await;
    let local = format!("127.0.0.1:{}", run.port);
    let token = pair(&run).await;
    let bearer = format!("Bearer {token}");

    let anonymous = [("Host", local.as_str()), ("X-Name", "a.txt")];
    assert_eq!(
        http(run.port, "POST", "/api/upload", &anonymous, "hello")
            .await
            .0,
        401
    );
    let stranger = [
        ("Host", local.as_str()),
        ("Authorization", "Bearer nope"),
        ("X-Name", "a.txt"),
    ];
    assert_eq!(
        http(run.port, "POST", "/api/upload", &stranger, "hello")
            .await
            .0,
        401
    );
    let cross = [
        ("Host", local.as_str()),
        ("Authorization", bearer.as_str()),
        ("Origin", "https://evil.example"),
    ];
    assert_eq!(
        http(run.port, "POST", "/api/upload", &cross, "hello")
            .await
            .0,
        403
    );
    let empty = [("Host", local.as_str()), ("Authorization", bearer.as_str())];
    assert_eq!(
        http(run.port, "POST", "/api/upload", &empty, "").await.0,
        400
    );

    // A name that tries to leave the folder, and to break out of a shell word.
    let owner = [
        ("Host", local.as_str()),
        ("Authorization", bearer.as_str()),
        ("X-Name", "../../evil $(id).png"),
    ];
    let (status, text) = http(run.port, "POST", "/api/upload", &owner, "hello").await;
    assert_eq!(status, 200, "{text}");
    let path = serde_json::from_str::<Value>(&text).unwrap()["path"]
        .as_str()
        .unwrap()
        .to_owned();
    let uploads = run.app.store.dir().join("uploads");
    assert!(std::path::Path::new(&path).starts_with(&uploads), "{path}");
    assert!(path.ends_with("-evil---id-.png"), "{path}");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "hello");
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

#[tokio::test]
async fn a_screen_login_is_kept_sealed_for_the_device_that_sent_it() {
    let s = Scratch::new();
    let run = start(&s).await;
    let local = format!("127.0.0.1:{}", run.port);
    let token = pair(&run).await;
    let bearer = format!("Bearer {token}");
    let login = json!({ "username": "me", "password": "hunter2" }).to_string();

    let anonymous = [("Host", local.as_str()), ("Content-Type", "application/json")];
    assert_eq!(http(run.port, "POST", "/api/screen/seal", &anonymous, &login).await.0, 401);

    let owner = [("Host", local.as_str()), ("Authorization", bearer.as_str()), ("Content-Type", "application/json")];
    let (status, text) = http(run.port, "POST", "/api/screen/seal", &owner, &login).await;
    assert_eq!(status, 200, "{text}");
    let sealed = serde_json::from_str::<Value>(&text).unwrap()["sealed"].as_str().unwrap().to_owned();
    assert!(!sealed.contains("hunter2"));

    let device = run.app.store.devices()[0].id.clone();
    let opened: Value = serde_json::from_slice(&run.app.store.unseal(&device, &sealed).unwrap()).unwrap();
    assert_eq!(opened, json!({ "username": "me", "password": "hunter2" }));
    let other = pair(&run).await;
    let other = run.app.store.device(&other).unwrap().id;
    assert_eq!(run.app.store.unseal(&other, &sealed), None);
}
