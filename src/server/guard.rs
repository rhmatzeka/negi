//! Who may talk to the server. Every request is checked here before any handler runs.

use axum::http::header::HeaderMap;

use super::Config;

/// Who may talk to this server:
///
/// - Only requests addressed to loopback or to a configured name.
/// - A request that came through a proxy must carry the trusted tailnet login. The proxy
///   sets that header itself and strips whatever a client sent.
/// - A write, or a WebSocket, from a browser must come from this server's own pages.
pub fn admit(headers: &HeaderMap, config: &Config, writes: bool) -> Result<(), &'static str> {
    let value = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    let host = value("host").ok_or("no host")?.to_ascii_lowercase();
    let name = host_name(&host);
    let loopback = matches!(name, "127.0.0.1" | "localhost" | "[::1]");
    if !loopback && !config.hosts.iter().any(|h| h.eq_ignore_ascii_case(name)) {
        return Err("host not allowed");
    }
    let proxied = !loopback
        || headers.keys().any(|k| {
            let k = k.as_str();
            k.starts_with("tailscale-") || k.starts_with("x-forwarded-")
        });
    if proxied {
        let login = value("tailscale-user-login").ok_or("not a tailnet user")?;
        match &config.trusted_user {
            Some(trusted) if trusted.eq_ignore_ascii_case(login) => {}
            _ => return Err("not the trusted user"),
        }
    }
    if writes {
        match value("origin") {
            Some(origin) => {
                let from = origin
                    .split_once("://")
                    .map(|(_, rest)| rest)
                    .unwrap_or(origin);
                if !from.eq_ignore_ascii_case(&host) {
                    return Err("cross-origin");
                }
            }
            // Only a local tool leaves Origin out; a browser never does on a write.
            None if proxied => return Err("no origin"),
            None => {}
        }
    }
    Ok(())
}

fn host_name(host: &str) -> &str {
    if host.starts_with('[') {
        return host.split_inclusive(']').next().unwrap_or(host);
    }
    host.rsplit_once(':').map(|(name, _)| name).unwrap_or(host)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(*name, HeaderValue::from_str(value).unwrap());
        }
        map
    }

    fn config() -> Config {
        Config {
            hosts: vec!["mac.example.ts.net".into(), "100.64.0.7".into()],
            trusted_user: Some("me@example.com".into()),
        }
    }

    const TAILNET: (&str, &str) = ("host", "mac.example.ts.net:9555");
    const ME: (&str, &str) = ("tailscale-user-login", "me@example.com");

    #[test]
    fn the_owner_gets_in_through_the_tailnet() {
        assert_eq!(admit(&headers(&[TAILNET, ME]), &config(), false), Ok(()));
        let write = [TAILNET, ME, ("origin", "https://mac.example.ts.net:9555")];
        assert_eq!(admit(&headers(&write), &config(), true), Ok(()));
        assert_eq!(
            admit(
                &headers(&[("host", "100.64.0.7:9555"), ME]),
                &config(),
                false
            ),
            Ok(())
        );
    }

    #[test]
    fn other_hosts_are_refused() {
        for host in [
            "evil.example",
            "mac.example.ts.net.evil.example",
            "10.0.0.5:9555",
            "",
        ] {
            assert_eq!(
                admit(&headers(&[("host", host), ME]), &config(), false),
                Err("host not allowed"),
                "{host}"
            );
        }
        assert_eq!(admit(&headers(&[ME]), &config(), false), Err("no host"));
    }

    #[test]
    fn a_tailnet_request_needs_the_trusted_login() {
        assert_eq!(
            admit(&headers(&[TAILNET]), &config(), false),
            Err("not a tailnet user")
        );
        let other = [TAILNET, ("tailscale-user-login", "guest@example.com")];
        assert_eq!(
            admit(&headers(&other), &config(), false),
            Err("not the trusted user")
        );
        let open = Config {
            trusted_user: None,
            ..config()
        };
        assert_eq!(
            admit(&headers(&[TAILNET, ME]), &open, false),
            Err("not the trusted user")
        );
    }

    #[test]
    fn a_proxied_request_cannot_pose_as_local() {
        let posing = [
            ("host", "localhost:3939"),
            ("x-forwarded-for", "100.64.0.9"),
        ];
        assert_eq!(
            admit(&headers(&posing), &config(), false),
            Err("not a tailnet user")
        );
        let guest = [
            ("host", "127.0.0.1:3939"),
            ("tailscale-user-login", "guest@example.com"),
        ];
        assert_eq!(
            admit(&headers(&guest), &config(), false),
            Err("not the trusted user")
        );
    }

    #[test]
    fn local_tools_need_no_login_and_no_origin() {
        for host in [
            "127.0.0.1:3939",
            "localhost:3939",
            "[::1]:3939",
            "localhost",
        ] {
            assert_eq!(
                admit(&headers(&[("host", host)]), &config(), true),
                Ok(()),
                "{host}"
            );
        }
        let open = Config::default();
        assert_eq!(
            admit(&headers(&[("host", "127.0.0.1:3939")]), &open, true),
            Ok(())
        );
    }

    #[test]
    fn writes_from_another_site_are_refused() {
        let cross = [TAILNET, ME, ("origin", "https://evil.example")];
        assert_eq!(
            admit(&headers(&cross), &config(), true),
            Err("cross-origin")
        );
        assert_eq!(
            admit(&headers(&cross), &config(), false),
            Ok(()),
            "a read carries no risk here"
        );
        assert_eq!(
            admit(&headers(&[TAILNET, ME]), &config(), true),
            Err("no origin")
        );
        let local_cross = [
            ("host", "127.0.0.1:3939"),
            ("origin", "https://evil.example"),
        ];
        assert_eq!(
            admit(&headers(&local_cross), &config(), true),
            Err("cross-origin")
        );
        let local_same = [
            ("host", "127.0.0.1:3939"),
            ("origin", "http://127.0.0.1:3939"),
        ];
        assert_eq!(admit(&headers(&local_same), &config(), true), Ok(()));
    }

    #[test]
    fn host_names_lose_their_port() {
        assert_eq!(host_name("a.b:1"), "a.b");
        assert_eq!(host_name("a.b"), "a.b");
        assert_eq!(host_name("[::1]:3939"), "[::1]");
        assert_eq!(host_name("[::1]"), "[::1]");
    }
}
