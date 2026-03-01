# pwr architecture (toy sim)

this project is a **toy/educational simulator** inspired by a pwr/vver plant layout.

it is **not** a real plant model and is intentionally missing/abstracting many details.

## current implementation

- server: rust + axum
- ui: htmx (partials) + chart.js (history) + three.js (3d)
- endpoints:
  - `GET /` ui
  - `GET /status` json snapshot of current state
  - `GET /history` json time series (recent window)

## plant blocks (concept)

### primary loop (1st circuit)

- `reactor_core` produces thermal power (heats primary coolant)
- `hot_leg` carries hot coolant to steam generator
- `steam_generator_primary` transfers heat to secondary side (two-medium heat exchanger)
- `cold_leg` carries cooled coolant back
- `main_circ_pump` (gcn) drives flow around the loop
- `pressurizer` sits on the primary loop to maintain pressure (in sim: abstract state + control)

energy flow: `reactor_core -> steam_generator_primary`

### secondary loop (2nd circuit)

- `steam_generator_secondary` receives heat and generates steam
- `steam_line -> turbine -> generator` converts steam enthalpy to electric power
- `condenser` is the heat sink (removes heat so sg can keep transferring)
- `feedwater_pump` returns feedwater to steam generator

energy flow: `steam_generator_secondary -> turbine/generator -> condenser`

## mapping to simulator state

minimal state variables used currently:

- core/primary:
  - `power_th_mw` (thermal)
  - `primary_t_hot_c`, `primary_t_cold_c`
  - `primary_flow_kg_s`
  - `control_rod_pct`
- secondary (toy):
  - `steam_flow_kg_s`
  - `power_el_mw`
  - `secondary_feed_temp_c`
  - `secondary_steam_temp_c`

## instrumentation (toy)

- elemer-like kip channels a/b: same parameter reported twice with small noise/drift.
- channel b temperature reads slightly higher than channel a.

## safety/controls (toy)

- `az-5` / scram: rods to 100%, setpoints to 0
- `auto`: holds a power setpoint and respects a temperature limit
- protection logic is deterministic; random noise is only for instrumentation.

## notes

- all numbers are placeholders unless explicitly documented otherwise.
- avoid copying real plant ttx/blueprints; keep it educational.
