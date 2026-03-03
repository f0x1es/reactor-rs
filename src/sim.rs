use std::collections::VecDeque;

use crate::models::*;
use crate::utils::prng_noise;

// ── constants ──────────────────────────────────────────────────────

const NOMINAL_POWER_MW: f64 = 3000.0;
const MAX_RAMP_PCT_PER_TICK: f64 = 3.0;
const HISTORY_CAP: usize = 300;

// primary circuit
const CP_WATER: f64 = 5000.0; // J/(kg·K), water-ish
const NOMINAL_FLOW_KG_S: f64 = 15000.0;
const SCRAM_FLOW_KG_S: f64 = 9000.0;
const PRESSURE_SETPOINT_BAR: f64 = 155.0;
const RELIEF_THRESHOLD_BAR: f64 = 170.0;
const RELIEF_DROP_BAR: f64 = 2.5;

// auto protection
const TEMP_LIMIT_C: i32 = 330;
const AUTO_SCRAM_OFFSET_C: i32 = 20;

// condenser / environment
const ENV_TEMP_C: f64 = 30.0;
const CONDENSER_K: f64 = 0.06;

// power supply
const NUM_LOOPS: usize = 4;
const NUM_SECTIONS: usize = 3;

// ── caravan (was a tuple) ──────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct Caravan {
    pub id: u64,
    pub eta: i32,
    pub value: u32,
    pub state: CaravanState,
}

impl Caravan {
    fn to_status(&self) -> CaravanStatus {
        CaravanStatus {
            id: self.id,
            eta_s: self.eta,
            value: self.value,
            state: self.state,
        }
    }
}

// ── reactor state ──────────────────────────────────────────────────

pub struct ReactorState {
    // zone config
    pub zones: usize,
    zone_names: Vec<&'static str>,

    // mode + per-zone setpoints
    mode: Mode,
    target_power: Vec<u8>,

    // derived zone instrumentation (for UI)
    power: Vec<i32>,
    temp: Vec<i32>,

    // plant (pwr/vver-ish)
    power_th_mw: f64,
    power_el_mw: f64,

    primary_t_hot_c: f64,
    primary_t_cold_c: f64,
    primary_pressure_bar: f64,
    primary_flow_kg_s: f64,

    charging_kg_s: f64,
    letdown_kg_s: f64,

    steam_flow_kg_s: f64,
    secondary_feed_temp_c: f64,
    secondary_steam_temp_c: f64,

    // kip noise seeds (dual channels)
    kip_seed_a: u32,
    kip_seed_b: u32,

    // operator controls
    auto_enabled: bool,
    auto_setpoint_power_pct: u8,
    control_rod_pct: u8,

    // power supply
    grid_power_on: bool,
    sn_on: [bool; NUM_SECTIONS],
    diesel_state: [DieselState; NUM_SECTIONS],
    diesel_t: [i32; NUM_SECTIONS],
    gcn_on: [bool; NUM_LOOPS],

    // events / failures
    containment_hit_ttl: i32,
    pipe_rupture_ttl: i32,
    az_failed_ttl: i32,
    saoz_active_ttl: i32,

    // game
    loot: u32,
    last_event: String,
    caravans: Vec<Caravan>,
    caravan_next_id: u64,
    caravan_spawn_t: i32,

    // history
    tick_s: u32,
    history: VecDeque<HistoryPoint>,
}

impl ReactorState {
    pub fn new(zones: usize, zone_names: Vec<&'static str>) -> Self {
        Self {
            zones,
            zone_names,
            mode: Mode::Idle,
            target_power: vec![0; zones],
            power: vec![0; zones],
            temp: vec![25; zones],

            power_th_mw: 0.0,
            power_el_mw: 0.0,
            primary_t_hot_c: 290.0,
            primary_t_cold_c: 275.0,
            primary_pressure_bar: PRESSURE_SETPOINT_BAR,
            primary_flow_kg_s: NOMINAL_FLOW_KG_S,

            charging_kg_s: 0.0,
            letdown_kg_s: 0.0,

            steam_flow_kg_s: 0.0,
            secondary_feed_temp_c: 220.0,
            secondary_steam_temp_c: 260.0,

            kip_seed_a: 0x12345678,
            kip_seed_b: 0x87654321,

            auto_enabled: false,
            auto_setpoint_power_pct: 50,
            control_rod_pct: 0,

            grid_power_on: true,
            sn_on: [true; NUM_SECTIONS],
            diesel_state: [DieselState::Online; NUM_SECTIONS],
            diesel_t: [0; NUM_SECTIONS],
            gcn_on: [true; NUM_LOOPS],

            containment_hit_ttl: 0,
            pipe_rupture_ttl: 0,
            az_failed_ttl: 0,
            saoz_active_ttl: 0,

            loot: 0,
            last_event: "boot".into(),
            caravans: Vec::new(),
            caravan_next_id: 1,
            caravan_spawn_t: 5,

            tick_s: 0,
            history: VecDeque::with_capacity(HISTORY_CAP + 64),
        }
    }

