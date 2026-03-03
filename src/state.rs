use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, Mutex};
use crate::models::*;

#[derive(Debug)]
pub enum SafetyRequest {
    SetTargetPower { zone: usize, target_power_pct: u8 },
    SetUnsafeMode { enabled: bool },
    Scram,
    Reset,
    GetStatus(oneshot::Sender<Status>),
}

#[derive(Debug)]
pub enum CoreRequest {
    Tick,
    SetMode(Mode),
    SetTargetPower { zone: usize, target_power_pct: u8 },
    SetUnsafeMode { enabled: bool },
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
pub enum SafetyError {
    #[error("unknown zone {0}")]
    UnknownZone(usize),
    #[error("target power {target_power_pct}% exceeds max allowed {max_power_pct}%")]
    TargetPowerTooHigh {
        target_power_pct: u8,
        max_power_pct: u8,
    },
}

#[derive(Clone)]
pub struct AppState {
    pub safety_tx: mpsc::Sender<SafetyRequest>,
    pub core_tx: mpsc::Sender<CoreRequest>,
    pub audit: Arc<Mutex<AuditState>>,
}

#[derive(Debug, Clone)]
pub struct AuditEntry {
    pub ts_s: u64,
    pub callsign: String,
    pub action: String,
    pub params: String,
}

#[derive(Debug)]
pub struct ClientInfo {
    pub callsign: String,
    pub last_seen_s: u64,
}

#[derive(Debug)]
pub struct AuditState {
    pub clients: HashMap<String, ClientInfo>,
    pub log: VecDeque<AuditEntry>,
}

