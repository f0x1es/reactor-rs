use std::time::{SystemTime, UNIX_EPOCH};

use axum::http::header;

use crate::state::{AppState, AuditEntry, ClientInfo};

pub fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

pub fn prng_u32(state: &mut u32) -> u32 {
    let mut x = *state;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    *state = x;
    x
}

pub fn prng_noise(state: &mut u32, amp: f64) -> f64 {
    let v = prng_u32(state) as f64 / (u32::MAX as f64);
    (v * 2.0 - 1.0) * amp
}

pub fn now_s() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn parse_cookie(headers: &axum::http::HeaderMap, key: &str) -> Option<String> {
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

pub fn make_client_id(seed: u32) -> String {
    format!("{:08x}{:08x}", seed, seed.rotate_left(13))
}

pub fn make_callsign(seed: u32) -> String {
    const ADJ: [&str; 12] = [
        "rusty", "cold", "hot", "lazy", "fast", "grim", "wild", "calm", "blind", "sharp",
        "heavy", "tiny",
    ];
    const NOUN: [&str; 12] = [
        "owl", "pump", "valve", "rod", "steam", "pipe", "diesel", "loop", "core", "cond", "sg",
        "gcn",
    ];

    let a = ADJ[(seed as usize) % ADJ.len()];
    let n = NOUN[((seed >> 8) as usize) % NOUN.len()];
    let num = (seed % 97) + 3;
    format!("operator {}-{}-{}", a, n, num)
}

pub async fn ensure_client_headers(
    st: &AppState,
    headers: &axum::http::HeaderMap,
) -> (axum::http::HeaderMap, String, String) {
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

    let callsign = {
        let mut guard = st.audit.lock().await;
        let ts = now_s();

        let ttl_s = 24 * 3600;
        guard
            .clients
            .retain(|_, v| ts.saturating_sub(v.last_seen_s) <= ttl_s);
        if guard.clients.len() > 200 {
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

        let ent = guard
            .clients
            .entry(cid.clone())
            .or_insert_with(|| ClientInfo {
                callsign: make_callsign(seed ^ 0x9e3779b9),
                last_seen_s: ts,
            });
        ent.last_seen_s = ts;
        ent.callsign.clone()
    };

    (out, cid, callsign)
}

pub async fn audit_push(st: &AppState, cid: &str, callsign: &str, action: &str, params: &str) {
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

    if let Some(ci) = guard.clients.get_mut(cid) {
        ci.last_seen_s = now_s();
    }
}
