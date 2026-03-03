# reactor-rs

safe toy "reactor" simulator + scada-ish http api.

## design

- actors: `safety_actor` gates all changes; `core_actor` owns mutable state
- runtime: tokio (`mpsc` + `oneshot`)
- api: axum http
- logs: tracing

## run

```bash
cd reactor-rs
cargo run
```

server listens on `0.0.0.0:8080`.

## docs

- `docs/pwr-architecture.md` - pwr block diagram + how it maps to the toy sim
- `docs/plan.md` - work plan / backlog

## api

- `GET /health` -> 200
- `GET /status` -> json status
- `GET /history` -> json recent time series
- `POST /set_power` -> `{ "zone": 0, "target_power_pct": 50 }`
- `POST /scram` -> enter scram + force target power 0
- `POST /reset` -> idle + target power 0

## safety

- denies `target_power_pct > 80`
- alarms: `temp_high` if any zone temp >= 120c, `scram_active` when scram mode

## ui notes

- when `temp_high` is active, ui enters a fire theme (`body.temp-high`)
- zone labels are meme names (`voronezh`, `zhopa`, `muhosransk`, `zalupinsk`, `kukuevo`)

## secondary loop notes

- nominal thermal power is 3600 mw (`src/sim.rs` `NOMINAL_POWER_MW`)
- generator output scales with condenser vacuum; vacuum is improved by an always-on steam-jet ejector model (with a small steam bleed penalty)
- 3d secondary view includes spray ponds + condenser ejector visuals (`public/scene.js`)