    // ── commands (thin, no physics) ────────────────────────────────

    pub fn set_mode(&mut self, m: Mode) {
        if m == Mode::Scram {
            self.az_failed_ttl = 0;
            self.saoz_active_ttl = 0;
            self.control_rod_pct = 100;
        }
        self.mode = m;
    }

    pub fn set_target_power(&mut self, zone: usize, pct: u8) {
        if zone < self.zones {
            self.target_power[zone] = pct;
        }
    }

    pub fn set_auto(&mut self, enabled: bool) {
        self.auto_enabled = enabled;
        self.last_event = if enabled { "auto: on" } else { "auto: off" }.into();
    }

    pub fn set_auto_setpoint(&mut self, pct: u8) {
        self.auto_setpoint_power_pct = pct.min(100);
        self.last_event = format!("auto sp: {}%", self.auto_setpoint_power_pct);
    }

    pub fn set_rod(&mut self, pct: u8) {
        self.control_rod_pct = pct.min(100);
        self.last_event = format!("rod: {}%", self.control_rod_pct);
    }

    pub fn set_charging(&mut self, kg_s: u32) {
        self.charging_kg_s = (kg_s as f64).min(5000.0);
        self.last_event = format!("charging: {} kg/s", self.charging_kg_s.round() as i32);
    }

    pub fn set_letdown(&mut self, kg_s: u32) {
        self.letdown_kg_s = (kg_s as f64).min(5000.0);
        self.last_event = format!("letdown: {} kg/s", self.letdown_kg_s.round() as i32);
    }

    // ── events ─────────────────────────────────────────────────────

    pub fn containment_hit(&mut self) {
        self.mode = Mode::Scram;
        self.auto_enabled = false;
        self.control_rod_pct = 100;
        self.grid_power_on = false;

        // drop 1-2 own-needs sections (deterministic from tick counter)
        let pick = (self.tick_s % 3) as usize;
        self.sn_on[pick] = false;
        if (self.tick_s % 2) == 0 {
            self.sn_on[(pick + 1) % NUM_SECTIONS] = false;
        }
        for i in 0..NUM_SECTIONS {
            if !self.sn_on[i] {
                self.diesel_state[i] = DieselState::Off;
                self.diesel_t[i] = 0;
            }
        }

        self.containment_hit_ttl = 90;
        self.last_event = "containment hit".into();
        self.zero_all_targets();
    }

    pub fn pipe_rupture(&mut self) {
        self.mode = Mode::Scram;
        self.auto_enabled = false;
        self.control_rod_pct = 100;
        self.primary_pressure_bar = 30.0;
        self.primary_flow_kg_s = 1200.0;
        self.saoz_active_ttl = 120;
        self.pipe_rupture_ttl = 120;
        self.last_event = "pipe rupture".into();
        self.zero_all_targets();
    }

    pub fn rob_caravan(&mut self, id: u64) -> Result<u32, String> {
        for c in &mut self.caravans {
            if c.id == id {
                if c.state != CaravanState::Available {
                    return Err("not available".into());
                }
                self.loot = self.loot.saturating_add(c.value);
                self.last_event = format!("robbed caravan {} (+{})", id, c.value);
                c.state = CaravanState::Robbed;
                return Ok(c.value);
            }
        }
        Err("not found".into())
    }

    // ── tick (physics simulation) ──────────────────────────────────

