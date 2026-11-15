//! The computer's own state for the page: its battery and Wi-Fi, and two speed tests, the
//! link between the phone and this server, and the computer's own internet.

use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::process::Command;
use tokio::sync::Mutex;

use super::{App, refuse};

/// Largest test transfer either way.
pub const MAX_SPEED_BYTES: usize = 32 * 1024 * 1024;
const STATUS_FOR: Duration = Duration::from_secs(10);
const INTERNET_FOR: Duration = Duration::from_secs(60);

fn paired(app: &App, headers: &HeaderMap) -> bool {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .and_then(|t| app.store.device(t))
        .is_some()
}

/// `GET /api/mac`: battery and Wi-Fi. Reading Wi-Fi takes the system over a second, so an
/// answer is kept for a few seconds and shared.
pub(super) async fn status(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    static LAST: LazyLock<Mutex<Option<(Instant, Value)>>> = LazyLock::new(|| Mutex::new(None));
    if !paired(&app, &headers) {
        return refuse(StatusCode::UNAUTHORIZED, "this device is not paired");
    }
    let mut last = LAST.lock().await;
    if let Some((at, value)) = last.as_ref()
        && at.elapsed() < STATUS_FOR
    {
        return Json(value.clone()).into_response();
    }
    let (battery, wifi) = tokio::join!(battery(), wifi());
    let value = json!({ "battery": battery, "wifi": wifi });
    *last = Some((Instant::now(), value.clone()));
    Json(value).into_response()
}

async fn run(program: &str, args: &[&str]) -> Option<String> {
    let output = tokio::time::timeout(Duration::from_secs(8), Command::new(program).args(args).output())
        .await
        .ok()?
        .ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

async fn battery() -> Value {
    let Some(text) = run("pmset", &["-g", "batt"]).await else {
        return Value::Null;
    };
    parse_battery(&text)
}

/// `pmset -g batt`: "Now drawing from 'AC Power'" then "-InternalBattery-0 (id=…)\t100%; finishing charge; 0:00 remaining present: true".
fn parse_battery(text: &str) -> Value {
    let on_power = text.contains("'AC Power'");
    let Some(line) = text.lines().find(|l| l.contains("InternalBattery")) else {
        // A desktop Mac: no battery, always on power.
        return Value::Null;
    };
    let after_tab = line.split('\t').nth(1).unwrap_or(line);
    let mut parts = after_tab.split(';').map(str::trim);
    let percent = parts.next().and_then(|p| p.trim_end_matches('%').parse::<u8>().ok());
    let state = parts.next().unwrap_or("");
    let remaining = parts
        .next()
        .and_then(|r| r.split_whitespace().next())
        .and_then(|t| t.split_once(':'))
        .and_then(|(h, m)| Some(h.parse::<u32>().ok()? * 60 + m.parse::<u32>().ok()?))
        .filter(|&m| m > 0);
    json!({
        "percent": percent,
        "charging": state == "charging",
        "full": state == "charged" || state == "finishing charge",
        "onPower": on_power,
        "minutesLeft": remaining,
    })
}

async fn wifi() -> Value {
    let Some(text) = run("system_profiler", &["SPAirPortDataType", "-json"]).await else {
        return Value::Null;
    };
    parse_wifi(&text)
}

/// The current network from `system_profiler SPAirPortDataType -json`. The network's name
/// is withheld by macOS from programs without Location access, so it is not reported.
fn parse_wifi(text: &str) -> Value {
    let data: Value = serde_json::from_str(text).unwrap_or(Value::Null);
    let current = data["SPAirPortDataType"][0]["spairport_airport_interfaces"]
        .as_array()
        .into_iter()
        .flatten()
        .find_map(|i| i.get("spairport_current_network_information"));
    let Some(current) = current else {
        return json!({ "connected": false });
    };
    // "-29 dBm / -93 dBm"
    let numbers: Vec<i32> = current["spairport_signal_noise"]
        .as_str()
        .unwrap_or("")
        .split('/')
        .filter_map(|p| p.trim().trim_end_matches("dBm").trim().parse().ok())
        .collect();
    // "6 (2GHz, 20MHz)"
    let channel = current["spairport_network_channel"].as_str().unwrap_or("");
    let band = ["6GHz", "5GHz", "2GHz"]
        .into_iter()
        .find(|b| channel.contains(b))
        .map(|b| if b == "2GHz" { "2.4 GHz" } else if b == "5GHz" { "5 GHz" } else { "6 GHz" });
    json!({
        "connected": true,
        "rssi": numbers.first(),
        "noise": numbers.get(1),
        "rateMbps": current["spairport_network_rate"].as_u64(),
        "channel": channel.split_whitespace().next(),
        "band": band,
        "standard": current["spairport_network_phymode"].as_str(),
    })
}

#[derive(Deserialize)]
pub(super) struct Size {
    bytes: usize,
}

/// `GET /api/speed/down?bytes=N`: N bytes that do not compress, for timing a download.
pub(super) async fn down(State(app): State<Arc<App>>, headers: HeaderMap, Query(size): Query<Size>) -> Response {
    static NOISE: LazyLock<Bytes> = LazyLock::new(|| {
        // A fixed scramble, not secret: it only has to defeat any compression on the way.
        let mut state = 0x9e37_79b9_7f4a_7c15u64;
        Bytes::from((0..1 << 20).map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state as u8
        }).collect::<Vec<u8>>())
    });
    if !paired(&app, &headers) {
        return refuse(StatusCode::UNAUTHORIZED, "this device is not paired");
    }
    let total = size.bytes.min(MAX_SPEED_BYTES);
    let chunks = (0..total.div_ceil(NOISE.len())).map(move |i| {
        let n = (total - i * NOISE.len()).min(NOISE.len());
        Ok::<_, std::io::Error>(NOISE.slice(..n))
    });
    (
        [(header::CONTENT_TYPE, "application/octet-stream"), (header::CACHE_CONTROL, "no-store")],
        Body::from_stream(futures_util::stream::iter(chunks)),
    )
        .into_response()
}

