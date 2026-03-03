mod actors;
mod handlers;
mod models;
mod sim;
mod state;
mod utils;

use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::sync::Arc;

use axum::routing::{get, post};
use axum::Router;
use tokio::sync::{mpsc, Mutex};
use tower_http::{cors::CorsLayer, services::ServeDir, trace::TraceLayer};
use tracing::info;

use crate::actors::{core_actor, safety_actor, ticker};
use crate::handlers::*;
use crate::state::{AppState, AuditState, CoreRequest, SafetyRequest};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let zones = 5;
    let zone_names: [&'static str; 5] = ["voronezh", "zhopa", "muhosransk", "zalupinsk", "kukuevo"];

    // wire: http -> safety -> core
    let (safety_tx, safety_rx) = mpsc::channel::<SafetyRequest>(256);
    let (core_tx, core_rx) = mpsc::channel::<CoreRequest>(256);

    tokio::spawn(safety_actor(zones, safety_rx, core_tx.clone()));
    tokio::spawn(core_actor(zones, zone_names.to_vec(), core_rx));
    tokio::spawn(ticker(core_tx.clone()));

    let state = AppState {
        safety_tx,
        core_tx,
        audit: Arc::new(Mutex::new(AuditState {
            clients: HashMap::new(),
            log: VecDeque::with_capacity(512),
        })),
    };

    let app = Router::new()
        .nest_service("/assets", ServeDir::new("public"))
        .route("/", get(ui_index))
        .route("/assets/voronezh.gif", get(asset_voronezh_gif))
        .route("/assets/medieval.mp3", get(asset_medieval_mp3))
        // htmx polling fragments
        .route("/ui/mode", get(ui_mode))
        .route("/ui/alarms", get(ui_alarms))
        .route("/ui/zones", get(ui_zones))
        .route("/ui/caravans", get(ui_caravans))
        .route("/ui/loot", get(ui_loot))
        .route("/ui/audit", get(ui_audit))
        .route("/ui/fw", get(ui_fw))
        // control actions
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
        .route("/ui/fw_active", post(ui_fw_active))
        .route("/ui/fw_auto", post(ui_fw_auto))
        // json api
        .route("/health", get(health))
        .route("/status", get(get_status))
        .route("/history", get(get_history))
        .route("/set_power", post(set_power))
        .route("/scram", post(scram))
        .route("/reset", post(reset))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr: SocketAddr = "0.0.0.0:8080".parse()?;
    info!(%addr, "http listening");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