    pub fn tick(&mut self) {
        let sp_pct = self.effective_setpoint();
        self.step_gcn_from_sections();

        let gcn_running = self.gcn_on.iter().filter(|v| **v).count() as u8;
        let gcn_factor = Self::gcn_power_factor(gcn_running);
        let rod_factor = (100u8.saturating_sub(self.control_rod_pct) as f64) / 100.0;
        let eff_sp_pct = (sp_pct * rod_factor * gcn_factor).clamp(0.0, 100.0);

        // ramp thermal power
        let cur_pct = (self.power_th_mw / NOMINAL_POWER_MW * 100.0).clamp(0.0, 100.0);
        let dp = (eff_sp_pct - cur_pct).clamp(-MAX_RAMP_PCT_PER_TICK, MAX_RAMP_PCT_PER_TICK);
        let next_pct = (cur_pct + dp).clamp(0.0, 100.0);
        self.power_th_mw = (next_pct / 100.0) * NOMINAL_POWER_MW;

        // primary flow
        self.step_primary_flow(gcn_running);

        // heat transfer
        self.step_core_heating();
        self.step_sg_cooling();
        self.step_charging_letdown();
        self.step_pressure();
        self.step_secondary();

        // power supply
        self.step_diesels();

        // event TTL countdown
        self.step_event_ttls();

        // saoz forces power down
        if self.saoz_active_ttl > 0 {
            self.power_th_mw = (self.power_th_mw - 250.0).max(0.0);
        }

        // gcn loss protection
        if gcn_running <= 1 {
            self.force_cold_shutdown();
        }

        // auto temperature protection
        if self.auto_enabled {
            self.step_auto_protection();
        }

        // derive per-zone instrumentation from plant state
        self.derive_zone_instrumentation(next_pct);

        // caravans
        self.step_caravans();

        // history
        self.push_history();
    }

    // ── status snapshot ────────────────────────────────────────────

    pub fn status(&mut self) -> Status {
        let zones_status = self.build_zones_status();
        let mut alarms = self.compute_alarms(&zones_status);

        // kip dual-channel noise
        let (kip_a, kip_b) = self.compute_kip();
        if (kip_a.t_hot - kip_b.t_hot).abs() >= 8
            || (kip_a.flow - kip_b.flow).abs() >= 600
        {
            alarms.push("kip_mismatch".into());
        }

        Status {
            mode: self.mode,
            zones: zones_status,
            alarms,
            loot: self.loot,
            caravans: self.caravans.iter().map(Caravan::to_status).collect(),
            last_event: self.last_event.clone(),
            auto_enabled: self.auto_enabled,
            auto_setpoint_power_pct: self.auto_setpoint_power_pct,
            temp_limit_c: TEMP_LIMIT_C,
            control_rod_pct: self.control_rod_pct,
            power_th_mw: self.power_th_mw.round() as i32,
            power_el_mw: self.power_el_mw.round() as i32,
            primary_t_hot_c: self.primary_t_hot_c.round() as i32,
            primary_t_cold_c: self.primary_t_cold_c.round() as i32,
            primary_flow_kg_s: self.primary_flow_kg_s.round() as i32,
            primary_pressure_bar: self.primary_pressure_bar.round() as i32,
            steam_flow_kg_s: self.steam_flow_kg_s.round() as i32,
            secondary_feed_temp_c: self.secondary_feed_temp_c.round() as i32,
            secondary_steam_temp_c: self.secondary_steam_temp_c.round() as i32,
            kip_a_primary_t_hot_c: kip_a.t_hot,
            kip_a_primary_t_cold_c: kip_a.t_cold,
            kip_a_primary_flow_kg_s: kip_a.flow,
            kip_a_power_th_mw: kip_a.power,
            kip_b_primary_t_hot_c: kip_b.t_hot,
            kip_b_primary_t_cold_c: kip_b.t_cold,
            kip_b_primary_flow_kg_s: kip_b.flow,
            kip_b_power_th_mw: kip_b.power,
            grid_power_on: self.grid_power_on,
            sn_a_on: self.sn_on[0],
            sn_b_on: self.sn_on[1],
            sn_c_on: self.sn_on[2],
            diesel_a: self.diesel_state[0],
            diesel_b: self.diesel_state[1],
            diesel_c: self.diesel_state[2],
            az_failed: self.az_failed_ttl > 0,
            saoz_active: self.saoz_active_ttl > 0,
        }
    }

    pub fn history(&self) -> Vec<HistoryPoint> {
        self.history.iter().cloned().collect()
    }

    // ── private: physics sub-steps ─────────────────────────────────