/// `POST /api/speed/up`: takes a body and says how much arrived, for timing an upload.
pub(super) async fn up(State(app): State<Arc<App>>, headers: HeaderMap, body: Bytes) -> Response {
    if !paired(&app, &headers) {
        return refuse(StatusCode::UNAUTHORIZED, "this device is not paired");
    }
    Json(json!({ "bytes": body.len() })).into_response()
}

/// `POST /api/speed/internet`: macOS's `networkQuality` against Apple's servers (about 20 s),
/// one run at a time, the result kept for a minute.
pub(super) async fn internet(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    static LAST: LazyLock<Mutex<Option<(Instant, Value)>>> = LazyLock::new(|| Mutex::new(None));
    if !paired(&app, &headers) {
        return refuse(StatusCode::UNAUTHORIZED, "this device is not paired");
    }
    let mut last = LAST.lock().await;
    if let Some((at, value)) = last.as_ref()
        && at.elapsed() < INTERNET_FOR
    {
        return Json(value.clone()).into_response();
    }
    let Some(text) = run_long("networkQuality", &["-c", "-M", "20"]).await else {
        return refuse(StatusCode::BAD_GATEWAY, "the internet test could not run");
    };
    let data: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let mbps = |key: &str| data[key].as_f64().map(|bits| (bits / 1e5).round() / 10.0);
    let value = json!({
        "downMbps": mbps("dl_throughput"),
        "upMbps": mbps("ul_throughput"),
        "rpm": data["responsiveness"].as_f64().map(f64::round),
        "rttMs": data["base_rtt"].as_f64().map(f64::round),
        "server": data["test_endpoint"].as_str(),
    });
    *last = Some((Instant::now(), value.clone()));
    Json(value).into_response()
}

async fn run_long(program: &str, args: &[&str]) -> Option<String> {
    let output = tokio::time::timeout(Duration::from_secs(40), Command::new(program).args(args).output())
        .await
        .ok()?
        .ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn battery_lines_read_as_numbers() {
        let charged = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=25624675)\t100%; finishing charge; 0:00 remaining present: true\n";
        assert_eq!(parse_battery(charged), json!({ "percent": 100, "charging": false, "full": true, "onPower": true, "minutesLeft": null }));
        let draining = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t64%; discharging; 4:37 remaining present: true\n";
        assert_eq!(parse_battery(draining), json!({ "percent": 64, "charging": false, "full": false, "onPower": false, "minutesLeft": 277 }));
        assert_eq!(parse_battery("Now drawing from 'AC Power'\n"), Value::Null);
    }

    #[test]
    fn wifi_reads_signal_rate_and_band_but_not_the_name() {
        let text = r#"{"SPAirPortDataType":[{"spairport_airport_interfaces":[{"_name":"en0","spairport_current_network_information":{"_name":"<redacted>","spairport_signal_noise":"-29 dBm / -93 dBm","spairport_network_rate":172,"spairport_network_channel":"6 (2GHz, 20MHz)","spairport_network_phymode":"802.11ax"}}]}]}"#;
        assert_eq!(
            parse_wifi(text),
            json!({ "connected": true, "rssi": -29, "noise": -93, "rateMbps": 172, "channel": "6", "band": "2.4 GHz", "standard": "802.11ax" })
        );
        assert_eq!(parse_wifi(r#"{"SPAirPortDataType":[{"spairport_airport_interfaces":[{"_name":"en0"}]}]}"#), json!({ "connected": false }));
    }
}
