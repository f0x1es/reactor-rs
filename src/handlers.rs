use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::Html;
use axum::{Form, Json};
use serde::Deserialize;
use tokio::sync::oneshot;

use crate::models::*;
use crate::state::*;
use crate::utils::*;

// ── audited response helper ────────────────────────────────────────
// Every UI control handler needs: client tracking + hx-trigger + audit log.
// This struct captures that pattern in one place.

const HX_TRIGGER: HeaderName = HeaderName::from_static("hx-trigger");

struct Audited {
    headers: HeaderMap,
}

impl Audited {
    async fn new(st: &AppState, raw: &HeaderMap, action: &str, params: &str) -> Self {
        let (mut hm, cid, callsign) = ensure_client_headers(st, raw).await;
        hm.insert(HX_TRIGGER, HeaderValue::from_static("refresh"));
        audit_push(st, &cid, &callsign, action, params).await;
        Self { headers: hm }
    }

    fn ok(self, body: &'static str) -> Result<(HeaderMap, Html<&'static str>), StatusCode> {
        Ok((self.headers, Html(body)))
    }

    fn ok_string(self, body: String) -> Result<(HeaderMap, Html<String>), StatusCode> {
        Ok((self.headers, Html(body)))
    }
}

// ── read-only UI fragments (HTMX polling) ──────────────────────────

pub async fn ui_index(
    State(st): State<AppState>,
    headers: HeaderMap,
) -> (HeaderMap, Html<String>) {
    let (hm, _id, _cs) = ensure_client_headers(&st, &headers).await;
    let mut html = std::fs::read_to_string("public/index.html")
        .unwrap_or_else(|_| "<h1>404 index.html not found</h1>".to_string());

    // cache-bust local assets so normal reload picks up changes without ctrl+f5.
    let v = asset_ver(&[
        "public/style.css",
        "public/app.js",
        "public/scene.js",
        "public/index.html",
    ]);
    if v != 0 {
        let q = format!("?v={}", v);
        html = html
            .replace("/assets/style.css", &format!("/assets/style.css{}", q))
            .replace("/assets/app.js", &format!("/assets/app.js{}", q))
            .replace("/assets/scene.js", &format!("/assets/scene.js{}", q));
    }

    (hm, Html(html))
}

fn asset_ver(paths: &[&str]) -> u64 {
    use std::time::UNIX_EPOCH;

    let mut max_s: u64 = 0;
    for p in paths {
        if let Ok(md) = std::fs::metadata(p) {
            if let Ok(mt) = md.modified() {
                if let Ok(d) = mt.duration_since(UNIX_EPOCH) {
                    max_s = max_s.max(d.as_secs());
                }
            }
        }
    }
    max_s
}

pub async fn ui_mode(State(st): State<AppState>) -> Result<Html<&'static str>, StatusCode> {
    let status = fetch_status(&st).await?;
    Ok(Html(match status.mode {
        Mode::Idle => "idle",
        Mode::Running => "running",
        Mode::Scram => "scram",
    }))
}

pub async fn ui_alarms(State(st): State<AppState>) -> Result<Html<String>, StatusCode> {
    let status = fetch_status(&st).await?;
    if status.alarms.is_empty() {
        return Ok(Html("<span class=\"alarm-badge\">none</span>".into()));
    }

    let mut out = String::new();
    for a in status.alarms {
        let bad = a.contains("high") || a.contains("voronezh");
        let cls = if bad {
            "alarm-badge alarm-badge--bad"
        } else {
            "alarm-badge"
        };
        out.push_str(&format!(
            "<span class=\"{}\">{}</span>",
            cls,
            html_escape(&a)
        ));
    }
    Ok(Html(out))
}