    fn effective_setpoint(&self) -> f64 {
        if self.mode == Mode::Scram {
            0.0
        } else if self.auto_enabled {
            self.auto_setpoint_power_pct as f64
        } else {
            *self.target_power.first().unwrap_or(&0) as f64
        }
    }

    fn step_gcn_from_sections(&mut self) {
        // section mapping: sn_a -> loops 0-1, sn_b -> loop 2, sn_c -> loop 3
        self.gcn_on[0] = self.sn_on[0];
        self.gcn_on[1] = self.sn_on[0];
        self.gcn_on[2] = self.sn_on[1];
        self.gcn_on[3] = self.sn_on[2];
    }

    fn gcn_power_factor(gcn_running: u8) -> f64 {
        match gcn_running {
            4 => 1.0,
            3 => 0.75,
            2 => 0.50,
            _ => 0.0,
        }
    }

    fn step_primary_flow(&mut self, gcn_running: u8) {
        let base = if self.mode == Mode::Scram {
            SCRAM_FLOW_KG_S
        } else {
            NOMINAL_FLOW_KG_S
        };
        let factor = match gcn_running {
            4 => 1.0,
            3 => 0.82,
            2 => 0.62,
            1 => 0.40,
            _ => 0.08,
        };
        self.primary_flow_kg_s = base * factor;

        if self.saoz_active_ttl > 0 {
            self.primary_flow_kg_s = self.primary_flow_kg_s.max(16000.0);
        }
    }

    fn step_core_heating(&mut self) {
        let dt = if self.primary_flow_kg_s <= 1.0 {
            0.0
        } else {
            (self.power_th_mw * 1_000_000.0) / (self.primary_flow_kg_s * CP_WATER)
        };
        let target = (self.primary_t_cold_c + dt).clamp(250.0, 360.0);
        self.primary_t_hot_c += (target - self.primary_t_hot_c) * 0.35;
    }

    fn step_sg_cooling(&mut self) {
        let sgs_running: u8 = NUM_LOOPS as u8; // all SGs assumed online
        let turb = (self.primary_flow_kg_s / NOMINAL_FLOW_KG_S).clamp(0.2, 1.4);
        let ua = 8.0 * (sgs_running as f64 / NUM_LOOPS as f64) * (0.85 + 0.35 * turb);
        let delta_t = (self.primary_t_hot_c - self.secondary_feed_temp_c).max(0.0);
        let q_sg = (ua * delta_t).min(self.power_th_mw).max(0.0);

        let dt = if self.primary_flow_kg_s <= 1.0 {
            0.0
        } else {
            (q_sg * 1_000_000.0) / (self.primary_flow_kg_s * CP_WATER)
        };
        let target = (self.primary_t_hot_c - dt).clamp(240.0, 340.0);
        self.primary_t_cold_c += (target - self.primary_t_cold_c) * 0.35;

        // secondary side
        let latent = 2_200_000.0_f64;
        self.steam_flow_kg_s = (q_sg * 1_000_000.0) / latent;
        self.power_el_mw = q_sg * 0.33;

        // steam temp
        self.secondary_steam_temp_c =
            (self.secondary_steam_temp_c + (q_sg / 40.0)).clamp(80.0, 340.0);
        let cond =
            CONDENSER_K * (0.5 + (self.steam_flow_kg_s / 2000.0).clamp(0.0, 1.5));
        self.secondary_steam_temp_c +=
            (ENV_TEMP_C - self.secondary_steam_temp_c) * cond;
    }

    fn step_charging_letdown(&mut self) {
        if self.charging_kg_s > 0.0 {
            let f =
                (self.charging_kg_s / (self.primary_flow_kg_s + self.charging_kg_s))
                    .clamp(0.0, 0.25);
            self.primary_t_cold_c =
                self.primary_t_cold_c * (1.0 - f) + self.secondary_feed_temp_c * f;
        }
    }

    fn step_pressure(&mut self) {
        let net = (self.charging_kg_s - self.letdown_kg_s).clamp(-5000.0, 5000.0);
        self.primary_pressure_bar += (net / 5000.0) * 1.8;
        self.primary_pressure_bar +=
            (PRESSURE_SETPOINT_BAR - self.primary_pressure_bar) * 0.02;

        if self.primary_pressure_bar > RELIEF_THRESHOLD_BAR {
            self.primary_pressure_bar -= RELIEF_DROP_BAR;
        }
        self.primary_pressure_bar = self.primary_pressure_bar.clamp(20.0, 180.0);
    }

