use std::time::Duration;

use tokio::sync::{mpsc, oneshot};
use tracing::warn;

use crate::models::*;
use crate::sim::ReactorState;
use crate::state::*;

const MAX_POWER_PCT: u8 = 80;

pub async fn ticker(core_tx: mpsc::Sender<CoreRequest>) {
    let mut t = tokio::time::interval(Duration::from_millis(250));
    loop {
        t.tick().await;
        let _ = core_tx.send(CoreRequest::Tick).await;
    }
}

pub async fn safety_actor(
    zones: usize,
    mut rx: mpsc::Receiver<SafetyRequest>,
    core_tx: mpsc::Sender<CoreRequest>,
) {
    while let Some(msg) = rx.recv().await {
        match msg {
            SafetyRequest::SetTargetPower {
                zone,
                target_power_pct,
            } => match validate_target_power(zones, zone, target_power_pct, MAX_POWER_PCT) {
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

pub fn validate_target_power(
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

pub async fn core_actor(
    zones: usize,
    zone_names: Vec<&'static str>,
    mut rx: mpsc::Receiver<CoreRequest>,
) {
    let mut state = ReactorState::new(zones, zone_names);

    while let Some(msg) = rx.recv().await {
        match msg {
            CoreRequest::Tick => state.tick(),
            CoreRequest::SetMode(m) => state.set_mode(m),
            CoreRequest::SetTargetPower {
                zone,
                target_power_pct,
            } => state.set_target_power(zone, target_power_pct),
            CoreRequest::SetAuto { enabled } => state.set_auto(enabled),
            CoreRequest::SetAutoSetpoint { power_pct } => state.set_auto_setpoint(power_pct),
            CoreRequest::SetRod { rod_pct } => state.set_rod(rod_pct),
            CoreRequest::SetCharging { kg_s } => state.set_charging(kg_s),
            CoreRequest::SetLetdown { kg_s } => state.set_letdown(kg_s),
            CoreRequest::SetFeedwaterAuto => state.set_feedwater_auto(),
            CoreRequest::SetFeedwaterActive { pump } => state.set_feedwater_active(pump),
            CoreRequest::ContainmentHit => state.containment_hit(),
            CoreRequest::PipeRupture => state.pipe_rupture(),
            CoreRequest::RobCaravan { id, reply } => {
                let _ = reply.send(state.rob_caravan(id));
            }
            CoreRequest::GetStatus(reply) => {
                let _ = reply.send(state.status());
            }
            CoreRequest::GetHistory(reply) => {
                let _ = reply.send(state.history());
            }
        }
    }
}