pub async fn ui_zones(State(st): State<AppState>) -> Result<Html<String>, StatusCode> {
    let status = fetch_status(&st).await?;
    let mut out = String::new();
    for z in status.zones {
        let t_pct = ((z.temp_c - 20) * 1).clamp(0, 100);
        out.push_str(&format!(
            "<tr>\
               <td>{}</td>\
               <td>{}</td>\
               <td>{}%</td>\
               <td><div class=\"progress-group\">\
                 <span class=\"progress-label\">{}%</span>\
                 <div class=\"progress-bar\"><div class=\"progress-bar__fill\" style=\"width:{}%\"></div></div>\
               </div></td>\
               <td><div class=\"progress-group\">\
                 <span class=\"progress-label\">{}c</span>\
                 <div class=\"progress-bar\"><div class=\"progress-bar__fill progress-bar__fill--temp\" style=\"width:{}%\"></div></div>\
               </div></td>\
             </tr>",
            z.id,
            html_escape(z.name),
            z.target_power_pct,
            z.power_pct,
            z.power_pct,
            z.temp_c,
            t_pct,
        ));
    }
    Ok(Html(out))
}

pub async fn ui_loot(State(st): State<AppState>) -> Result<Html<String>, StatusCode> {
    let status = fetch_status(&st).await?;
    Ok(Html(format!("loot: {}", status.loot)))
}

pub async fn ui_caravans(State(st): State<AppState>) -> Result<Html<String>, StatusCode> {
    let status = fetch_status(&st).await?;
    if status.caravans.is_empty() {
        return Ok(Html(
            "<div class=\"text-hint\" style=\"padding:10px\">no caravans</div>".into(),
        ));
    }

    let mut out = String::from(
        "<table class=\"table table--caravans\">\
         <thead><tr><th>id</th><th>eta</th><th>value</th><th>state</th><th></th></tr></thead>\
         <tbody>",
    );
    for c in status.caravans {
        let action_cell = if c.state == CaravanState::Available {
            format!(
                "<td><button class=\"btn btn--fixed\" type=\"button\" \
                 hx-post=\"/ui/rob\" hx-vals=\"{{&quot;id&quot;:{}}}\" \
                 hx-target=\"#msg\" hx-swap=\"innerHTML\">rob</button></td>",
                c.id
            )
        } else {
            "<td><span class=\"btn-placeholder\"></span></td>".into()
        };
        out.push_str(&format!(
            "<tr><td>{}</td><td>{}s</td><td>{}</td><td>{}</td>{}</tr>",
            c.id,
            c.eta_s,
            c.value,
            html_escape(&c.state.to_string()),
            action_cell,
        ));
    }
    out.push_str("</tbody></table>");
    Ok(Html(out))
}

pub async fn ui_audit(
    State(st): State<AppState>,
    headers: HeaderMap,
) -> (HeaderMap, Html<String>) {
    let (hm, _cid, _callsign) = ensure_client_headers(&st, &headers).await;

    let guard = st.audit.lock().await;
    let mut out = String::new();
    for e in guard.log.iter().rev().take(24) {
        out.push_str(&format!(
            "<div class=\"audit-log__line\">\
               <span class=\"audit-log__ts\" data-ts=\"{}\">{}</span> \
               <span class=\"audit-log__cs\">{}</span> \
               <span class=\"audit-log__ac\">{}</span> \
               <span class=\"audit-log__pa\">{}</span>\
             </div>",
            e.ts_s,
            e.ts_s,
            html_escape(&e.callsign),
            html_escape(&e.action),
            html_escape(&e.params),
        ));
    }
    (hm, Html(out))
}

// ── control handlers (audited) ─────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct SetPowerForm {
    zone: usize,
    target_power_pct: u8,
}

pub async fn ui_set_power(
    State(st): State<AppState>,
    headers: HeaderMap,
    Form(req): Form<SetPowerForm>,
) -> Result<(HeaderMap, Html<&'static str>), StatusCode> {
    let a = Audited::new(
        &st,
        &headers,
        "set_power",
        &format!("zone={} target={}%", req.zone, req.target_power_pct),
    )
    .await;

    // manual set_power disables auto (otherwise it fights the operator)
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
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;

    a.ok("accepted")
}