    fn step_secondary(&mut self) {
        let feed_target =
            (ENV_TEMP_C + 15.0 + (self.power_el_mw / NOMINAL_POWER_MW) * 35.0)
                .clamp(40.0, 260.0);
        self.secondary_feed_temp_c +=
            (feed_target - self.secondary_feed_temp_c) * 0.22;
    }

    fn step_diesels(&mut self) {
        if self.grid_power_on {
            return;
        }
        for i in 0..NUM_SECTIONS {
            match self.diesel_state[i] {
                DieselState::Off => {
                    self.diesel_state[i] = DieselState::Starting;
                    self.diesel_t[i] = 30 + (i as i32) * 7;
                }
                DieselState::Starting => {
                    self.diesel_t[i] -= 1;
                    if self.diesel_t[i] <= 0 {
                        self.diesel_state[i] = DieselState::Online;
                        self.sn_on[i] = true;
                    }
                }
                DieselState::Online => {}
            }
        }
    }

    fn step_event_ttls(&mut self) {
        decrement(&mut self.containment_hit_ttl);
        decrement(&mut self.pipe_rupture_ttl);
        decrement(&mut self.az_failed_ttl);
        decrement(&mut self.saoz_active_ttl);
    }

    fn step_auto_protection(&mut self) {
        let hot = self.primary_t_hot_c.round() as i32;
        if hot >= TEMP_LIMIT_C {
            self.control_rod_pct = (self.control_rod_pct + 10).min(100);
            self.auto_setpoint_power_pct =
                self.auto_setpoint_power_pct.saturating_sub(10);
            self.last_event = format!("auto: temp limit hit ({}c)", hot);

            if hot >= TEMP_LIMIT_C + AUTO_SCRAM_OFFSET_C {
                self.mode = Mode::Scram;
                self.control_rod_pct = 100;
                self.zero_all_targets();
                self.last_event = "auto: scram".into();
            }
        } else if hot <= TEMP_LIMIT_C - 10 {
            self.control_rod_pct = self.control_rod_pct.saturating_sub(1);
        }
    }

    fn force_cold_shutdown(&mut self) {
        self.mode = Mode::Idle;
        self.control_rod_pct = 100;
        self.power_th_mw = 0.0;
        self.power_el_mw = 0.0;
        self.zero_all_targets();
        self.last_event = "cold shutdown: gcn loss".into();
    }

    fn derive_zone_instrumentation(&mut self, plant_pct: f64) {
        for z in 0..self.zones {
            let (bias_p, bias_t) = if z == 0 { (0.0, 0.0) } else { (-10.0, -15.0) };
            self.power[z] = (plant_pct + bias_p).clamp(0.0, 100.0).round() as i32;
            self.temp[z] = (self.primary_t_hot_c + bias_t).round() as i32;
        }
    }

    fn step_caravans(&mut self) {
        for c in &mut self.caravans {
            if c.eta > 0 {
                c.eta -= 1;
                if c.eta <= 0 {
                    c.state = CaravanState::Available;
                }
            }
        }

        self.caravan_spawn_t -= 1;
        if self.caravan_spawn_t <= 0 {
            let id = self.caravan_next_id;
            self.caravans.push(Caravan {
                id,
                eta: 8 + ((id as i32) % 5),
                value: 5 + ((id as u32) % 20),
                state: CaravanState::EnRoute,
            });
            self.caravan_next_id += 1;
            self.caravan_spawn_t = 10;
        }

        if self.caravans.len() > 12 {
            self.caravans.drain(0..(self.caravans.len() - 12));
        }
    }

