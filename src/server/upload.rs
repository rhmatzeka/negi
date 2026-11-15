//! Files a paired device sends from the phone, kept on this machine so that a program in a
//! pane can be given their path.

use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use super::{App, refuse};

/// The largest file taken. A photo from a phone is a few megabytes.
pub const MAX_UPLOAD: usize = 32 * 1024 * 1024;

/// A name safe to put on disk and to type into a shell: letters, digits, dot, dash and
/// underscore, with everything else turned into a dash, and never starting with a dot.
pub fn safe_name(given: &str) -> String {
    let base = given.rsplit(['/', '\\']).next().unwrap_or("");
    let mut name: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '-'
            }
        })
        .take(80)
        .collect();
    name = name.trim_start_matches('.').to_owned();
    if name.is_empty() { "file".into() } else { name }
}

/// `POST /api/upload`: the body is the file, `x-name` its name, `authorization` the
/// device's token. Answers with the path it was saved at.
pub async fn upload(State(app): State<Arc<App>>, headers: HeaderMap, body: Bytes) -> Response {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    let Some(device) = token.and_then(|t| app.store.device(t)) else {
        return refuse(StatusCode::UNAUTHORIZED, "this device is not paired");
    };
    if body.is_empty() {
        return refuse(StatusCode::BAD_REQUEST, "the file is empty");
    }
    let name = safe_name(
        headers
            .get("x-name")
            .and_then(|v| v.to_str().ok())
            .unwrap_or(""),
    );
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dir: PathBuf = app.store.dir().join("uploads");
    let path = dir.join(format!("{stamp}-{name}"));
    let saved = std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&dir)
        .and_then(|()| {
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&path)
        })
        .and_then(|mut file| std::io::Write::write_all(&mut file, &body));
    match saved {
        Ok(()) => {
            app.store.audit(
                &device.id,
                &format!("upload {} bytes={}", path.display(), body.len()),
            );
            Json(json!({ "path": path })).into_response()
        }
        Err(e) => refuse(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::safe_name;

    #[test]
    fn names_are_made_safe_for_a_disk_and_a_shell() {
        assert_eq!(safe_name("IMG_1750.PNG"), "IMG_1750.PNG");
        assert_eq!(safe_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_name("my photo (1).jpg"), "my-photo--1-.jpg");
        assert_eq!(safe_name(".bashrc"), "bashrc");
        assert_eq!(safe_name("a;rm -rf $HOME`x`.png"), "a-rm--rf--HOME-x-.png");
        assert_eq!(safe_name(""), "file");
        assert_eq!(safe_name("..."), "file");
    }
}
