use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Idle,
    Running,
    Scram,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DieselState {
    Off,
    Starting,
    Online,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CaravanState {
    EnRoute,
    Available,
    Robbed,
}

impl std::fmt::Display for CaravanState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EnRoute => f.write_str("en_route"),
            Self::Available => f.write_str("available"),
            Self::Robbed => f.write_str("robbed"),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ZoneStatus {
    pub id: usize,
    pub name: &'static str,
    pub target_power_pct: u8,
    pub power_pct: u8,
    pub temp_c: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct CaravanStatus {
    pub id: u64,
    pub eta_s: i32,
    pub value: u32,
    pub state: CaravanState,
}

#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub mode: Mode,
    pub zones: Vec<ZoneStatus>,
    pub alarms: Vec<String>,
    pub loot: u32,
    pub caravans: Vec<CaravanStatus>,
    pub last_event: String,

    // control/state shown in ui
    pub auto_enabled: bool,
    pub auto_setpoint_power_pct: u8,
    pub temp_limit_c: i32,
    pub control_rod_pct: u8,

    // vv-er/pwr-ish plant state (toy)
    pub power_th_mw: i32,
    pub power_el_mw: i32,
    pub primary_t_hot_c: i32,
    pub primary_t_cold_c: i32,
    pub primary_flow_kg_s: i32,
    pub primary_pressure_bar: i32,
    pub steam_flow_kg_s: i32,
    pub secondary_feed_temp_c: i32,
    pub secondary_steam_temp_c: i32,
    pub cond_vac_kpa_abs: i32,

    // kip (elemer) - dual channels a/b with independent noise
    pub kip_a_primary_t_hot_c: i32,
    pub kip_a_primary_t_cold_c: i32,
    pub kip_a_primary_flow_kg_s: i32,
    pub kip_a_power_th_mw: i32,
    pub kip_b_primary_t_hot_c: i32,
    pub kip_b_primary_t_cold_c: i32,
    pub kip_b_primary_flow_kg_s: i32,
    pub kip_b_power_th_mw: i32,

    // power supply (toy)
    pub grid_power_on: bool,
    pub sn_a_on: bool,
    pub sn_b_on: bool,
    pub sn_c_on: bool,
    pub diesel_a: DieselState,
    pub diesel_b: DieselState,
    pub diesel_c: DieselState,

    // failures/protection (toy)
    pub az_failed: bool,
    pub saoz_active: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct HistoryPoint {
    pub t_s: u32,
    pub mode: Mode,

    // kept for ui charts compatibility
    pub avg_power_pct: u8,
    pub max_temp_c: i32,
    pub voronezh_power_pct: u8,
    pub voronezh_temp_c: i32,

    // pwr-ish telemetry (toy)
    pub power_th_mw: i32,
    pub power_el_mw: i32,
    pub primary_t_hot_c: i32,
    pub primary_t_cold_c: i32,
    pub primary_flow_kg_s: i32,
    pub primary_pressure_bar: i32,
    pub steam_flow_kg_s: i32,
    pub secondary_feed_temp_c: i32,
    pub secondary_steam_temp_c: i32,

    // power supply
    pub grid_power_on: bool,
    pub sn_on: u8,
}

#[derive(Debug, Deserialize)]
pub struct SetPowerRequest {
    pub zone: usize,
    pub target_power_pct: u8,
}