    fn push_history(&mut self) {
        self.tick_s = self.tick_s.saturating_add(1);

        let max_temp = self.temp.iter().copied().max().unwrap_or(0);
        let avg_power = if self.power.is_empty() {
            0
        } else {
            self.power.iter().sum::<i32>() / (self.power.len() as i32)
        };
        let z0_power = *self.power.first().unwrap_or(&0);
        let z0_temp = *self.temp.first().unwrap_or(&20);
        let sn_count = self.sn_on.iter().filter(|v| **v).count() as u8;

        self.history.push_back(HistoryPoint {
            t_s: self.tick_s,
            mode: self.mode,
            avg_power_pct: avg_power.clamp(0, 100) as u8,
            max_temp_c: max_temp,
            voronezh_power_pct: z0_power.clamp(0, 100) as u8,
            voronezh_temp_c: z0_temp,
            power_th_mw: self.power_th_mw.round() as i32,
            power_el_mw: self.power_el_mw.round() as i32,
            primary_t_hot_c: self.primary_t_hot_c.round() as i32,
            primary_t_cold_c: self.primary_t_cold_c.round() as i32,
            primary_flow_kg_s: self.primary_flow_kg_s.round() as i32,
            primary_pressure_bar: self.primary_pressure_bar.round() as i32,
            steam_flow_kg_s: self.steam_flow_kg_s.round() as i32,
            secondary_feed_temp_c: self.secondary_feed_temp_c.round() as i32,
            secondary_steam_temp_c: self.secondary_steam_temp_c.round() as i32,
            grid_power_on: self.grid_power_on,
            sn_on: sn_count,
        });
        while self.history.len() > HISTORY_CAP {
            self.history.pop_front();
        }
    }

    // ── private: helpers ───────────────────────────────────────────

    fn zero_all_targets(&mut self) {
        self.target_power.fill(0);
    }

    fn build_zones_status(&self) -> Vec<ZoneStatus> {
        (0..self.zones)
            .map(|id| ZoneStatus {
                id,
                name: self.zone_names.get(id).copied().unwrap_or("zone"),
                target_power_pct: self.target_power[id],
                power_pct: self.power[id].clamp(0, 100) as u8,
                temp_c: self.temp[id],
            })
            .collect()
    }

    fn compute_alarms(&self, zones: &[ZoneStatus]) -> Vec<String> {
        let mut alarms = Vec::new();

        let max_temp = zones.iter().map(|z| z.temp_c).max().unwrap_or(0);
        if max_temp >= TEMP_LIMIT_C {
            alarms.push("temp_high".into());
        }

        if zones.iter().any(|z| z.name == "voronezh" && z.power_pct > 69) {
            alarms.push("voronezh_moment".into());
        }

        if self.mode == Mode::Scram {
            alarms.push("scram_active".into());
        }
        if self.containment_hit_ttl > 0 {
            alarms.push("containment_hit".into());
        }
        if self.pipe_rupture_ttl > 0 {
            alarms.push("pipe_rupture".into());
        }
        if self.az_failed_ttl > 0 {
            alarms.push("az_failed".into());
        }
        if self.saoz_active_ttl > 0 {
            alarms.push("saoz_active".into());
        }
        if !self.grid_power_on {
            alarms.push("power_lost".into());
        }

        alarms
    }

    fn compute_kip(&mut self) -> (KipChannel, KipChannel) {
        let a = KipChannel {
            t_hot: (self.primary_t_hot_c + prng_noise(&mut self.kip_seed_a, 1.2)).round() as i32,
            t_cold: (self.primary_t_cold_c + prng_noise(&mut self.kip_seed_a, 1.2)).round()
                as i32,
            flow: (self.primary_flow_kg_s + prng_noise(&mut self.kip_seed_a, 120.0)).round()
                as i32,
            power: (self.power_th_mw + prng_noise(&mut self.kip_seed_a, 25.0)).round() as i32,
        };

        let b_t_hot_raw =
            (self.primary_t_hot_c + prng_noise(&mut self.kip_seed_b, 1.6)).round() as i32;
        let b_t_cold_raw =
            (self.primary_t_cold_c + prng_noise(&mut self.kip_seed_b, 1.6)).round() as i32;
        let b = KipChannel {
            t_hot: b_t_hot_raw.max(a.t_hot + 1),
            t_cold: b_t_cold_raw.max(a.t_cold + 1),
            flow: (self.primary_flow_kg_s + prng_noise(&mut self.kip_seed_b, 160.0)).round()
                as i32,
            power: (self.power_th_mw + prng_noise(&mut self.kip_seed_b, 35.0)).round() as i32,
        };

        (a, b)
    }
}

// ── small helpers ──────────────────────────────────────────────────

struct KipChannel {
    t_hot: i32,
    t_cold: i32,
    flow: i32,
    power: i32,
}

fn decrement(v: &mut i32) {
    if *v > 0 {
        *v -= 1;
    }
}