pub async fn ui_scram(
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Result<(HeaderMap, Html<&'static str>), StatusCode> {
    let a = Audited::new(&st, &headers, "scram", "az-5").await;

    let _ = st
        .core_tx
        .send(CoreRequest::SetAuto { enabled: false })
        .await;
    let _ = st.core_tx.send(CoreRequest::SetRod { rod_pct: 100 }).await;
    st.safety_tx
        .send(SafetyRequest::Scram)
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;

    a.ok("воронеж отменён")
}

pub async fn ui_reset(
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Result<(HeaderMap, Html<&'static str>), StatusCode> {
    let a = Audited::new(&st, &headers, "reset", "").await;

    let _ = st
        .core_tx
        .send(CoreRequest::SetAuto { enabled: false })
        .await;
    let _ = st.core_tx.send(CoreRequest::SetRod { rod_pct: 0 }).await;
    st.safety_tx
        .send(SafetyRequest::Reset)
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;

    a.ok("reset")
}

#[derive(Debug, Deserialize)]
pub struct AutoForm {
    enabled: Option<String>,
}

pub async fn ui_auto(
    State(st): State<AppState>,
    headers: HeaderMap,
    Form(req): Form<AutoForm>,
) -> Result<(HeaderMap, Html<String>), StatusCode> {
    let enabled = req.enabled.is_some();
    let a = Audited::new(
        &st,
        &headers,
        "auto",
        if enabled { "on" } else { "off" },
    )
    .await;

    st.core_tx
        .send(CoreRequest::SetAuto { enabled })
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;

    a.ok_string(if enabled {
        "auto: on".into()
    } else {
        "auto: off".into()
    })
}

#[derive(Debug, Deserialize)]
pub struct AutoSetpointForm {
    power_pct: u8,
}

pub async fn ui_auto_setpoint(
    State(st): State<AppState>,
    headers: HeaderMap,
    Form(req): Form<AutoSetpointForm>,
) -> Result<(HeaderMap, Html<&'static str>), StatusCode> {
    let a = Audited::new(&st, &headers, "auto_sp", &format!("{}%", req.power_pct)).await;

    st.core_tx
        .send(CoreRequest::SetAutoSetpoint {
            power_pct: req.power_pct,
        })
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;

    a.ok("set")
}

#[derive(Debug, Deserialize)]
pub struct RodForm {
    rod_pct: u8,
}

pub async fn ui_rod(
    State(st): State<AppState>,
    headers: HeaderMap,
    Form(req): Form<RodForm>,
) -> Result<(HeaderMap, Html<&'static str>), StatusCode> {
    let pct = req.rod_pct.min(100);
    let a = Audited::new(&st, &headers, "rod", &format!("{}%", pct)).await;

    st.core_tx
        .send(CoreRequest::SetRod { rod_pct: pct })
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;

    a.ok("set")
}

pub async fn ui_containment_hit(
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Result<(HeaderMap, Html<&'static str>), StatusCode> {
    let a = Audited::new(&st, &headers, "containment_hit", "").await;

    st.core_tx
        .send(CoreRequest::ContainmentHit)
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;

    a.ok("external impact")
}

pub async fn ui_pipe_rupture(
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Result<(HeaderMap, Html<&'static str>), StatusCode> {
    let a = Audited::new(&st, &headers, "pipe_rupture", "").await;

    st.core_tx
        .send(CoreRequest::PipeRupture)
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;

    a.ok("pipe rupture")
}

#[derive(Debug, Deserialize)]
pub struct FlowCtlForm {
    kg_s: u32,
}

pub async fn ui_charging(
    State(st): State<AppState>,
    headers: HeaderMap,
    Form(req): Form<FlowCtlForm>,
) -> Result<(HeaderMap, Html<&'static str>), StatusCode> {
    let a = Audited::new(&st, &headers, "charging", &format!("{} kg/s", req.kg_s)).await;

    st.core_tx
        .send(CoreRequest::SetCharging { kg_s: req.kg_s })
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;

    a.ok("set")
}

pub async fn ui_letdown(
    State(st): State<AppState>,
    headers: HeaderMap,
    Form(req): Form<FlowCtlForm>,
) -> Result<(HeaderMap, Html<&'static str>), StatusCode> {
    let a = Audited::new(&st, &headers, "letdown", &format!("{} kg/s", req.kg_s)).await;

    st.core_tx
        .send(CoreRequest::SetLetdown { kg_s: req.kg_s })
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;

    a.ok("set")
}

#[derive(Debug, Deserialize)]
pub struct RobForm {
    id: u64,
}

pub async fn ui_rob(
    State(st): State<AppState>,
    Form(req): Form<RobForm>,
) -> Result<([(HeaderName, &'static str); 1], Html<String>), StatusCode> {
    let (tx, rx) = oneshot::channel();
    st.core_tx
        .send(CoreRequest::RobCaravan {
            id: req.id,
            reply: tx,
        })
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;

    let msg = match rx.await.map_err(|_| StatusCode::SERVICE_UNAVAILABLE)? {
        Ok(v) => format!("robbed +{} loot", v),
        Err(e) => format!("rob failed: {}", html_escape(&e)),
    };

    Ok(([(HX_TRIGGER, "refresh")], Html(msg)))
}

// ── static assets ──────────────────────────────────────────────────

pub async fn asset_voronezh_gif() -> ([(HeaderName, &'static str); 1], &'static [u8]) {
    const GIF: &[u8] = include_bytes!("../assets/voronezh.gif");
    ([(header::CONTENT_TYPE, "image/gif")], GIF)
}

pub async fn asset_medieval_mp3() -> ([(HeaderName, &'static str); 1], &'static [u8]) {
    const MP3: &[u8] = include_bytes!("../assets/medieval.mp3");
    ([(header::CONTENT_TYPE, "audio/mpeg")], MP3)
}

// ── JSON API ───────────────────────────────────────────────────────

pub async fn health() -> StatusCode {
    StatusCode::OK
}

pub async fn get_status(State(st): State<AppState>) -> Result<Json<Status>, StatusCode> {
    Ok(Json(fetch_status(&st).await?))
}

pub async fn get_history(
    State(st): State<AppState>,
) -> Result<Json<Vec<HistoryPoint>>, StatusCode> {
    let (tx, rx) = oneshot::channel();
    st.core_tx
        .send(CoreRequest::GetHistory(tx))
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    Ok(Json(
        rx.await.map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?,
    ))
}

pub async fn set_power(
    State(st): State<AppState>,
    Json(req): Json<SetPowerRequest>,
) -> Result<StatusCode, (StatusCode, String)> {
    st.safety_tx
        .send(SafetyRequest::SetTargetPower {
            zone: req.zone,
            target_power_pct: req.target_power_pct,
        })
        .await
        .map_err(|_| (StatusCode::SERVICE_UNAVAILABLE, "safety offline".into()))?;
    Ok(StatusCode::ACCEPTED)
}

pub async fn scram(State(st): State<AppState>) -> Result<StatusCode, StatusCode> {
    st.safety_tx
        .send(SafetyRequest::Scram)
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    Ok(StatusCode::ACCEPTED)
}

pub async fn reset(State(st): State<AppState>) -> Result<StatusCode, StatusCode> {
    st.safety_tx
        .send(SafetyRequest::Reset)
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    Ok(StatusCode::ACCEPTED)
}

// ── internal ───────────────────────────────────────────────────────

async fn fetch_status(st: &AppState) -> Result<Status, StatusCode> {
    let (tx, rx) = oneshot::channel();
    st.safety_tx
        .send(SafetyRequest::GetStatus(tx))
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    rx.await.map_err(|_| StatusCode::SERVICE_UNAVAILABLE)
}
