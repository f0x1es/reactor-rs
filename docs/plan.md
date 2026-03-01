# plan

## next (priority order)

1. **stabilize sim numbers**
   - stop temps from exploding (current toy model can spike unrealistically)
   - define consistent units + caps (c, %, etc)

2. **primary/secondary block state**
   - implement the pwr block diagram as structs: core/primary/sg/secondary/turbine
   - keep it 0d/multi-zone (no real plant ttx)

3. **auto controller v2**
   - replace rod-as-cap with a simple control loop
   - add scram thresholds: power_high/temp_high/period
   - gcn protection (egor spec):
     - 1 pump off -> power -25%
     - 2 pumps off -> power -50%
     - 3+ pumps off -> cold shutdown

4. **ui seriousness**
   - status lights panel (run/scram/temp_high/power_high)
   - dials/sliders: rods, flow (abstract), pressure (abstract)

5. **caravans v2 economy**
   - shipments vs rob (risk/reward)
   - upgrades store (pump/sensor/valve)
   - local persistence (localstorage)

6. **commission report**
   - after scram, generate a short incident timeline using /history

## done

- htmx ui + chart.js history + three.js 3d
- caravans basic + loot
- music toggle + local mp3
- docs: `docs/pwr-architecture.md`
