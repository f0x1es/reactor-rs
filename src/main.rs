use std::{collections::{HashMap, VecDeque}, net::SocketAddr, sync::Arc, time::{Duration, SystemTime, UNIX_EPOCH}};

use axum::{
    Form, Json, Router,
    extract::State,
    http::{StatusCode, header},
    response::Html,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot, Mutex};
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use tracing::{info, warn};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Mode {
    Idle,
    Running,
    Scram,
}

#[derive(Debug, Clone, Serialize)]
struct ZoneStatus {
    id: usize,
    name: &'static str,
    target_power_pct: u8,
    power_pct: u8,
    temp_c: i32,
}

#[derive(Debug, Clone, Serialize)]
struct CaravanStatus {
    id: u64,
    eta_s: i32,
    value: u32,
    state: &'static str,
}

#[derive(Debug, Clone, Serialize)]
struct Status {
    mode: Mode,
    zones: Vec<ZoneStatus>,
    alarms: Vec<String>,
    loot: u32,
    caravans: Vec<CaravanStatus>,
    last_event: String,

    // control/state shown in ui
    auto_enabled: bool,
    auto_setpoint_power_pct: u8,
    temp_limit_c: i32,
    control_rod_pct: u8,

    // vv-er/pwr-ish plant state (toy)
    power_th_mw: i32,
    power_el_mw: i32,
    primary_t_hot_c: i32,
    primary_t_cold_c: i32,
    primary_flow_kg_s: i32,
    primary_pressure_bar: i32,
    steam_flow_kg_s: i32,
    secondary_feed_temp_c: i32,
    secondary_steam_temp_c: i32,

    // kip (elemer) - dual channels a/b with independent noise
    kip_a_primary_t_hot_c: i32,
    kip_a_primary_t_cold_c: i32,
    kip_a_primary_flow_kg_s: i32,
    kip_a_power_th_mw: i32,
    kip_b_primary_t_hot_c: i32,
    kip_b_primary_t_cold_c: i32,
    kip_b_primary_flow_kg_s: i32,
    kip_b_power_th_mw: i32,

    // power supply (toy)
    grid_power_on: bool,
    sn_a_on: bool,
    sn_b_on: bool,
    sn_c_on: bool,
    diesel_a: &'static str,
    diesel_b: &'static str,
    diesel_c: &'static str,

    // failures/protection (toy)
    az_failed: bool,
    saoz_active: bool,
}

#[derive(Debug, Clone, Serialize)]
struct HistoryPoint {
    t_s: u32,
    mode: Mode,

    // kept for ui charts compatibility
    avg_power_pct: u8,
    max_temp_c: i32,
    voronezh_power_pct: u8,
    voronezh_temp_c: i32,

    // pwr-ish telemetry (toy)
    power_th_mw: i32,
    power_el_mw: i32,
    primary_t_hot_c: i32,
    primary_t_cold_c: i32,
    primary_flow_kg_s: i32,
    primary_pressure_bar: i32,
    steam_flow_kg_s: i32,
    secondary_feed_temp_c: i32,
    secondary_steam_temp_c: i32,

    // power supply
    grid_power_on: bool,
    sn_on: u8,
}

#[derive(Debug, Deserialize)]
struct SetPowerRequest {
    zone: usize,
    target_power_pct: u8,
}

#[derive(Debug)]
enum SafetyRequest {
    SetTargetPower { zone: usize, target_power_pct: u8 },
    Scram,
    Reset,
    GetStatus(oneshot::Sender<Status>),
}

#[derive(Debug)]
enum CoreRequest {
    Tick,
    SetMode(Mode),
    SetTargetPower { zone: usize, target_power_pct: u8 },
    SetAuto { enabled: bool },
    SetAutoSetpoint { power_pct: u8 },
    SetRod { rod_pct: u8 },
    SetCharging { kg_s: u32 },
    SetLetdown { kg_s: u32 },
    ContainmentHit,
    PipeRupture,
    RobCaravan { id: u64, reply: oneshot::Sender<Result<u32, String>> },
    GetStatus(oneshot::Sender<Status>),
    GetHistory(oneshot::Sender<Vec<HistoryPoint>>),
}

#[derive(Debug, thiserror::Error)]
enum SafetyError {
    #[error("unknown zone {0}")]
    UnknownZone(usize),
    #[error("target power {target_power_pct}% exceeds max allowed {max_power_pct}%")]
    TargetPowerTooHigh {
        target_power_pct: u8,
        max_power_pct: u8,
    },
}

#[derive(Clone)]
struct AppState {
    safety_tx: mpsc::Sender<SafetyRequest>,
    core_tx: mpsc::Sender<CoreRequest>,
    audit: Arc<Mutex<AuditState>>,
}

#[derive(Debug, Clone)]
struct AuditEntry {
    ts_s: u64,
    callsign: String,
    action: String,
    params: String,
}

#[derive(Debug)]
struct ClientInfo {
    callsign: String,
    last_seen_s: u64,
}

