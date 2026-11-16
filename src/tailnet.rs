//! What Tailscale says about this machine, and putting negi on the tailnet with
//! `tailscale serve`, so nobody has to type those commands by hand.

use std::time::Duration;

use serde_json::Value;
use tokio::process::Command;

/// This machine on its tailnet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Me {
    /// `doloriz.trout-saury.ts.net`, without the trailing dot.
    pub name: String,
    /// The login that owns it, which is the one let in through the proxy.
    pub login: String,
}

/// A LaunchAgent's PATH misses `/usr/local/bin`, so the CLI is looked for where it installs.
const TAILSCALE_CLI: &[&str] = &[
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

fn tailscale_cli() -> std::ffi::OsString {
    TAILSCALE_CLI
        .iter()
        .find(|p| std::path::Path::new(p).exists())
        .map_or_else(|| "tailscale".into(), |p| (*p).into())
}

async fn tailscale(args: &[&str]) -> Result<String, String> {
    let run = Command::new(tailscale_cli()).args(args).output();
    let output = tokio::time::timeout(Duration::from_secs(20), run)
        .await
        .map_err(|_| "tailscale did not answer".to_owned())?
        .map_err(|_| "tailscale is not installed (no `tailscale` command)".to_owned())?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(if err.is_empty() { "tailscale failed".to_owned() } else { err });
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Who this machine is on the tailnet, or why that could not be read.
pub async fn me() -> Result<Me, String> {
    let status: Value = serde_json::from_str(&tailscale(&["status", "--json"]).await?).map_err(|e| e.to_string())?;
    parse_me(&status).ok_or_else(|| "Tailscale is not connected".to_owned())
}

fn parse_me(status: &Value) -> Option<Me> {
    if status["BackendState"].as_str() != Some("Running") {
        return None;
    }
    let me = &status["Self"];
    let name = me["DNSName"].as_str()?.trim_end_matches('.').to_owned();
    let user = me["UserID"].as_u64()?.to_string();
    let login = status["User"][&user]["LoginName"].as_str()?.to_owned();
    (!name.is_empty()).then_some(Me { name, login })
}

/// What `tailscale serve` is doing now.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Serving {
    /// `https://<name>` is proxied to this port.
    pub here: bool,
    /// Names other than this one that are still proxied to it: left behind by a rename.
    pub stale: Vec<String>,
    /// Anything served that is not negi's.
    pub others: bool,
    /// Where other rules on `https://<name>` (port 443) send traffic; sharing would replace them.
    pub taken_by: Vec<String>,
}

impl Serving {
    /// Port 443 goes somewhere still alive. A rule to a closed loopback port, left by a port
    /// change, may be replaced.
    pub async fn blocked(&self) -> bool {
        for target in &self.taken_by {
            let addr = target.strip_prefix("http://").unwrap_or(target);
            let alive = tokio::time::timeout(Duration::from_secs(2), tokio::net::TcpStream::connect(addr)).await;
            if !matches!(alive, Ok(Err(_))) || !addr.starts_with("127.0.0.1:") {
                return true;
            }
        }
        false
    }
}

pub async fn serving(me: &Me, port: u16) -> Result<Serving, String> {
    let config: Value = serde_json::from_str(&tailscale(&["serve", "status", "--json"]).await?).unwrap_or(Value::Null);
    Ok(parse_serving(&config, &me.name, port))
}

fn parse_serving(config: &Value, name: &str, port: u16) -> Serving {
    let ours = format!("http://127.0.0.1:{port}");
    let mut found = Serving::default();
    for (host, site) in config["Web"].as_object().into_iter().flatten() {
        let (host_name, host_port) = host.rsplit_once(':').unwrap_or((host.as_str(), "443"));
        for handler in site["Handlers"].as_object().into_iter().flatten().map(|(_, h)| h) {
            let proxy = handler["Proxy"].as_str().unwrap_or("");
            match (proxy == ours, host_name == name) {
                (true, true) => found.here = true,
                (true, false) => found.stale.push(host_name.to_owned()),
                (false, here) => {
                    found.others = true;
                    if here && host_port == "443" {
                        found.taken_by.push(proxy.to_owned());
                    }
                }
            }
        }
    }
    found.stale.sort();
    found.stale.dedup();
    found
}

/// Waits until this Mac is on another tailnet, or signed in or out, and puts negi on the new
/// one. A change must be read twice in a row, so one slow `tailscale status` drops no phone.
pub async fn follow(start: Option<Me>, port: u16) -> Option<Me> {
    let mut seen = None;
    loop {
        tokio::time::sleep(Duration::from_secs(15)).await;
        let now = me().await.ok();
        if now == start {
            seen = None;
            continue;
        }
        if seen.as_ref() != Some(&now) {
            seen = Some(now);
            continue;
        }
        if let Some(me) = &now
            && let Ok(s) = serving(me, port).await
            && !s.blocked().await
        {
            let _ = share(me, port).await;
        }
        return now;
    }
}

/// Serves `https://<name>` on the tailnet only, proxied to negi on this port. Rules that a
/// rename left behind are cleared first, but only when nothing else is being served.
pub async fn share(me: &Me, port: u16) -> Result<(), String> {
    let now = serving(me, port).await?;
    if !now.stale.is_empty() && !now.others {
        tailscale(&["serve", "reset"]).await?;
    }
    tailscale(&["serve", "--bg", &format!("http://127.0.0.1:{port}")]).await.map(drop)
}

/// Stops serving negi on the tailnet.
pub async fn unshare() -> Result<(), String> {
    tailscale(&["serve", "--https=443", "off"]).await.map(drop)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn me_is_the_name_without_its_dot_and_the_owners_login() {
        let status = json!({ "BackendState": "Running", "Self": { "DNSName": "doloriz.trout-saury.ts.net.", "UserID": 7 }, "User": { "7": { "LoginName": "me@github" } } });
        assert_eq!(parse_me(&status), Some(Me { name: "doloriz.trout-saury.ts.net".into(), login: "me@github".into() }));
        assert_eq!(parse_me(&json!({ "BackendState": "Stopped" })), None);
    }

    #[test]
    fn serving_tells_this_name_a_renamed_one_and_other_sites_apart() {
        let config = json!({ "Web": {
            "old.example.ts.net:443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:8792" } } },
            "new.example.ts.net:443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:8792" } } },
        } });
        assert_eq!(parse_serving(&config, "new.example.ts.net", 8792), Serving { here: true, stale: vec!["old.example.ts.net".into()], others: false, taken_by: vec![] });
        let other = json!({ "Web": { "new.example.ts.net:443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:3000" } } } } });
        assert_eq!(parse_serving(&other, "new.example.ts.net", 8792), Serving { here: false, stale: vec![], others: true, taken_by: vec!["http://127.0.0.1:3000".into()] });
        let side = json!({ "Web": { "new.example.ts.net:9444": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:8790" } } } } });
        assert_eq!(parse_serving(&side, "new.example.ts.net", 8792), Serving { here: false, stale: vec![], others: true, taken_by: vec![] });
        assert_eq!(parse_serving(&Value::Null, "new.example.ts.net", 8792), Serving::default());
    }

    #[test]
    fn the_cli_is_looked_up_at_its_install_paths() {
        let installed = TAILSCALE_CLI.iter().any(|p| std::path::Path::new(p).exists());
        assert_eq!(tailscale_cli() != "tailscale", installed);
    }

    #[tokio::test]
    async fn a_rule_to_a_closed_loopback_port_does_not_block() {
        let open = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let live = format!("http://{}", open.local_addr().unwrap());
        let closed = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            format!("http://{}", l.local_addr().unwrap())
        };
        let s = |t: &str| Serving { taken_by: vec![t.to_owned()], ..Default::default() };
        assert!(!s(&closed).blocked().await);
        assert!(s(&live).blocked().await);
        assert!(s("http://10.0.0.5:80").blocked().await);
    }
}