#[derive(Debug)]
struct AuditState {
    clients: HashMap<String, ClientInfo>,
    log: VecDeque<AuditEntry>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let zones = 5;
    let zone_names: [&'static str; 5] = ["voronezh", "zone_1", "zone_2", "zone_3", "zone_4"]; // meme naming

    // wire: http -> safety -> core
    let (safety_tx, safety_rx) = mpsc::channel::<SafetyRequest>(256);
    let (core_tx, core_rx) = mpsc::channel::<CoreRequest>(256);

    tokio::spawn(safety_actor(zones, safety_rx, core_tx.clone()));
    tokio::spawn(core_actor(zones, zone_names.to_vec(), core_rx));
    tokio::spawn(ticker(core_tx.clone()));

    let audit = Arc::new(Mutex::new(AuditState {
        clients: HashMap::new(),
        log: VecDeque::with_capacity(512),
    }));

    let app = Router::new()
        .route("/", get(ui_index))
        .route("/assets/voronezh.gif", get(asset_voronezh_gif))
        .route("/assets/medieval.mp3", get(asset_medieval_mp3))
        .route("/ui/mode", get(ui_mode))
        .route("/ui/alarms", get(ui_alarms))
        .route("/ui/zones", get(ui_zones))
        .route("/ui/caravans", get(ui_caravans))
        .route("/ui/loot", get(ui_loot))
        .route("/ui/set_power", post(ui_set_power))
        .route("/ui/auto", post(ui_auto))
        .route("/ui/auto_setpoint", post(ui_auto_setpoint))
        .route("/ui/rod", post(ui_rod))
        .route("/ui/rob", post(ui_rob))
        .route("/ui/scram", post(ui_scram))
        .route("/ui/reset", post(ui_reset))
        .route("/ui/containment_hit", post(ui_containment_hit))
        .route("/ui/pipe_rupture", post(ui_pipe_rupture))
        .route("/ui/charging", post(ui_charging))
        .route("/ui/letdown", post(ui_letdown))
        .route("/ui/audit", get(ui_audit))
        .route("/health", get(health))
        .route("/status", get(get_status))
        .route("/history", get(get_history))
        .route("/set_power", post(set_power))
        .route("/scram", post(scram))
        .route("/reset", post(reset))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(AppState {
            safety_tx,
            core_tx,
            audit,
        });

    let addr: SocketAddr = "0.0.0.0:8080".parse()?;
    info!(%addr, "http listening");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

async fn ticker(core_tx: mpsc::Sender<CoreRequest>) {
    let mut t = tokio::time::interval(Duration::from_millis(250));
    loop {
        t.tick().await;
        let _ = core_tx.send(CoreRequest::Tick).await;
    }
}

async fn ui_index(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
) -> (axum::http::HeaderMap, Html<&'static str>) {
    let (hm, _id, _cs) = ensure_client_headers(&st, &headers).await;
    (hm, Html(UI_HTML))
}

async fn fetch_status(st: &AppState) -> Result<Status, StatusCode> {
    let (tx, rx) = oneshot::channel();
    st.safety_tx
        .send(SafetyRequest::GetStatus(tx))
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    rx.await.map_err(|_| StatusCode::SERVICE_UNAVAILABLE)
}

async fn ui_mode(State(st): State<AppState>) -> Result<Html<&'static str>, StatusCode> {
    let status = fetch_status(&st).await?;
    let s = match status.mode {
        Mode::Idle => "idle",
        Mode::Running => "running",
        Mode::Scram => "scram",
    };
    Ok(Html(s))
}

async fn ui_alarms(State(st): State<AppState>) -> Result<Html<String>, StatusCode> {
    let status = fetch_status(&st).await?;
    if status.alarms.is_empty() {
        return Ok(Html("<span class=\"alarm\">none</span>".to_string()));
    }

    let mut out = String::new();
    for a in status.alarms {
        let bad = a.contains("high") || a.contains("voronezh");
        let cls = if bad { "alarm bad" } else { "alarm" };
        out.push_str(&format!("<span class=\"{}\">{}</span>", cls, html_escape(&a)));
    }
    Ok(Html(out))
}

async fn ui_zones(State(st): State<AppState>) -> Result<Html<String>, StatusCode> {
    let status = fetch_status(&st).await?;

    let mut out = String::new();
    for z in status.zones {
        out.push_str("<tr>");
        out.push_str(&format!("<td>{}</td>", z.id));
        out.push_str(&format!("<td>{}</td>", html_escape(z.name)));
        out.push_str(&format!("<td>{}%</td>", z.target_power_pct));
        out.push_str(&format!(
            "<td><div class=\"z\"><span style=\"min-width:44px\">{}%</span><div class=\"bar\"><i style=\"width:{}%\"></i></div></div></td>",
            z.power_pct, z.power_pct
        ));
        let t_pct: i32 = ((z.temp_c - 20) * 1).clamp(0, 100);
        out.push_str(&format!(
            "<td><div class=\"z\"><span style=\"min-width:44px\">{}c</span><div class=\"bar temp\"><i style=\"width:{}%\"></i></div></div></td>",
            z.temp_c, t_pct
        ));
        out.push_str("</tr>");
    }

    Ok(Html(out))
}

async fn ui_loot(State(st): State<AppState>) -> Result<Html<String>, StatusCode> {
    let status = fetch_status(&st).await?;
    Ok(Html(format!("loot: {}", status.loot)))
}

async fn ui_caravans(State(st): State<AppState>) -> Result<Html<String>, StatusCode> {
    let status = fetch_status(&st).await?;
    if status.caravans.is_empty() {
        return Ok(Html("<div class=\"muted tiny\">no caravans</div>".to_string()));
    }

    let mut out = String::new();
    out.push_str("<table><thead><tr><th>id</th><th>eta</th><th>value</th><th>state</th><th></th></tr></thead><tbody>");
    for c in status.caravans {
        out.push_str("<tr>");
        out.push_str(&format!("<td>{}</td>", c.id));
        out.push_str(&format!("<td>{}s</td>", c.eta_s));
        out.push_str(&format!("<td>{}</td>", c.value));
        out.push_str(&format!("<td>{}</td>", html_escape(c.state)));
        if c.state == "available" {
            out.push_str(&format!("<td><button type=\"button\" hx-post=\"/ui/rob\" hx-vals=\"{{&quot;id&quot;:{}}}\" hx-target=\"#msg\" hx-swap=\"innerHTML\">rob</button></td>", c.id));
        } else {
            // keep row height stable: reserve the button slot.
            out.push_str("<td><span class=\"btnph\"></span></td>");
        }
        out.push_str("</tr>");
    }
    out.push_str("</tbody></table>");
    Ok(Html(out))
}

#[derive(Debug, Deserialize)]
struct RobForm {
    id: u64,
}

async fn ui_rob(
    State(st): State<AppState>,
    Form(req): Form<RobForm>,
) -> Result<([(axum::http::HeaderName, &'static str); 1], Html<String>), StatusCode> {
    let (tx, rx) = oneshot::channel();
    st.core_tx
        .send(CoreRequest::RobCaravan { id: req.id, reply: tx })
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;

    let msg = match rx.await.map_err(|_| StatusCode::SERVICE_UNAVAILABLE)? {
        Ok(v) => format!("robbed +{} loot", v),
        Err(e) => format!("rob failed: {}", html_escape(&e)),
    };

    // force immediate refresh of htmx-polled fragments.
    Ok(([(header::HeaderName::from_static("hx-trigger"), "refresh")], Html(msg)))
}

#[derive(Debug, Deserialize)]
struct SetPowerForm {
    zone: usize,
    target_power_pct: u8,
}

async fn ui_set_power(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Form(req): Form<SetPowerForm>,
) -> Result<(axum::http::HeaderMap, Html<&'static str>), (StatusCode, Html<&'static str>)> {
    let (mut hm, cid, callsign) = ensure_client_headers(&st, &headers).await;
    hm.insert(
        header::HeaderName::from_static("hx-trigger"),
        header::HeaderValue::from_static("refresh"),
    );

    audit_push(
        &st,
        &cid,
        &callsign,
        "set_power",
        &format!("zone={} target={}%%", req.zone, req.target_power_pct),
    )
    .await;

    // manual setpower also disables auto (otherwise it will fight the operator)
    let _ = st
        .core_tx
        .send(CoreRequest::SetAuto { enabled: false })
        .await;

    st.safety_tx
        .send(SafetyRequest::SetTargetPower {
            zone: req.zone,
            target_power_pct: req.target_power_pct,
        })
        .await
        .map_err(|_| (StatusCode::SERVICE_UNAVAILABLE, Html("offline")))?;

    Ok((hm, Html("accepted")))
}

async fn ui_scram(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Result<(axum::http::HeaderMap, Html<&'static str>), StatusCode> {
    let (mut hm, cid, callsign) = ensure_client_headers(&st, &headers).await;
    hm.insert(
        header::HeaderName::from_static("hx-trigger"),
        header::HeaderValue::from_static("refresh"),
    );
    audit_push(&st, &cid, &callsign, "scram", "az-5").await;

    let _ = st
        .core_tx
        .send(CoreRequest::SetAuto { enabled: false })
        .await;
    let _ = st.core_tx.send(CoreRequest::SetRod { rod_pct: 100 }).await;

    st.safety_tx
        .send(SafetyRequest::Scram)
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    Ok((hm, Html("воронеж отменён")))
}

async fn ui_reset(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Result<(axum::http::HeaderMap, Html<&'static str>), StatusCode> {
    let (mut hm, cid, callsign) = ensure_client_headers(&st, &headers).await;
    hm.insert(
        header::HeaderName::from_static("hx-trigger"),
        header::HeaderValue::from_static("refresh"),
    );
    audit_push(&st, &cid, &callsign, "reset", "").await;

    let _ = st
        .core_tx
        .send(CoreRequest::SetAuto { enabled: false })
        .await;
    let _ = st.core_tx.send(CoreRequest::SetRod { rod_pct: 0 }).await;

    st.safety_tx
        .send(SafetyRequest::Reset)
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    Ok((hm, Html("reset")))
}

#[derive(Debug, Deserialize)]
struct AutoForm {
    enabled: Option<String>,
}

async fn ui_auto(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Form(req): Form<AutoForm>,
) -> Result<(axum::http::HeaderMap, Html<String>), StatusCode> {
    let (mut hm, cid, callsign) = ensure_client_headers(&st, &headers).await;
    hm.insert(
        header::HeaderName::from_static("hx-trigger"),
        header::HeaderValue::from_static("refresh"),
    );

    let enabled = req.enabled.is_some();
    audit_push(
        &st,
        &cid,
        &callsign,
        "auto",
        if enabled { "on" } else { "off" },
    )
    .await;

    st.core_tx
        .send(CoreRequest::SetAuto { enabled })
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;

    Ok((
        hm,
        Html(if enabled {
            "auto: on".to_string()
        } else {
            "auto: off".to_string()
        }),
    ))
}

#[derive(Debug, Deserialize)]
struct AutoSetpointForm {
    power_pct: u8,
}

async fn ui_auto_setpoint(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Form(req): Form<AutoSetpointForm>,
) -> Result<(axum::http::HeaderMap, Html<&'static str>), StatusCode> {
    let (mut hm, cid, callsign) = ensure_client_headers(&st, &headers).await;
    hm.insert(
        header::HeaderName::from_static("hx-trigger"),
        header::HeaderValue::from_static("refresh"),
    );

    audit_push(
        &st,
        &cid,
        &callsign,
        "auto_sp",
        &format!("{}%", req.power_pct),
    )
    .await;

    st.core_tx
        .send(CoreRequest::SetAutoSetpoint {
            power_pct: req.power_pct,
        })
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    Ok((hm, Html("set")))
}

#[derive(Debug, Deserialize)]
struct RodForm {
    rod_pct: u8,
}

async fn ui_rod(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Form(req): Form<RodForm>,
) -> Result<(axum::http::HeaderMap, Html<&'static str>), StatusCode> {
    let (mut hm, cid, callsign) = ensure_client_headers(&st, &headers).await;
    hm.insert(
        header::HeaderName::from_static("hx-trigger"),
        header::HeaderValue::from_static("refresh"),
    );

    audit_push(
        &st,
        &cid,
        &callsign,
        "rod",
        &format!("{}%", req.rod_pct.min(100)),
    )
    .await;

    st.core_tx
        .send(CoreRequest::SetRod {
            rod_pct: req.rod_pct.min(100),
        })
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    Ok((hm, Html("set")))
}

async fn ui_containment_hit(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Result<(axum::http::HeaderMap, Html<&'static str>), StatusCode> {
    let (mut hm, cid, callsign) = ensure_client_headers(&st, &headers).await;
    hm.insert(
        header::HeaderName::from_static("hx-trigger"),
        header::HeaderValue::from_static("refresh"),
    );

    audit_push(&st, &cid, &callsign, "containment_hit", "").await;

    st.core_tx
        .send(CoreRequest::ContainmentHit)
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    Ok((hm, Html("external impact")))
}

async fn ui_pipe_rupture(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Result<(axum::http::HeaderMap, Html<&'static str>), StatusCode> {
    let (mut hm, cid, callsign) = ensure_client_headers(&st, &headers).await;
    hm.insert(
        header::HeaderName::from_static("hx-trigger"),
        header::HeaderValue::from_static("refresh"),
    );

    audit_push(&st, &cid, &callsign, "pipe_rupture", "").await;

    st.core_tx
        .send(CoreRequest::PipeRupture)
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    Ok((hm, Html("pipe rupture")))
}

#[derive(Debug, Deserialize)]
struct FlowCtlForm {
    kg_s: u32,
}

async fn ui_charging(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Form(req): Form<FlowCtlForm>,
) -> Result<(axum::http::HeaderMap, Html<&'static str>), StatusCode> {
    let (mut hm, cid, callsign) = ensure_client_headers(&st, &headers).await;
    hm.insert(
        header::HeaderName::from_static("hx-trigger"),
        header::HeaderValue::from_static("refresh"),
    );

    audit_push(&st, &cid, &callsign, "charging", &format!("{} kg/s", req.kg_s)).await;

    st.core_tx
        .send(CoreRequest::SetCharging { kg_s: req.kg_s })
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    Ok((hm, Html("set")))
}

async fn ui_letdown(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
    Form(req): Form<FlowCtlForm>,
) -> Result<(axum::http::HeaderMap, Html<&'static str>), StatusCode> {
    let (mut hm, cid, callsign) = ensure_client_headers(&st, &headers).await;
    hm.insert(
        header::HeaderName::from_static("hx-trigger"),
        header::HeaderValue::from_static("refresh"),
    );

    audit_push(&st, &cid, &callsign, "letdown", &format!("{} kg/s", req.kg_s)).await;

    st.core_tx
        .send(CoreRequest::SetLetdown { kg_s: req.kg_s })
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    Ok((hm, Html("set")))
}

async fn ui_audit(
    State(st): State<AppState>,
    headers: axum::http::HeaderMap,
) -> (axum::http::HeaderMap, Html<String>) {
    let (hm, _cid, _callsign) = ensure_client_headers(&st, &headers).await;

    let guard = st.audit.lock().await;
    let mut out = String::new();
    out.push_str("<div class=\"audit\"><div class=\"t\">audit</div><div class=\"log\">\n");
    for e in guard.log.iter().rev().take(24) {
        out.push_str(&format!(
            "<div class=\"line\"><span class=\"ts\">{}</span> <span class=\"cs\">{}</span> <span class=\"ac\">{}</span> <span class=\"pa\">{}</span></div>",
            e.ts_s,
            html_escape(&e.callsign),
            html_escape(&e.action),
            html_escape(&e.params)
        ));
    }
    out.push_str("</div></div>");
    (hm, Html(out))
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn prng_u32(state: &mut u32) -> u32 {
    // xorshift32
    let mut x = *state;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    *state = x;
    x
}

fn prng_noise(state: &mut u32, amp: f64) -> f64 {
    let v = prng_u32(state) as f64 / (u32::MAX as f64);
    (v * 2.0 - 1.0) * amp
}

fn now_s() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn parse_cookie(headers: &axum::http::HeaderMap, key: &str) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in raw.split(';') {
        let p = part.trim();
        if let Some((k, v)) = p.split_once('=') {
            if k.trim() == key {
                return Some(v.trim().to_string());
            }
        }
    }
    None
}

fn make_client_id(seed: u32) -> String {
    format!("{:08x}{:08x}", seed, seed.rotate_left(13))
}

fn make_callsign(seed: u32) -> String {
    const ADJ: [&str; 12] = [
        "rusty", "cold", "hot", "lazy", "fast", "grim", "wild", "calm", "blind", "sharp", "heavy", "tiny",
    ];
    const NOUN: [&str; 12] = [
        "owl", "pump", "valve", "rod", "steam", "pipe", "diesel", "loop", "core", "cond", "sg", "gcn",
    ];

    let a = ADJ[(seed as usize) % ADJ.len()];
    let n = NOUN[((seed >> 8) as usize) % NOUN.len()];
    let num = (seed % 97) + 3;
    format!("operator {}-{}-{}", a, n, num)
}

async fn ensure_client_headers(
    st: &AppState,
    headers: &axum::http::HeaderMap,
) -> (axum::http::HeaderMap, String, String) {
    // set-cookie only when no client_id cookie exists.
    let mut out = axum::http::HeaderMap::new();

    let mut cid = parse_cookie(headers, "reactor_client_id");
    let seed = prng_u32(&mut (now_s() as u32).wrapping_mul(1103515245).wrapping_add(12345));

    if cid.is_none() {
        cid = Some(make_client_id(seed));
        let cookie = format!(
            "reactor_client_id={}; Path=/; Max-Age=604800; SameSite=Lax",
            cid.as_ref().unwrap()
        );
        if let Ok(v) = axum::http::HeaderValue::from_str(&cookie) {
            out.insert(header::SET_COOKIE, v);
        }
    }

    let cid = cid.unwrap_or_else(|| make_client_id(seed));

    // lookup or allocate callsign.
    let callsign = {
        let mut guard = st.audit.lock().await;
        let ts = now_s();

        // cleanup: ttl + hard cap
        let ttl_s = 24 * 3600;
        guard
            .clients
            .retain(|_, v| ts.saturating_sub(v.last_seen_s) <= ttl_s);
        if guard.clients.len() > 200 {
            // drop oldest
            let mut items: Vec<(String, u64)> = guard
                .clients
                .iter()
                .map(|(k, v)| (k.clone(), v.last_seen_s))
                .collect();
            items.sort_by_key(|it| it.1);
            for (k, _) in items.into_iter().take(guard.clients.len() - 200) {
                guard.clients.remove(&k);
            }
        }

        let ent = guard.clients.entry(cid.clone()).or_insert_with(|| ClientInfo {
            callsign: make_callsign(seed ^ 0x9e3779b9),
            last_seen_s: ts,
        });
        ent.last_seen_s = ts;
        ent.callsign.clone()
    };

    (out, cid, callsign)
}

async fn audit_push(st: &AppState, cid: &str, callsign: &str, action: &str, params: &str) {
    let mut guard = st.audit.lock().await;
    let e = AuditEntry {
        ts_s: now_s(),
        callsign: callsign.to_string(),
        action: action.to_string(),
        params: params.to_string(),
    };
    guard.log.push_back(e);
    while guard.log.len() > 400 {
        guard.log.pop_front();
    }

    // refresh last_seen
    if let Some(ci) = guard.clients.get_mut(cid) {
        ci.last_seen_s = now_s();
    }
}

async fn asset_voronezh_gif() -> ([(axum::http::HeaderName, &'static str); 1], &'static [u8]) {
    // keep it self-contained: serve a bundled gif without any external cdn.
    const GIF: &[u8] = include_bytes!("../assets/voronezh.gif");
    ([(header::CONTENT_TYPE, "image/gif")], GIF)
}

async fn asset_medieval_mp3() -> ([(axum::http::HeaderName, &'static str); 1], &'static [u8]) {
    // user-provided mp3; served locally.
    const MP3: &[u8] = include_bytes!("../assets/medieval.mp3");
    ([(header::CONTENT_TYPE, "audio/mpeg")], MP3)
}

async fn health() -> StatusCode {
    StatusCode::OK
}

async fn get_status(State(st): State<AppState>) -> Result<Json<Status>, StatusCode> {
    let (tx, rx) = oneshot::channel();
    st.safety_tx
        .send(SafetyRequest::GetStatus(tx))
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    let status = rx.await.map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    Ok(Json(status))
}

async fn get_history(State(st): State<AppState>) -> Result<Json<Vec<HistoryPoint>>, StatusCode> {
    let (tx, rx) = oneshot::channel();
    st.core_tx
        .send(CoreRequest::GetHistory(tx))
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    let hist = rx.await.map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    Ok(Json(hist))
}

async fn set_power(
    State(st): State<AppState>,
    Json(req): Json<SetPowerRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    st.safety_tx
        .send(SafetyRequest::SetTargetPower {
            zone: req.zone,
            target_power_pct: req.target_power_pct,
        })
        .await
        .map_err(|_| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "safety offline".to_string(),
            )
        })?;
    Ok(StatusCode::ACCEPTED)
}

async fn scram(State(st): State<AppState>) -> Result<StatusCode, StatusCode> {
    st.safety_tx
        .send(SafetyRequest::Scram)
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    Ok(StatusCode::ACCEPTED)
}

async fn reset(State(st): State<AppState>) -> Result<StatusCode, StatusCode> {
    st.safety_tx
        .send(SafetyRequest::Reset)
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    Ok(StatusCode::ACCEPTED)
}

async fn safety_actor(
    zones: usize,
    mut rx: mpsc::Receiver<SafetyRequest>,
    core_tx: mpsc::Sender<CoreRequest>,
) {
    let max_power_pct: u8 = 80;

    while let Some(msg) = rx.recv().await {
        match msg {
            SafetyRequest::SetTargetPower {
                zone,
                target_power_pct,
            } => match validate_target_power(zones, zone, target_power_pct, max_power_pct) {
                Ok(()) => {
                    let _ = core_tx.send(CoreRequest::SetMode(Mode::Running)).await;
                    let _ = core_tx
                        .send(CoreRequest::SetTargetPower {
                            zone,
                            target_power_pct,
                        })
                        .await;
                }
                Err(e) => {
                    warn!(error = %e, zone, target_power_pct, "denied by safety");
                }
            },
            SafetyRequest::Scram => {
                let _ = core_tx.send(CoreRequest::SetMode(Mode::Scram)).await;
                for zone in 0..zones {
                    let _ = core_tx
                        .send(CoreRequest::SetTargetPower {
                            zone,
                            target_power_pct: 0,
                        })
                        .await;
                }
            }
            SafetyRequest::Reset => {
                let _ = core_tx.send(CoreRequest::SetMode(Mode::Idle)).await;
                for zone in 0..zones {
                    let _ = core_tx
                        .send(CoreRequest::SetTargetPower {
                            zone,
                            target_power_pct: 0,
                        })
                        .await;
                }
            }
            SafetyRequest::GetStatus(reply) => {
                let (tx, rx) = oneshot::channel();
                if core_tx.send(CoreRequest::GetStatus(tx)).await.is_ok() {
                    if let Ok(st) = rx.await {
                        let _ = reply.send(st);
                    }
                }
            }
        }
    }
}

fn validate_target_power(
    zones: usize,
    zone: usize,
    target_power_pct: u8,
    max_power_pct: u8,
) -> Result<(), SafetyError> {
    if zone >= zones {
        return Err(SafetyError::UnknownZone(zone));
    }
    if target_power_pct > max_power_pct {
        return Err(SafetyError::TargetPowerTooHigh {
            target_power_pct,
            max_power_pct,
        });
    }
    Ok(())
}

async fn core_actor(
    zones: usize,
    zone_names: Vec<&'static str>,
    mut rx: mpsc::Receiver<CoreRequest>,
) {
    let mut mode = Mode::Idle;

    // operator setpoints (legacy per-zone). for pwr-ish model we currently use zone0 as main setpoint.
    let mut target_power: Vec<u8> = vec![0; zones];

    // zone instrumentation (kept for ui; derived from plant state)
    let mut power: Vec<i32> = vec![0; zones];
    let mut temp: Vec<i32> = vec![25; zones];

    // plant state (toy pwr/vver-ish)
    let mut power_th_mw: f64 = 0.0;
    let mut power_el_mw: f64 = 0.0;

    let mut primary_t_hot_c: f64 = 290.0;
    let mut primary_t_cold_c: f64 = 275.0;
    let mut primary_pressure_bar: f64 = 155.0;
    let primary_pressure_sp_bar: f64 = 155.0;

    // charging/letdown (toy). operator-controlled flows.
    let mut charging_kg_s: f64 = 0.0;
    let mut letdown_kg_s: f64 = 0.0;
    let mut primary_flow_kg_s: f64 = 15000.0;

    let mut steam_flow_kg_s: f64 = 0.0;
    let mut secondary_feed_temp_c: f64 = 220.0;
    let mut secondary_steam_temp_c: f64 = 260.0;

    // condenser / heat sink (toy)
    let env_temp_c: f64 = 30.0;
    let cond_cooling_k: f64 = 0.06; // per tick relaxation strength

    // cold makeup into primary: deprecated now that we have a toy secondary heat sink.
    // keep this at 0 unless we explicitly want "cheat cooling".
    let makeup_flow_kg_s: f64 = 0.0;
    let makeup_temp_c: f64 = 22.0;

    // kip (elemer) noise state per channel
    let mut kip_seed_a: u32 = 0x12345678;
    let mut kip_seed_b: u32 = 0x87654321;

    let mut loot: u32 = 0;
    let mut last_event: String = "boot".to_string();

    let mut auto_enabled: bool = false;
    let mut auto_setpoint_power_pct: u8 = 50;
    let temp_limit_c: i32 = 330;
    let mut control_rod_pct: u8 = 0;

    // power supply / aux power (toy)
    let mut grid_power_on: bool = true;
    // map own-needs sections to loop pumps: assume 4 loops, each has a gcn pump; powered by 3 sections.
    // sn_a powers loops 0-1, sn_b powers loop 2, sn_c powers loop 3.
    let mut sn_on: [bool; 3] = [true, true, true];
    let mut diesel_state: [&'static str; 3] = ["online", "online", "online"]; // off|starting|online
    let mut diesel_t: [i32; 3] = [0, 0, 0];

    let mut gcn_on: [bool; 4] = [true, true, true, true];
    let sg_on: [bool; 4] = [true, true, true, true];

    // events / failures (toy)
    let mut containment_hit_ttl_s: i32 = 0;
    let mut pipe_rupture_ttl_s: i32 = 0;
    let mut az_failed_ttl_s: i32 = 0;
    let mut saoz_active_ttl_s: i32 = 0;
    // reserved for future failure scenarios
    let mut _last_non_scram_rod_pct: u8 = 0;

    let mut caravan_next_id: u64 = 1;
    let mut caravan_spawn_t: i32 = 5;
    let mut caravans: Vec<(u64, i32, u32, &'static str)> = Vec::new();

    let mut tick_s: u32 = 0;
    let mut history: VecDeque<HistoryPoint> = VecDeque::with_capacity(600);

    while let Some(msg) = rx.recv().await {
        match msg {
            CoreRequest::Tick => {
                // toy vv-er/pwr-ish plant step. zone0 is treated as main setpoint when auto is off.
                let sp_pct: f64 = if mode == Mode::Scram {
                    0.0
                } else if auto_enabled {
                    auto_setpoint_power_pct as f64
                } else {
                    *target_power.get(0).unwrap_or(&0) as f64
                };

                // functional blocks: gcn + steam generators. derive gcn supply from own-needs sections.
                // section mapping: sn_a -> loops 0-1, sn_b -> loop 2, sn_c -> loop 3.
                gcn_on[0] = sn_on[0];
                gcn_on[1] = sn_on[0];
                gcn_on[2] = sn_on[1];
                gcn_on[3] = sn_on[2];

                let gcn_running: u8 = gcn_on.iter().filter(|v| **v).count() as u8;

                // egor spec: gcn protection -> reduce power when pumps drop
                let gcn_factor: f64 = match gcn_running {
                    4 => 1.0,
                    3 => 0.75,
                    2 => 0.50,
                    _ => 0.0,
                };

                // rods reduce available reactivity (simple multiplier)
                let rod_factor: f64 = (100u8.saturating_sub(control_rod_pct) as f64) / 100.0;
                let eff_sp_pct: f64 = (sp_pct * rod_factor * gcn_factor).clamp(0.0, 100.0);

                // ramp thermal power toward effective setpoint
                let cur_pct: f64 = (power_th_mw / 3000.0 * 100.0).clamp(0.0, 100.0);
                let dp: f64 = (eff_sp_pct - cur_pct).clamp(-3.0, 3.0);
                let next_pct: f64 = (cur_pct + dp).clamp(0.0, 100.0);
                power_th_mw = (next_pct / 100.0) * 3000.0;

                // primary flow (abstract). depends on how many gcns are running + scram.
                let base_flow = if mode == Mode::Scram { 9000.0 } else { 15000.0 };
                let flow_factor: f64 = match gcn_running {
                    4 => 1.0,
                    3 => 0.82,
                    2 => 0.62,
                    1 => 0.40,
                    _ => 0.08,
                };
                primary_flow_kg_s = base_flow * flow_factor;

                // saoz in this toy model just forces extra cooling capacity.
                if saoz_active_ttl_s > 0 {
                    primary_flow_kg_s = primary_flow_kg_s.max(16000.0);
                }

                // core -> primary heat
                let cp_j_kg_k: f64 = 5000.0; // water-ish
                let dt_core_k: f64 = if primary_flow_kg_s <= 1.0 {
                    0.0
                } else {
                    (power_th_mw * 1_000_000.0) / (primary_flow_kg_s * cp_j_kg_k)
                };

                // update hot leg first (core heating)
                let t_hot_target: f64 = (primary_t_cold_c + dt_core_k).clamp(250.0, 360.0);
                primary_t_hot_c = primary_t_hot_c + (t_hot_target - primary_t_hot_c) * 0.35;

                // steam generator heat transfer (primary->secondary)
                let sgs_running: u8 = sg_on.iter().filter(|v| **v).count() as u8;

                // turbulence: at higher flow we get better heat transfer (effective ua), but no randomness.
                let turb = (primary_flow_kg_s / 15000.0).clamp(0.2, 1.4);
                let ua_mw_per_k: f64 = 8.0 * (sgs_running as f64 / 4.0) * (0.85 + 0.35 * turb);
                let delta_t_sg: f64 = (primary_t_hot_c - secondary_feed_temp_c).max(0.0);
                let q_sg_mw: f64 = (ua_mw_per_k * delta_t_sg).min(power_th_mw).max(0.0);

                let dt_sg_k: f64 = if primary_flow_kg_s <= 1.0 {
                    0.0
                } else {
                    (q_sg_mw * 1_000_000.0) / (primary_flow_kg_s * cp_j_kg_k)
                };
                let t_cold_target: f64 = (primary_t_hot_c - dt_sg_k).clamp(240.0, 340.0);
                primary_t_cold_c = primary_t_cold_c + (t_cold_target - primary_t_cold_c) * 0.35;

                // charging/letdown: mix a small amount of feedwater into primary and bleed out the same mass.
                // simplified: net mass affects pressure; charging also cools slightly.
                if charging_kg_s > 0.0 {
                    let f = (charging_kg_s / (primary_flow_kg_s + charging_kg_s)).clamp(0.0, 0.25);
                    primary_t_cold_c = primary_t_cold_c * (1.0 - f) + secondary_feed_temp_c * f;
                }

                // toy pressure model: drift toward setpoint + response to net mass flow + relief valve.
                let net = (charging_kg_s - letdown_kg_s).clamp(-5000.0, 5000.0);
                primary_pressure_bar += (net / 5000.0) * 1.8;
                primary_pressure_bar += (primary_pressure_sp_bar - primary_pressure_bar) * 0.02;

                let relief_open = primary_pressure_bar > 170.0;
                if relief_open {
                    primary_pressure_bar -= 2.5;
                }
                primary_pressure_bar = primary_pressure_bar.clamp(20.0, 180.0);

                // cold makeup mixing into cold leg (toy): optional "cheat cooling".
                if makeup_flow_kg_s > 0.0 {
                    let f = (makeup_flow_kg_s / (primary_flow_kg_s + makeup_flow_kg_s)).clamp(0.0, 0.6);
                    primary_t_cold_c = primary_t_cold_c * (1.0 - f) + makeup_temp_c * f;
                }

                // secondary: two-medium side of the steam generator + turbine + condenser.
                // we keep it 0d: secondary_feed_temp_c represents feedwater into sg,
                // secondary_steam_temp_c represents "steam side" temperature.
                let latent_j_kg: f64 = 2_200_000.0;
                steam_flow_kg_s = (q_sg_mw * 1_000_000.0) / latent_j_kg;
                power_el_mw = q_sg_mw * 0.33;

                // steam-side temperature rises with heat input, then condenser pulls it toward env.
                secondary_steam_temp_c = (secondary_steam_temp_c + (q_sg_mw / 40.0)).clamp(80.0, 340.0);
                let cond_strength = cond_cooling_k * (0.5 + (steam_flow_kg_s / 2000.0).clamp(0.0, 1.5));
                secondary_steam_temp_c = secondary_steam_temp_c + (env_temp_c - secondary_steam_temp_c) * cond_strength;

                // feedwater temperature follows condenser outlet + some deaerator reheating.
                let feed_target: f64 = (env_temp_c + 15.0 + (power_el_mw / 3000.0) * 35.0).clamp(40.0, 260.0);
                secondary_feed_temp_c = secondary_feed_temp_c + (feed_target - secondary_feed_temp_c) * 0.22;

                // power supply model: if grid is lost, start diesels for each section.
                if !grid_power_on {
                    for i in 0..3 {
                        if diesel_state[i] == "off" {
                            diesel_state[i] = "starting";
                            diesel_t[i] = 30 + (i as i32) * 7; // toy spread, <= 60
                        }
                        if diesel_state[i] == "starting" {
                            diesel_t[i] -= 1;
                            if diesel_t[i] <= 0 {
                                diesel_state[i] = "online";
                                sn_on[i] = true;
                            }
                        }
                    }
                }

                if containment_hit_ttl_s > 0 {
                    containment_hit_ttl_s -= 1;
                }
                if pipe_rupture_ttl_s > 0 {
                    pipe_rupture_ttl_s -= 1;
                }
                if az_failed_ttl_s > 0 {
                    az_failed_ttl_s -= 1;
                }
                if saoz_active_ttl_s > 0 {
                    saoz_active_ttl_s -= 1;
                }

                // if saoz is active, force power down (toy emergency cooling + suppression)
                if saoz_active_ttl_s > 0 {
                    power_th_mw = (power_th_mw - 250.0).max(0.0);
                }

                // if 2+ gcns are gone -> force cold shutdown (toy)
                if gcn_running <= 1 {
                    mode = Mode::Idle;
                    control_rod_pct = 100;
                    power_th_mw = 0.0;
                    power_el_mw = 0.0;
                    for z in 0..zones {
                        target_power[z] = 0;
                    }
                    last_event = "cold shutdown: gcn loss".to_string();
                }

                // auto temp protection: insert rods / reduce setpoint if primary hot leg overheats
                if auto_enabled {
                    let hot_now = primary_t_hot_c.round() as i32;
                    if hot_now >= temp_limit_c {
                        control_rod_pct = (control_rod_pct + 10).min(100);
                        auto_setpoint_power_pct = auto_setpoint_power_pct.saturating_sub(10);
                        last_event = format!("auto: temp limit hit ({}c)", hot_now);
                        if hot_now >= temp_limit_c + 20 {
                            mode = Mode::Scram;
                            control_rod_pct = 100;
                            for z in 0..zones {
                                target_power[z] = 0;
                            }
                            last_event = "auto: scram".to_string();
                        }
                    } else if hot_now <= temp_limit_c - 10 {
                        control_rod_pct = control_rod_pct.saturating_sub(1);
                    }
                }

                // derive legacy zone instrumentation from plant state
                for z in 0..zones {
                    let bias_p = if z == 0 { 0.0 } else { -10.0 };
                    let bias_t = if z == 0 { 0.0 } else { -15.0 };
                    power[z] = (next_pct + bias_p).clamp(0.0, 100.0).round() as i32;
                    temp[z] = (primary_t_hot_c + bias_t).round() as i32;
                }

                // caravans: countdown + spawn
                for c in &mut caravans {
                    if c.1 > 0 {
                        c.1 -= 1;
                        if c.1 <= 0 {
                            c.3 = "available";
                        }
                    }
                }

                caravan_spawn_t -= 1;
                if caravan_spawn_t <= 0 {
                    let eta = 8 + ((caravan_next_id as i32) % 5);
                    let val = 5 + ((caravan_next_id as u32) % 20);
                    caravans.push((caravan_next_id, eta, val, "en_route"));
                    caravan_next_id += 1;
                    caravan_spawn_t = 10;
                }

                // cap list
                if caravans.len() > 12 {
                    caravans.drain(0..(caravans.len() - 12));
                }

                // history (1 point per tick)
                tick_s = tick_s.saturating_add(1);
                let max_temp = temp.iter().copied().max().unwrap_or(0);
                let avg_power: i32 = if power.is_empty() {
                    0
                } else {
                    power.iter().sum::<i32>() / (power.len() as i32)
                };
                let z0_power = *power.get(0).unwrap_or(&0);
                let z0_temp = *temp.get(0).unwrap_or(&20);

                let sn_count: u8 = sn_on.iter().filter(|v| **v).count() as u8;

                history.push_back(HistoryPoint {
                    t_s: tick_s,
                    mode,
                    avg_power_pct: avg_power.clamp(0, 100) as u8,
                    max_temp_c: max_temp,
                    voronezh_power_pct: z0_power.clamp(0, 100) as u8,
                    voronezh_temp_c: z0_temp,
                    power_th_mw: power_th_mw.round() as i32,
                    power_el_mw: power_el_mw.round() as i32,
                    primary_t_hot_c: primary_t_hot_c.round() as i32,
                    primary_t_cold_c: primary_t_cold_c.round() as i32,
                    primary_flow_kg_s: primary_flow_kg_s.round() as i32,
                    primary_pressure_bar: primary_pressure_bar.round() as i32,
                    steam_flow_kg_s: steam_flow_kg_s.round() as i32,
                    secondary_feed_temp_c: secondary_feed_temp_c.round() as i32,
                    secondary_steam_temp_c: secondary_steam_temp_c.round() as i32,
                    grid_power_on,
                    sn_on: sn_count,
                });
                while history.len() > 300 {
                    history.pop_front();
                }
            }

            CoreRequest::SetMode(m) => {
                // protections are deterministic: az always drops rods here.
                if m == Mode::Scram {
                    az_failed_ttl_s = 0;
                    saoz_active_ttl_s = 0;
                    control_rod_pct = 100;
                }

                mode = m;
            }
            CoreRequest::SetTargetPower {
                zone,
                target_power_pct,
            } => {
                if zone < zones {
                    target_power[zone] = target_power_pct;
                }
            }
            CoreRequest::SetAuto { enabled } => {
                auto_enabled = enabled;
                if !auto_enabled {
                    last_event = "auto: off".to_string();
                } else {
                    last_event = "auto: on".to_string();
                }
            }
            CoreRequest::SetAutoSetpoint { power_pct } => {
                auto_setpoint_power_pct = power_pct.min(100);
                last_event = format!("auto sp: {}%", auto_setpoint_power_pct);
            }
            CoreRequest::SetRod { rod_pct } => {
                control_rod_pct = rod_pct.min(100);
                if mode != Mode::Scram {
                    _last_non_scram_rod_pct = control_rod_pct;
                }
                last_event = format!("rod: {}%", control_rod_pct);
            }
            CoreRequest::SetCharging { kg_s } => {
                charging_kg_s = (kg_s as f64).min(5000.0);
                last_event = format!("charging: {} kg/s", charging_kg_s.round() as i32);
            }
            CoreRequest::SetLetdown { kg_s } => {
                letdown_kg_s = (kg_s as f64).min(5000.0);
                last_event = format!("letdown: {} kg/s", letdown_kg_s.round() as i32);
            }
            CoreRequest::ContainmentHit => {
                // external impact: instant scram + loss of grid and some aux sections.
                mode = Mode::Scram;
                auto_enabled = false;
                control_rod_pct = 100;
                grid_power_on = false;

                // drop 1-2 sections (deterministic-ish from time)
                let pick = (tick_s % 3) as usize;
                sn_on[pick] = false;
                if (tick_s % 2) == 0 {
                    sn_on[(pick + 1) % 3] = false;
                }
                for i in 0..3 {
                    if !sn_on[i] {
                        diesel_state[i] = "off";
                        diesel_t[i] = 0;
                    }
                }

                containment_hit_ttl_s = 90;
                last_event = "containment hit".to_string();
                for z in 0..zones {
                    target_power[z] = 0;
                }
            }
            CoreRequest::PipeRupture => {
                mode = Mode::Scram;
                auto_enabled = false;
                control_rod_pct = 100;

                // lose primary inventory: pressure/flow collapse.
                primary_pressure_bar = 30.0;
                primary_flow_kg_s = 1200.0;

                // force saoz as a toy response (no real procedures)
                saoz_active_ttl_s = 120;
                pipe_rupture_ttl_s = 120;
                last_event = "pipe rupture".to_string();
                for z in 0..zones {
                    target_power[z] = 0;
                }
            }
            CoreRequest::RobCaravan { id, reply } => {
                let mut res: Result<u32, String> = Err("not found".to_string());
                for c in &mut caravans {
                    if c.0 == id {
                        if c.3 != "available" {
                            res = Err("not available".to_string());
                        } else {
                            loot = loot.saturating_add(c.2);
                            last_event = format!("robbed caravan {} (+{})", id, c.2);
                            res = Ok(c.2);
                            c.3 = "robbed";
                        }
                        break;
                    }
                }
                let _ = reply.send(res);
            }
            CoreRequest::GetStatus(reply) => {
                let zones_status: Vec<ZoneStatus> = (0..zones)
                    .map(|id| ZoneStatus {
                        id,
                        name: zone_names.get(id).copied().unwrap_or("zone"),
                        target_power_pct: target_power[id],
                        power_pct: power[id].clamp(0, 100) as u8,
                        temp_c: temp[id],
                    })
                    .collect();

                let mut alarms = compute_alarms(mode, &zones_status);
                if containment_hit_ttl_s > 0 {
                    alarms.push("containment_hit".to_string());
                }
                if pipe_rupture_ttl_s > 0 {
                    alarms.push("pipe_rupture".to_string());
                }
                if az_failed_ttl_s > 0 {
                    alarms.push("az_failed".to_string());
                }
                if saoz_active_ttl_s > 0 {
                    alarms.push("saoz_active".to_string());
                }
                if !grid_power_on {
                    alarms.push("power_lost".to_string());
                }
                let caravans_status: Vec<CaravanStatus> = caravans
                    .iter()
                    .map(|(id, eta, value, state)| CaravanStatus {
                        id: *id,
                        eta_s: *eta,
                        value: *value,
                        state: *state,
                    })
                    .collect();

                // elemer-like dual-channel kip values (noise only; no random in protections)
                let a_t_hot = (primary_t_hot_c + prng_noise(&mut kip_seed_a, 1.2)).round() as i32;
                let a_t_cold = (primary_t_cold_c + prng_noise(&mut kip_seed_a, 1.2)).round() as i32;
                let a_flow = (primary_flow_kg_s + prng_noise(&mut kip_seed_a, 120.0)).round() as i32;
                let a_p_th = (power_th_mw + prng_noise(&mut kip_seed_a, 25.0)).round() as i32;

                // elemer quirk (egor): channel b shows slightly higher temperature than channel a.
                let b_t_hot_raw = (primary_t_hot_c + prng_noise(&mut kip_seed_b, 1.6)).round() as i32;
                let b_t_cold_raw = (primary_t_cold_c + prng_noise(&mut kip_seed_b, 1.6)).round() as i32;
                let b_t_hot = b_t_hot_raw.max(a_t_hot + 1);
                let b_t_cold = b_t_cold_raw.max(a_t_cold + 1);

                let b_flow = (primary_flow_kg_s + prng_noise(&mut kip_seed_b, 160.0)).round() as i32;
                let b_p_th = (power_th_mw + prng_noise(&mut kip_seed_b, 35.0)).round() as i32;

                // mismatch alarm from instrumentation only
                if (a_t_hot - b_t_hot).abs() >= 8 || (a_flow - b_flow).abs() >= 600 {
                    alarms.push("kip_mismatch".to_string());
                }

                let _ = reply.send(Status {
                    mode,
                    zones: zones_status,
                    alarms,
                    loot,
                    caravans: caravans_status,
                    last_event: last_event.clone(),
                    auto_enabled,
                    auto_setpoint_power_pct,
                    temp_limit_c,
                    control_rod_pct,
                    power_th_mw: power_th_mw.round() as i32,
                    power_el_mw: power_el_mw.round() as i32,
                    primary_t_hot_c: primary_t_hot_c.round() as i32,
                    primary_t_cold_c: primary_t_cold_c.round() as i32,
                    primary_flow_kg_s: primary_flow_kg_s.round() as i32,
                    primary_pressure_bar: primary_pressure_bar.round() as i32,
                    steam_flow_kg_s: steam_flow_kg_s.round() as i32,
                    secondary_feed_temp_c: secondary_feed_temp_c.round() as i32,
                    secondary_steam_temp_c: secondary_steam_temp_c.round() as i32,
                    kip_a_primary_t_hot_c: a_t_hot,
                    kip_a_primary_t_cold_c: a_t_cold,
                    kip_a_primary_flow_kg_s: a_flow,
                    kip_a_power_th_mw: a_p_th,
                    kip_b_primary_t_hot_c: b_t_hot,
                    kip_b_primary_t_cold_c: b_t_cold,
                    kip_b_primary_flow_kg_s: b_flow,
                    kip_b_power_th_mw: b_p_th,
                    grid_power_on,
                    sn_a_on: sn_on[0],
                    sn_b_on: sn_on[1],
                    sn_c_on: sn_on[2],
                    diesel_a: diesel_state[0],
                    diesel_b: diesel_state[1],
                    diesel_c: diesel_state[2],
                    az_failed: az_failed_ttl_s > 0,
                    saoz_active: saoz_active_ttl_s > 0,
                });
            }
            CoreRequest::GetHistory(reply) => {
                let _ = reply.send(history.iter().cloned().collect());
            }
        }
    }
}

fn compute_alarms(mode: Mode, zones: &[ZoneStatus]) -> Vec<String> {
    let mut alarms = Vec::new();

    let max_temp = zones.iter().map(|z| z.temp_c).max().unwrap_or(0);
    if max_temp >= 330 {
        alarms.push("temp_high".to_string());
    }

    // voronezh meme alarm: power > 69%
    if zones
        .iter()
        .any(|z| z.name == "voronezh" && z.power_pct > 69)
    {
        alarms.push("voronezh_moment".to_string());
    }

    if mode == Mode::Scram {
        alarms.push("scram_active".to_string());
    }

    alarms
}

const UI_HTML: &str = r##"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>reactor-rs</title>
  <script src="https://cdn.jsdelivr.net/npm/htmx.org@2.0.4/dist/htmx.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.2/dist/chart.umd.min.js"></script>
  <script src="https://unpkg.com/three@0.150.1/build/three.min.js"></script>
  <style>
    :root {
      --bg0:#070b10;
      --bg1:#0b0f14;
      --panel: rgba(17,24,38,.62);
      --panel2: rgba(10,14,20,.55);
      --line: rgba(34,48,65,.92);
      --text:#e6edf3;
      --muted:#9fb1c1;
      --ok:#2dd4bf;
      --warn:#fbbf24;
      --bad:#fb7185;
      --blue:#60a5fa;
      --radius: 14px;
      --pad: 12px;
      --gap: 10px;
      --fs_title: 11px;
      --fs_pill: 12px;
      --fs_h1: 14px;
      --fs_hint: 12px;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    }

    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      background:
        radial-gradient(1200px 700px at 18% -10%, rgba(96,165,250,.25), transparent 55%),
        radial-gradient(900px 500px at 100% 0%, rgba(45,212,191,.16), transparent 55%),
        radial-gradient(900px 650px at 80% 120%, rgba(251,113,133,.10), transparent 60%),
        linear-gradient(180deg, var(--bg0), var(--bg1));
      color: var(--text);
      font-family: var(--mono);
      overflow: hidden;
    }

    .app {
      height: 100vh;
      width: 100vw;
      padding: var(--gap);
      display: grid;
      grid-template-columns: minmax(360px, 0.95fr) minmax(420px, 1.05fr);
      grid-template-rows: auto 1fr;
      gap: var(--gap);
    }

    .topbar {
      grid-column: 1 / -1;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--gap);
      padding: 10px 12px;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--panel);
      box-shadow: 0 10px 30px rgba(0,0,0,.35);
    }

    .brand {
      display: flex;
      align-items: baseline;
      gap: 10px;
      min-width: 0;
    }

    .brand h1 {
      margin: 0;
      font-size: var(--fs_h1);
      letter-spacing: .12em;
      text-transform: uppercase;
      font-weight: 800;
      white-space: nowrap; font-size: var(--fs_pill);
    }

    .pill {
      display: inline-flex;
      gap: 8px;
      align-items: center;
      padding: 5px 9px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: rgba(6,10,14,.45);
      color: var(--muted);
      white-space: nowrap; font-size: var(--fs_pill);
    }

    .pill b { color: var(--text); }

    .panel {
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--panel);
      box-shadow: 0 10px 30px rgba(0,0,0,.35);
      overflow: hidden;
      min-height: 0;
    }

    .panel .hd {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 12px;
      background: rgba(6,10,14,.28);
      border-bottom: 1px solid rgba(34,48,65,.75);
    }

    .panel .hd .t {
      font-size: var(--fs_title);
      letter-spacing: .10em;
      text-transform: uppercase;
      color: var(--muted);
      font-weight: 800;
    }

    .panel .bd {
      padding: var(--pad);
      min-height: 0;
      height: 100%;
    }

    .left {
      display: grid;
      grid-template-rows: auto 1fr;
      gap: var(--gap);
      min-height: 0;
    }

    .right {
      display: grid;
      grid-template-rows: 1.1fr 0.9fr;
      gap: var(--gap);
      min-height: 0;
    }

    /* controls */
    form.controls {
      display: grid;
      grid-template-columns: 110px 1fr 140px 1fr auto auto auto;
      gap: 10px;
      align-items: center;
    }

    label { font-size: var(--fs_title); color: var(--muted); letter-spacing: .06em; text-transform: uppercase; font-weight: 800; }

    input {
      border: 1px solid var(--line);
      border-radius: 12px;
      background: rgba(6,10,14,.55);
      color: var(--text);
      padding: 10px 12px;
      font-family: var(--mono);
      width: 100%;
    }

    button {
      cursor: pointer;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: rgba(6,10,14,.35);
      color: var(--text);
      padding: 10px 12px;
      font-family: var(--mono);
      font-weight: 800;
      white-space: nowrap; font-size: var(--fs_pill);
    }

    button:hover { border-color: rgba(96,165,250,.55); }
    button.danger { border-color: rgba(251,113,133,.55); }
    button.danger:hover { border-color: rgba(251,113,133,.95); }

    #msg { color: var(--muted); font-size: 12px; }

    /* audit */
    #audit { position: fixed; left: 14px; bottom: 14px; width: min(520px, calc(100vw - 28px)); z-index: 20; }
    .audit { border: 1px solid rgba(34,48,65,.75); border-radius: 14px; background: rgba(6,10,14,.80); backdrop-filter: blur(8px); }
    .audit .t { padding: 10px 12px; border-bottom: 1px solid rgba(34,48,65,.65); color: var(--muted); font-size: 12px; letter-spacing: .10em; text-transform: uppercase; font-weight: 800; }
    .audit .log { max-height: 220px; overflow:auto; padding: 8px 12px; font-family: var(--mono); font-size: 12px; color: #cbd5e1; }
    .audit .line { white-space: nowrap; overflow:hidden; text-overflow: ellipsis; padding: 2px 0; }
    .audit .ts { color: #94a3b8; }
    .audit .cs { color: #e2e8f0; }
    .audit .ac { color: #93c5fd; }
    .audit .pa { color: #a7f3d0; }

    /* tables */
    .tablewrap { height: 100%; overflow: auto; border-radius: 14px; border: 1px solid rgba(34,48,65,.75); background: var(--panel2); }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { padding: 10px 10px; border-bottom: 1px solid rgba(34,48,65,.65); text-align: left; }
    th { position: sticky; top: 0; background: rgba(6,10,14,.55); z-index: 1; color: var(--muted); font-size: 12px; letter-spacing: .10em; text-transform: uppercase; font-weight: 800; }

    .z { display:flex; gap: 10px; align-items:center; }
    .bar { flex: 1; height: 10px; background: rgba(34,48,65,.7); border-radius: 999px; overflow:hidden; }
    .bar > i { display:block; height: 100%; background: linear-gradient(90deg, var(--ok), var(--blue)); width: 0%; }
    .bar.temp > i { background: linear-gradient(90deg, var(--blue), var(--warn), var(--bad)); }

    /* alarms */
    .alarms { display:flex; flex-wrap:wrap; gap: 8px; align-items:center; }
    .alarm { padding: 5px 9px; border-radius: 999px; border:1px solid rgba(251,191,36,.35); color: #fcd34d; background: rgba(251,191,36,.08); }
    .alarm.bad { border-color: rgba(251,113,133,.45); color:#fda4af; background: rgba(251,113,133,.08); }

    /* caravans: prevent row height jump */
    .caravans table th:last-child, .caravans table td:last-child { width: 96px; }
    .caravans button { width: 72px; height: 34px; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
    .caravans .btnph { width: 72px; height: 34px; display:inline-block; }

    /* 3d */
    #three { width: 100%; height: 100%; min-height: 360px; border-radius: 14px; border: 1px solid rgba(34,48,65,.75); background: rgba(6,10,14,.35); overflow: hidden; }

    .footer {
      display:flex;
      align-items:center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 12px;
      border-top: 1px solid rgba(34,48,65,.65);
      background: rgba(6,10,14,.22);
      color: var(--muted);
      font-size: 12px;
    }

    .hint { color: var(--muted); font-size: var(--fs_hint); line-height: 1.35; }
    code { color: #c7d2fe; }

    @media (max-width: 980px) {
      body { overflow: auto; }
      .app { height: auto; min-height: 100vh; overflow: visible; grid-template-columns: 1fr; grid-template-rows: auto auto auto; }
      .right { grid-template-rows: auto auto; }
      #three { min-height: 300px; }
      form.controls { grid-template-columns: 1fr 1fr; }
    }
  </style>
</head>
<body>
  <div class="app">
    <div class="topbar">
      <div class="brand">
        <h1>reactor-rs</h1>
        <span class="pill">mode: <b id="mode" hx-get="/ui/mode" hx-trigger="load, every 1s, refresh" hx-swap="innerHTML">-</b></span>
      </div>
      <div class="pill" id="musicBtn" role="button" tabindex="0">music: <b id="musicState">off</b></div>
      <div class="pill">poll: <b>1s</b></div>
    </div>

    <div class="left">
      <div class="panel">
        <div class="hd">
          <div class="t">control</div>
          <div id="msg"></div>
          <div id="audit" hx-get="/ui/audit" hx-trigger="load, every 1s" hx-swap="innerHTML"></div>
        </div>
        <div class="bd">
          <form class="controls" hx-post="/ui/set_power" hx-target="#msg" hx-swap="innerHTML">
            <label>zone</label>
            <input name="zone" type="number" min="0" max="99" value="0" />
            <label>target power %</label>
            <input name="target_power_pct" type="number" min="0" max="100" value="50" />
            <button type="submit">set power</button>
            <button class="danger" type="button" hx-post="/ui/scram" hx-target="#msg" hx-swap="innerHTML">az-5</button>
            <button type="button" hx-post="/ui/reset" hx-target="#msg" hx-swap="innerHTML">reset</button>
            <button class="danger" type="button" hx-post="/ui/containment_hit" hx-target="#msg" hx-swap="innerHTML">containment hit</button>
            <button class="danger" type="button" hx-post="/ui/pipe_rupture" hx-target="#msg" hx-swap="innerHTML">pipe rupture</button>
          </form>

          <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:10px;">
            <form hx-post="/ui/auto" hx-target="#msg" hx-swap="innerHTML">
              <button type="submit" name="enabled" value="1">auto on</button>
            </form>
            <form hx-post="/ui/auto" hx-target="#msg" hx-swap="innerHTML">
              <button type="submit">auto off</button>
            </form>
            <form hx-post="/ui/auto_setpoint" hx-target="#msg" hx-swap="innerHTML" style="display:flex; gap:10px; align-items:center;">
              <label>auto sp %</label>
              <input name="power_pct" type="number" min="0" max="100" value="50" style="width:120px;" />
              <button type="submit">set</button>
            </form>
            <form hx-post="/ui/rod" hx-target="#msg" hx-swap="innerHTML" style="display:flex; gap:10px; align-items:center;">
              <label>rod %</label>
              <input name="rod_pct" type="number" min="0" max="100" value="0" style="width:120px;" />
              <button type="submit">set</button>
            </form>
          </div>

          <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:10px;">
            <form hx-post="/ui/charging" hx-target="#msg" hx-swap="innerHTML" style="display:flex; gap:10px; align-items:center;">
              <label>charging kg/s</label>
              <input name="kg_s" type="number" min="0" max="5000" value="0" style="width:160px;" />
              <button type="submit">set</button>
            </form>
            <form hx-post="/ui/letdown" hx-target="#msg" hx-swap="innerHTML" style="display:flex; gap:10px; align-items:center;">
              <label>letdown kg/s</label>
              <input name="kg_s" type="number" min="0" max="5000" value="0" style="width:160px;" />
              <button type="submit">set</button>
            </form>
          </div>

          <div class="hint" style="margin-top:10px;">zones 1-4 = extra load. auto keeps power/temp in check.</div>
        </div>
      </div>

      <div class="panel">
        <div class="hd">
          <div class="t">zones</div>
          <div class="pill">poll: <b>1s</b></div>
        </div>
        <div class="bd" style="padding:0;">
          <div class="tablewrap">
            <table>
              <thead>
                <tr>
                  <th style="width:64px;">zone</th>
                  <th style="width:120px;">name</th>
                  <th style="width:90px;">target</th>
                  <th>power</th>
                  <th>temp</th>
                </tr>
              </thead>
              <tbody id="zones" hx-get="/ui/zones" hx-trigger="load, every 1s, refresh" hx-swap="innerHTML"></tbody>
            </table>
          </div>
        </div>
        <div class="footer">
          <span>endpoints: <code>/status</code> <code>/set_power</code> <code>/scram</code> <code>/reset</code></span>
          <img src="/assets/voronezh.gif" alt="voronezh" style="height:34px; border-radius:10px; border:1px solid rgba(34,48,65,.8);" />
        </div>
      </div>
    </div>

    <div class="right">
      <div class="panel">
        <div class="hd">
          <div class="t">3d</div>
          <div class="pill">VVER-1000 primary circuit</div>
        </div>
        <div class="bd" style="display:grid; grid-template-rows: 1fr 160px; gap: 10px;">
          <div id="three"></div>
          <div class="tablewrap" style="padding:10px;">
            <canvas id="chart" style="width:100%; height:140px;"></canvas>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="hd">
          <div class="t">alarms & caravans</div>
          <div class="alarms" id="alarms" hx-get="/ui/alarms" hx-trigger="load, every 1s, refresh" hx-swap="innerHTML"></div>
          <div class="pill" id="loot" hx-get="/ui/loot" hx-trigger="load, every 1s, refresh" hx-swap="innerHTML">loot: -</div>
        </div>
        <div class="bd" style="padding:0;">
                    <div class="tablewrap caravans" style="height:100%;">
            <div id="caravans" hx-get="/ui/caravans" hx-trigger="load, every 1s, refresh" hx-swap="innerHTML" style="padding:0;"></div>
          </div>
        </div>
      </div>
    </div>
  </div>

<script>
(function(){
  // audio: starts on first user gesture; toggle via topbar button.
  let audio = null;
  let audioOn = false;
  const stateEl = document.getElementById('musicState');
  function setAudioState(on){
    audioOn = on;
    if (stateEl) stateEl.textContent = on ? 'on' : 'off';
  }
  function ensureAudio(){
    if (!audio) {
      audio = new Audio('/assets/medieval.mp3');
      audio.loop = true;
      audio.volume = 0.18;
    }
    return audio;
  }
  async function startAudio(){
    try {
      const a = ensureAudio();
      await a.play();
      setAudioState(true);
    } catch (e) {
      // autoplay restrictions; ignore.
    }
  }
  function stopAudio(){
    if (!audio) return;
    audio.pause();
    audio.currentTime = 0;
    setAudioState(false);
  }
  function toggleAudio(){
    if (audioOn) stopAudio();
    else startAudio();
  }
  const btn = document.getElementById('musicBtn');
  if (btn) {
    btn.addEventListener('click', toggleAudio);
    btn.addEventListener('keydown', (e)=>{ if (e.key==='Enter' || e.key===' ') toggleAudio(); });
  }
  // "almost autoplay": start on first click/tap anywhere.
  window.addEventListener('pointerdown', ()=>{ if (!audioOn) startAudio(); }, { once: true });

  // charts: lightweight trend lines from /history
  let chart = null;
  function ensureChart(){
    if (!window.Chart) return null;
    const el = document.getElementById('chart');
    if (!el) return null;
    if (chart) return chart;

    const ctx = el.getContext('2d');
    chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          { label: 'avg power %', data: [], borderColor: '#2dd4bf', tension: 0.25, pointRadius: 0 },
          { label: 'max temp c', data: [], borderColor: '#fb7185', tension: 0.25, pointRadius: 0, yAxisID: 'y1' },
        ],
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { display: false },
          y: { min: 0, max: 100, grid: { color: 'rgba(34,48,65,.35)' }, ticks: { color: '#9fb1c1' } },
          y1: { position: 'right', grid: { drawOnChartArea: false }, ticks: { color: '#9fb1c1' } },
        },
      },
    });
    return chart;
  }

  async function pollHistory(){
    try {
      const r = await fetch('/history');
      if (!r.ok) return;
      const hist = await r.json();
      const c = ensureChart();
      if (!c) return;
      c.data.labels = hist.map(p => p.t_s);
      c.data.datasets[0].data = hist.map(p => p.avg_power_pct);
      c.data.datasets[1].data = hist.map(p => p.max_temp_c);
      c.update();
    } catch (e) {}
  }
  pollHistory();
  setInterval(pollHistory, 1000);

  if (!window.THREE) return;

  const host = document.getElementById('three');
  if (!host) return;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x080c12, 3, 18);

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.set(3.2, 2.8, 3.2);
  camera.lookAt(0, 0.2, 0);

  let renderer = null;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(renderer.domElement);
  } catch (e) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, host.clientWidth || 1);
    c.height = Math.max(1, host.clientHeight || 1);
    c.style.width = '100%'; c.style.height = '100%';
    host.appendChild(c);
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'rgba(6,10,14,.35)'; ctx.fillRect(0,0,c.width,c.height);
    ctx.fillStyle = '#9fb1c1'; ctx.font = '14px ui-monospace, monospace';
    ctx.fillText('webgl off: 3d disabled', 14, 24);
    return;
  }

  // --- lighting ---
  const ambient = new THREE.AmbientLight(0x8899bb, 0.50);
  scene.add(ambient);
  const key = new THREE.DirectionalLight(0xffeedd, 0.9);
  key.position.set(4, 6, 3);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 0.5; key.shadow.camera.far = 20;
  key.shadow.camera.left = -5; key.shadow.camera.right = 5;
  key.shadow.camera.top = 5; key.shadow.camera.bottom = -5;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x6688cc, 0.35);
  fill.position.set(-3, 2, -2);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0x88aaff, 0.25);
  rim.position.set(-1, 1, 4);
  scene.add(rim);

  // --- ground platform ---
  const baseGeo = new THREE.CylinderGeometry(3.5, 3.5, 0.06, 64);
  const baseMat = new THREE.MeshStandardMaterial({ color: 0x1a1f28, roughness: 0.9, metalness: 0.1 });
  const base = new THREE.Mesh(baseGeo, baseMat);
  base.position.y = -0.83;
  base.receiveShadow = true;
  scene.add(base);

  // grid lines on platform
  const gridMat = new THREE.MeshStandardMaterial({ color: 0x252d3a, roughness: 0.95, metalness: 0 });
  for (let i = -6; i <= 6; i++) {
    const g1 = new THREE.Mesh(new THREE.BoxGeometry(7, 0.005, 0.008), gridMat);
    g1.position.set(0, -0.795, i * 0.5);
    scene.add(g1);
    const g2 = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.005, 7), gridMat);
    g2.position.set(i * 0.5, -0.795, 0);
    scene.add(g2);
  }

  // === REACTOR VESSEL (корпус реактора) ===
  // main cylindrical body
  const vesselR = 0.32, vesselH = 1.6;
  const vesselGeo = new THREE.CylinderGeometry(vesselR, vesselR, vesselH, 32);
  const vesselMat = new THREE.MeshStandardMaterial({ color: 0xc8d4e0, roughness: 0.30, metalness: 0.55, emissive: 0x0a0c10 });
  const vessel = new THREE.Mesh(vesselGeo, vesselMat);
  vessel.position.y = 0.0;
  vessel.castShadow = true;
  scene.add(vessel);

  // hemispherical dome top
  const domeGeo = new THREE.SphereGeometry(vesselR, 32, 16, 0, Math.PI*2, 0, Math.PI/2);
  const domeMat = new THREE.MeshStandardMaterial({ color: 0xd0dce8, roughness: 0.25, metalness: 0.6, emissive: 0x080a0e });
  const dome = new THREE.Mesh(domeGeo, domeMat);
  dome.position.y = vesselH/2;
  dome.castShadow = true;
  scene.add(dome);

  // hemispherical bottom
  const botGeo = new THREE.SphereGeometry(vesselR * 0.95, 32, 16, 0, Math.PI*2, Math.PI/2, Math.PI/2);
  const bot = new THREE.Mesh(botGeo, domeMat.clone());
  bot.position.y = -vesselH/2;
  scene.add(bot);

  // vessel flanges (rings)
  const flangeGeo = new THREE.TorusGeometry(vesselR + 0.04, 0.025, 12, 32);
  const flangeMat = new THREE.MeshStandardMaterial({ color: 0x8899aa, roughness: 0.4, metalness: 0.7 });
  for (const fy of [vesselH/2 - 0.02, 0.0, -vesselH/2 + 0.02]) {
    const f = new THREE.Mesh(flangeGeo, flangeMat);
    f.position.y = fy;
    f.rotation.x = Math.PI/2;
    scene.add(f);
  }

  // core glow (point light inside vessel, driven by power)
  const coreGlow = new THREE.PointLight(0x2dd4bf, 0, 2.5);
  coreGlow.position.set(0, 0, 0);
  scene.add(coreGlow);
  // secondary warm glow
  const coreGlow2 = new THREE.PointLight(0xff6644, 0, 1.8);
  coreGlow2.position.set(0, -0.2, 0);
  scene.add(coreGlow2);

  // nozzle ring at pipe attachment height
  const nozzleH = 0.18;
  const nozzleGeo = new THREE.TorusGeometry(vesselR + 0.02, 0.018, 10, 32);
  const nozzle1 = new THREE.Mesh(nozzleGeo, flangeMat);
  nozzle1.position.y = nozzleH;
  nozzle1.rotation.x = Math.PI/2;
  scene.add(nozzle1);

  // === CONTROL ROD DRIVE MECHANISMS (приводы СУЗ) ===
  const rods = [];
  const crdmGroup = new THREE.Group();
  // drive housings on top of dome
  const housingGeo = new THREE.CylinderGeometry(0.022, 0.022, 0.45, 10);
  const housingMat = new THREE.MeshStandardMaterial({ color: 0x95a5b5, roughness: 0.4, metalness: 0.5 });
  const rodGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.6, 8);
  const rodMat = new THREE.MeshStandardMaterial({ color: 0x606870, roughness: 0.5, metalness: 0.3 });
  for (let i = 0; i < 16; i++) {
    const a = (i/16) * Math.PI*2;
    const rr = (i % 2 === 0) ? 0.14 : 0.22;
    const hx = Math.cos(a) * rr, hz = Math.sin(a) * rr;
    // housing tube
    const h = new THREE.Mesh(housingGeo, housingMat);
    h.position.set(hx, vesselH/2 + 0.32 + 0.22, hz);
    h.castShadow = true;
    crdmGroup.add(h);
    // actual rod (extends down into vessel)
    const rod = new THREE.Mesh(rodGeo, rodMat);
    rod.position.set(hx, vesselH/2 + 0.1, hz);
    crdmGroup.add(rod);
    rods.push({ mesh: rod, baseY: vesselH/2 + 0.1, hx, hz });
  }
  // top plate connecting CRDMs
  const topPlateGeo = new THREE.CylinderGeometry(0.28, 0.30, 0.04, 32);
  const topPlate = new THREE.Mesh(topPlateGeo, flangeMat);
  topPlate.position.y = vesselH/2 + 0.10;
  crdmGroup.add(topPlate);
  scene.add(crdmGroup);

  // === LABEL ===
  function makeLabel(text, fontSize){
    const c = document.createElement('canvas');
    c.width = 512; c.height = 128;
    const ctx = c.getContext('2d');
    ctx.font = '700 ' + (fontSize || 56) + 'px ui-monospace, monospace';
    ctx.fillStyle = '#e6edf3';
    ctx.shadowColor = 'rgba(96,165,250,.7)';
    ctx.shadowBlur = 16;
    const m = ctx.measureText(text);
    ctx.fillText(text, Math.max(16, (c.width - m.width) / 2), 82);
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
    const spr = new THREE.Sprite(mat);
    spr.scale.set(1.6, 0.4, 1);
    return spr;
  }

  const label = makeLabel('VVER-1000');
  label.position.set(0, vesselH/2 + 0.85, 0);
  scene.add(label);

  // === CONTAINMENT SHELL (гермооболочка) — semi-transparent dome ===
  const contGeo = new THREE.SphereGeometry(2.8, 48, 32, 0, Math.PI*2, 0, Math.PI/2);
  const contMat = new THREE.MeshStandardMaterial({
    color: 0x4466aa, roughness: 0.6, metalness: 0.1,
    transparent: true, opacity: 0.06, side: THREE.DoubleSide
  });
  const containment = new THREE.Mesh(contGeo, contMat);
  containment.position.y = -0.8;
  scene.add(containment);
  // containment ring at base
  const contRing = new THREE.Mesh(
    new THREE.TorusGeometry(2.8, 0.02, 12, 64),
    new THREE.MeshStandardMaterial({ color: 0x3355aa, roughness: 0.5, metalness: 0.3, transparent: true, opacity: 0.25 })
  );
  contRing.position.y = -0.8;
  contRing.rotation.x = Math.PI/2;
  scene.add(contRing);

  // === PRIMARY CIRCUIT: 4 LOOPS ===
  const loops = [];
  const pipeR = 0.038;
  const dotGeo = new THREE.SphereGeometry(0.022, 8, 8);

  // SG: large horizontal vessel with integrated caps
  const sgR = 0.18, sgLen = 0.90;
  const sgBodyGeo = new THREE.CapsuleGeometry(sgR, sgLen, 16, 28);

  // pump: visible volute shape
  const pumpBodyGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.22, 24);
  const pumpFlangeGeo = new THREE.TorusGeometry(0.13, 0.018, 10, 24);

  function makeHotMat(){ return new THREE.MeshStandardMaterial({ color: 0xd4836b, roughness: 0.38, metalness: 0.42, emissive: 0x000000 }); }
  function makeColdMat(){ return new THREE.MeshStandardMaterial({ color: 0x5a9ec7, roughness: 0.38, metalness: 0.42, emissive: 0x000000 }); }

  function makeTube(curve, mat, radius){
    const geo = new THREE.TubeGeometry(curve, 72, radius || pipeR, 14, false);
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    return m;
  }

  const loopAngles = [0, Math.PI/2, Math.PI, Math.PI*3/2];
  const sgDist = 1.65;
  const pumpDist = 1.20;

  for (let i = 0; i < 4; i++) {
    const g = new THREE.Group();
    const ang = loopAngles[i];
    const ca = Math.cos(ang), sa = Math.sin(ang);

    // SG: elevated, far out
    const sgX = ca * sgDist, sgZ = sa * sgDist, sgY = 0.15;
    // perpendicular direction for SG orientation
    const pdx = -sa, pdz = ca;

    // === Steam Generator (ПГ) ===
    const sgMat = new THREE.MeshStandardMaterial({ color: 0xc8b080, roughness: 0.35, metalness: 0.50, emissive: 0x000000 });
    const sgBody = new THREE.Mesh(sgBodyGeo, sgMat);
    sgBody.position.set(sgX, sgY, sgZ);
    // lay it horizontal along the perpendicular direction
    sgBody.quaternion.setFromAxisAngle(new THREE.Vector3(0,1,0), ang);
    sgBody.rotateZ(Math.PI/2);
    sgBody.castShadow = true;
    g.add(sgBody);

    // SG inlet/outlet nozzles (small cylinders pointing toward reactor)
    const nozSgGeo = new THREE.CylinderGeometry(0.032, 0.032, 0.12, 10);
    const nozSgMat = new THREE.MeshStandardMaterial({ color: 0x8899aa, roughness: 0.4, metalness: 0.5 });
    // hot inlet (top)
    const ni = new THREE.Mesh(nozSgGeo, nozSgMat);
    ni.position.set(sgX - ca*0.12, sgY + 0.06, sgZ - sa*0.12);
    ni.rotation.z = Math.PI/2;
    ni.rotation.y = -ang;
    g.add(ni);
    // cold outlet (bottom)
    const no = new THREE.Mesh(nozSgGeo, nozSgMat);
    no.position.set(sgX - ca*0.12, sgY - 0.12, sgZ - sa*0.12);
    no.rotation.z = Math.PI/2;
    no.rotation.y = -ang;
    g.add(no);

    // secondary steam pipe going up from SG top
    const steamPipeGeo = new THREE.CylinderGeometry(0.025, 0.025, 0.5, 10);
    const steamPipeMat = new THREE.MeshStandardMaterial({ color: 0x8899aa, roughness: 0.4, metalness: 0.5 });
    const steamPipe = new THREE.Mesh(steamPipeGeo, steamPipeMat);
    steamPipe.position.set(sgX, sgY + sgR + 0.25, sgZ);
    steamPipe.castShadow = true;
    g.add(steamPipe);
    // steam pipe elbow (small sphere)
    const elbGeo = new THREE.SphereGeometry(0.03, 10, 10);
    const elb = new THREE.Mesh(elbGeo, steamPipeMat);
    elb.position.set(sgX, sgY + sgR + 0.50, sgZ);
    g.add(elb);

    // SG support structure (saddle supports)
    const legMat = new THREE.MeshStandardMaterial({ color: 0x556677, roughness: 0.55, metalness: 0.45 });
    for (const off of [-sgLen*0.28, sgLen*0.28]) {
      // vertical leg
      const legG = new THREE.CylinderGeometry(0.018, 0.022, sgY + 0.55, 8);
      const leg = new THREE.Mesh(legG, legMat);
      leg.position.set(sgX + pdx*off, sgY - (sgY+0.55)/2 - 0.08, sgZ + pdz*off);
      g.add(leg);
      // cross brace
      const brG = new THREE.BoxGeometry(0.15, 0.015, 0.015);
      const br = new THREE.Mesh(brG, legMat);
      br.position.set(sgX + pdx*off, -0.55, sgZ + pdz*off);
      br.rotation.y = ang;
      g.add(br);
    }

    // === ГЦН (Main Circulation Pump) ===
    const pumpX = ca * pumpDist, pumpZ = sa * pumpDist, pumpY = -0.38;
    const pMat = new THREE.MeshStandardMaterial({ color: 0x7a8a9c, roughness: 0.30, metalness: 0.60, emissive: 0x000000 });
    const pumpBody = new THREE.Mesh(pumpBodyGeo, pMat);
    pumpBody.position.set(pumpX, pumpY, pumpZ);
    pumpBody.castShadow = true;
    g.add(pumpBody);

    // pump flanges
    for (const fy of [-0.09, 0.09]) {
      const pf = new THREE.Mesh(pumpFlangeGeo, flangeMat.clone());
      pf.position.set(pumpX, pumpY + fy, pumpZ);
      pf.rotation.x = Math.PI/2;
      g.add(pf);
    }
    // pump motor (tall cylinder on top)
    const motorGeo = new THREE.CylinderGeometry(0.055, 0.075, 0.30, 14);
    const motorMat = new THREE.MeshStandardMaterial({ color: 0x4a5a6a, roughness: 0.35, metalness: 0.55 });
    const motor = new THREE.Mesh(motorGeo, motorMat);
    motor.position.set(pumpX, pumpY + 0.26, pumpZ);
    motor.castShadow = true;
    g.add(motor);
    // motor cap
    const mcGeo = new THREE.SphereGeometry(0.055, 12, 8, 0, Math.PI*2, 0, Math.PI/2);
    const mc = new THREE.Mesh(mcGeo, motorMat);
    mc.position.set(pumpX, pumpY + 0.41, pumpZ);
    g.add(mc);

    // === HOT LEG (reactor -> SG, upper pipe) ===
    const hotStart = new THREE.Vector3(ca*(vesselR+0.05), nozzleH, sa*(vesselR+0.05));
    const hotCurve = new THREE.CatmullRomCurve3([
      hotStart,
      new THREE.Vector3(ca*0.65, nozzleH + 0.06, sa*0.65),
      new THREE.Vector3(ca*1.05, sgY + 0.15, sa*1.05),
      new THREE.Vector3(ca*1.35, sgY + 0.10, sa*1.35),
      new THREE.Vector3(sgX - ca*0.12, sgY + 0.06, sgZ - sa*0.12),
    ]);
    const hotTube = makeTube(hotCurve, makeHotMat());
    g.add(hotTube);

    // === COLD LEG (SG -> pump -> reactor, lower pipe) ===
    const coldCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(sgX - ca*0.12, sgY - 0.12, sgZ - sa*0.12),
      new THREE.Vector3(ca*1.35, 0.0, sa*1.35),
      new THREE.Vector3(ca*1.25, pumpY + 0.12, sa*1.25),
      new THREE.Vector3(pumpX + ca*0.02, pumpY + 0.05, pumpZ + sa*0.02),
      new THREE.Vector3(pumpX - ca*0.10, pumpY, pumpZ - sa*0.10),
      new THREE.Vector3(ca*0.75, -0.25, sa*0.75),
      new THREE.Vector3(ca*(vesselR+0.05), -0.18, sa*(vesselR+0.05)),
    ]);
    const coldTube = makeTube(coldCurve, makeColdMat());
    g.add(coldTube);

    // === NOZZLE stubs at vessel ===
    const nozGeo = new THREE.CylinderGeometry(pipeR+0.01, pipeR+0.01, 0.08, 12);
    const nozMat = new THREE.MeshStandardMaterial({ color: 0x99aabb, roughness: 0.4, metalness: 0.5 });
    const nozH = new THREE.Mesh(nozGeo, nozMat);
    nozH.position.set(ca*(vesselR+0.02), nozzleH, sa*(vesselR+0.02));
    nozH.rotation.z = Math.PI/2;
    nozH.rotation.y = -ang;
    g.add(nozH);
    const nozC = new THREE.Mesh(nozGeo, nozMat);
    nozC.position.set(ca*(vesselR+0.02), -0.18, sa*(vesselR+0.02));
    nozC.rotation.z = Math.PI/2;
    nozC.rotation.y = -ang;
    g.add(nozC);

    // === COMPONENT LABELS ===
    // SG label
    const sgLabel = makeLabel('SG-' + (i+1), 36);
    sgLabel.scale.set(0.5, 0.13, 1);
    sgLabel.material.opacity = 0.6;
    sgLabel.position.set(sgX, sgY - sgR - 0.15, sgZ);
    g.add(sgLabel);

    // Pump label
    const pumpLabel = makeLabel('MCP-' + (i+1), 32);
    pumpLabel.scale.set(0.45, 0.12, 1);
    pumpLabel.material.opacity = 0.5;
    pumpLabel.position.set(pumpX, pumpY - 0.22, pumpZ);
    g.add(pumpLabel);

    // steam indicator
    const steam = makeLabel('steam', 40);
    steam.scale.set(0.7, 0.18, 1);
    steam.material.opacity = 0.0;
    steam.position.set(sgX, sgY + 0.55, sgZ);
    g.add(steam);

    // === FLOW DOTS ===
    const dots = [];
    for (let k = 0; k < 14; k++) {
      const dm = new THREE.MeshStandardMaterial({ color: 0xeef4fa, roughness: 0.3, metalness: 0.0, emissive: 0x000000 });
      const d = new THREE.Mesh(dotGeo, dm);
      g.add(d);
      dots.push({ mesh: d, t: (k/14) });
    }

    scene.add(g);
    loops.push({
      group: g, hotCurve, coldCurve, hotTube, coldTube,
      pump: pumpBody, sg: sgBody, steam, dots,
      sgMat, pMat
    });
  }

  // === CARAVANS (shipments orbiting) ===
  const caravans = [];
  const capGeo = new THREE.CapsuleGeometry(0.06, 0.14, 4, 8);
  for (let i = 0; i < 10; i++) {
    const m = new THREE.MeshStandardMaterial({ color: 0x60a5fa, roughness: 0.3, metalness: 0.3, emissive: 0x000000 });
    const cap = new THREE.Mesh(capGeo, m);
    cap.rotation.z = Math.PI/2;
    scene.add(cap);
    caravans.push({ mesh: cap, phase: (i/10) * Math.PI*2, spd: 1.0 });
  }

  // === STATE ===
  let impactShakeUntil = 0;
  let rodPct = 0, flow = 0, steamFlow = 0;
  let sn = [true,true,true];
  let alarmsStr = '';
  let camAngle = 0;

  function resize(){
    const w = Math.max(1, host.clientWidth || 1);
    const h = Math.max(1, host.clientHeight || 1);
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    camera.aspect = w/h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  function lerp(a,b,t){ return a + (b-a)*t; }

  function tempColor(tempC){
    const t = Math.max(0, Math.min(1, (tempC - 20) / 160));
    const r = lerp(0x2d, 0xfb, t) / 255;
    const g = lerp(0xd4, 0x71, t) / 255;
    const b = lerp(0xbf, 0x85, t) / 255;
    return new THREE.Color(r,g,b);
  }

  async function poll(){
    try {
      const r = await fetch('/status');
      if (!r.ok) return;
      const st = await r.json();
      const z0 = st.zones && st.zones[0];
      const avgP = st.zones.reduce((s,z)=>s+z.power_pct,0) / Math.max(1, st.zones.length);

      const tempC = z0 ? z0.temp_c : 20;
      const p = z0 ? z0.power_pct : 0;
      rodPct = (st.control_rod_pct || 0);
      flow = (st.primary_flow_kg_s || 0);
      steamFlow = (st.steam_flow_kg_s || 0);
      sn = [!!st.sn_a_on, !!st.sn_b_on, !!st.sn_c_on];

      // vessel color changes with temperature
      const c = tempColor(tempC);
      vesselMat.emissive.copy(c).multiplyScalar(0.08);

      // core glow intensity based on power
      const pn = Math.max(0, Math.min(1, avgP / 100));
      coreGlow.intensity = pn * 2.5;
      coreGlow.color.copy(c);
      coreGlow2.intensity = pn * 1.2;

      const alarmStr = (st.alarms || []).join(' ');
      alarmsStr = alarmStr;
      if (alarmStr.includes('voronezh_moment')) {
        const blink = (Date.now() % 400) < 200;
        label.material.opacity = blink ? 1 : 0.2;
      } else {
        label.material.opacity = 0.9;
      }

      if (alarmStr.includes('containment_hit')) {
        impactShakeUntil = Date.now() + 2000;
        contMat.opacity = 0.15;
        contMat.color.setHex(0xaa4444);
      } else {
        contMat.opacity = 0.06;
        contMat.color.setHex(0x4466aa);
      }

      const spd = 0.5 + (avgP/100)*2.5;
      for (const cv of caravans) cv.spd = spd;
    } catch(e) {}
  }
  poll();
  setInterval(poll, 1000);

  const clock = new THREE.Clock();
  function animate(){
    requestAnimationFrame(animate);
    const dt = Math.min(0.05, clock.getDelta());
    const t = clock.elapsedTime;

    // slow orbit camera
    camAngle += dt * 0.06;
    const camR = 4.2;
    const camH = 2.6;
    const now = Date.now();
    const shake = now < impactShakeUntil;
    const sx = shake ? (Math.random()-0.5)*0.12 : 0;
    const sy = shake ? (Math.random()-0.5)*0.12 : 0;
    camera.position.set(
      Math.cos(camAngle) * camR + sx,
      camH + sy,
      Math.sin(camAngle) * camR
    );
    camera.lookAt(0, 0.1, 0);

    // control rods: insertion depth
    const ins = Math.max(0, Math.min(1, rodPct / 100));
    for (const rod of rods) {
      rod.mesh.position.y = rod.baseY - ins * 0.5;
    }

    // loops
    const loopOn = [sn[0], sn[0], sn[1], sn[2]];
    const flowN = Math.max(0, Math.min(1, flow / 15000));
    const steamN = Math.max(0, Math.min(1, steamFlow / 2000));
    const hot = alarmsStr.includes('temp_high');

    for (let i = 0; i < loops.length; i++) {
      const on = loopOn[i];
      const L = loops[i];

      // hot/cold pipe coloring
      L.hotTube.material.color.setHex(on ? 0xe8967a : 0x2a2025);
      L.hotTube.material.emissive.setHex(hot ? 0x3b0b0b : 0x000000);
      L.coldTube.material.color.setHex(on ? 0x6aaddb : 0x1a2530);
      L.coldTube.material.emissive.setHex(hot ? 0x150808 : 0x000000);

      // SG color
      L.sg.material.color.setHex(on ? 0xd4a853 : 0x3a3228);
      L.sg.material.emissive.setHex(on ? 0x1a1200 : 0x000000);

      // pump
      L.pump.material.color.setHex(on ? 0x8899aa : 0x2a2d33);
      L.pump.material.emissive.setHex(on ? 0x000000 : 0x110000);
      L.pump.rotation.y += dt * (on ? (0.8 + flowN * 6.0) : 0.1);

      // steam label
      L.steam.material.opacity = on ? (0.05 + steamN * 0.6) : 0.0;

      // flow dots
      for (const d of L.dots) {
        d.t = (d.t + dt * (on ? (0.12 + flowN * 0.85) : 0.02)) % 1.0;
        const tt = d.t;
        const p = tt < 0.5 ? L.hotCurve.getPointAt(tt*2) : L.coldCurve.getPointAt((tt-0.5)*2);
        d.mesh.position.copy(p);
        d.mesh.material.color.setHex(on ? 0xeef4fa : 0x333840);
        d.mesh.material.emissive.setHex(on ? (tt < 0.5 ? 0x331108 : 0x081833) : 0x000000);
      }
    }

    // caravans
    for (const cv of caravans) {
      const a = cv.phase + t * (cv.spd || 1);
      const r = 2.4 + 0.15*Math.sin(a*2);
      cv.mesh.position.set(Math.cos(a)*r, -0.65 + 0.05*Math.sin(a*3), Math.sin(a)*r);
      cv.mesh.lookAt(0, -0.5, 0);
    }

    renderer.render(scene, camera);
  }
  animate();
})();
</script>
</body>
</html>"##;
