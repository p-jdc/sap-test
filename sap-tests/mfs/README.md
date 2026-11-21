# Mock PLC: MFS PLC emulator (prototype)

Stands in for the PLCs of an automated warehouse controlled by SAP EWM's material flow system (MFS): conveyors, the
identification point, transfer car and stacker cranes. EWM sends warehouse tasks as telegrams over TCP; the emulator
moves the HUs through the layout and answers with telegrams, as the real automation would. It's meant for Dev and
Qual systems, which have no real automation.

**This is a prototype.** So far it has only run against the fake EWM in this folder, not against a real EWM.
The fake EWM exists only for the demo; the Mock PLC is what the app and the tests use.

In the app it is the **Mock PLC** page: start it there (mode _Wait for EWM_ or _Demo_), watch the warehouse, put
HUs in, switch devices off and trigger protocol faults. The app starts `server.mts` as its own process and talks
to it only through the control API.

## Try it

From `sap-tests`:

```sh
bun run mfs:demo            # the fake EWM drives SAP's example warehouse; every telegram is printed
bun run mfs:demo -- --all   # also shows acknowledgements and life telegrams
bun run test:mfs            # the tests (no browser, no SAP system)
bun run mfs:server          # the Mock PLC alone, waiting for an EWM to connect
```

`mfs:server` settings (environment): `MFS_SETUP` (default `sap-example`), `MFS_HOST`, `MFS_BASE_PORT` (first PLC
port, default 47101), `MFS_CONTROL_PORT` (default 47100), `MFS_SPEED` (time factor, default 1), `MFS_FAKE_EWM=1` (demo: also start
the fake EWM; its actions are under `/ewm` in the control API). Once ready it prints `MFS_READY {…}` with the ports.

## What's real and what's made up

| Part                                         | Status                                                                                                                                                                                                           |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Warehouse layout `setups/sap-example`        | SAP's MFS training example (SAP Learning, "Integrating a Material Flow System"): 3 aisles with stacker cranes, transfer car, identification point, clearing, goods issue, pick point. Travel times are invented. |
| Telegram layout `layouts/demo.telegram.json` | **Made up.** Real layouts come from the EWM Customizing of the PLC interface type and differ per project. The code reads any layout of this shape.                                                               |
| Protocol rules (`channel.mts`)               | Sequence numbers, acknowledgement with resend, duplicate detection, life telegrams: the usual MFS handshake. Exact rules (timeouts, which telegrams need an acknowledgement) come from the channel Customizing.  |
| Fake EWM (`fake-ewm.mts`)                    | Simplified stand-in for EWM: one task per stage, round-robin aisle choice, first free bin. Only there so the emulator can run without SAP.                                                                       |

## How it fits together

- `telegram.mts`: encodes and decodes fixed-length telegrams from a layout file; splits the TCP stream into telegrams.
- `channel.mts`: one communication channel (a TCP connection) with the protocol rules. Used by both sides.
- `setup.mts`: a mock setup, which combines layout, devices and the PLC each device belongs to, plus a check that
  each move is physically possible.
- `emulator.mts`: one TCP port per PLC; runs the devices (conveyor, identification point, transfer car, stacker
  crane); HTTP control API.
- `fake-ewm.mts`, `demo.mts`, `server.mts`: the EWM stand-in, the demo and the standalone emulator.

EWM decides the routes. The emulator only checks each task against the layout: a task between two places with no
physical connection is refused (`NORT`). In a real system this flags a routing Customizing error before it reaches
a real warehouse.

## Things a test or tester can do

| What                             | In code                                                                | Over HTTP                                       |
| -------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------- |
| Put an HU in at goods receipt    | `emulator.enter('100001')`                                             | `POST /hus {"hu":"100001"}`                     |
| Identification result for an HU  | `enter(hu, undefined, { idPoint: 'NORD' \| 'CONT' \| 'WGHT' })`        | `script` in the body, or `POST /hus/:hu/script` |
| Bin occupied on the next putaway | `{ binOccupied: true }`                                                | same                                            |
| Device down or up again          | `setDeviceStatus('SRM1', 'DOWN')`                                      | `POST /devices/SRM1/status {"status":"DOWN"}`   |
| Protocol faults                  | `setFaults('CONS', { dropAcks: 1, stopLife: true, disconnect: true })` | `POST /plcs/CONS/faults`                        |
| Read state, telegrams, events    | `state()`, `log()`, `events()`                                         | `GET /state`, `/log?since=n`, `/events?since=n` |

Result codes in confirmations: `OK`; `OCCU` (bin occupied); `NORT` (no physical connection); `WPLC` (task sent to
the wrong PLC); `NOHU` (HU not at the source).

## Scenarios

A scenario is a named script on top of a warehouse setup: what happens physically, and what EWM should do about
it. Files: `scenarios/<name>.json`, checked on load (`scenario.mts`). The Mock PLC runs them itself, so the same file
serves the app (choose one on the start card, or run one on a running Mock PLC), tests and demos.

```json
{
  "title": "Bin occupied on putaway",
  "description": "The stacker crane finds the destination bin full …",
  "setup": "sap-example",
  "modes": ["demo"],
  "steps": [{ "enter": "A", "binOccupied": true }, { "wait": { "hu": "A", "at": "bin" } }],
  "expect": [{ "hu": "A", "at": "A1-*", "notAt": "A1-01-01", "ewm": "stored" }]
}
```

| Step                                                                             | Does                                             |
| -------------------------------------------------------------------------------- | ------------------------------------------------ |
| `{ "enter": "A", "idPoint": "CONT", "binOccupied": true, "at": "GR-IN" }`        | HU A arrives (all but `enter` optional)          |
| `{ "wait": <condition>, "timeout": "30s" }`                                      | waits until the condition holds                  |
| `{ "check": <condition> }`                                                       | fails the run if the condition does not hold now |
| `{ "device": "SRM1", "status": "DOWN" }`                                         | a device fails or runs again                     |
| `{ "faults": "CONS", "dropAcks": 1, "stopLife": true, "disconnect": true }`      | protocol faults on a PLC                         |
| `{ "ewm": "retrieve", "hu": "A", "to": "GI" }`, `{ "ewm": "picked", "hu": "A" }` | what a clerk does in EWM (demo only)             |
| `{ "pause": "5s" }`                                                              | warehouse time, shortened by the speed           |

Conditions: `{ "hu": "A", "at": "bin" | "<point or bin>" | "A1-*", "notAt": …, "movingOn": "TCAR", "left": true,
"ewm": "stored" }`, `{ "telegram": { "type": "WTCO", "from": "SRM1", "fields": { "hu": "{A}", "result": "OCCU" } },
"count": 1 }`, `{ "event": "HU {A} IP → A1-IN" }`. Every step can have a `"title"`; otherwise one is written from the
step.

- HUs are named A, B, …; each run gives them numbers (300001 upward). `{A}` in a text stands for A's number.
- Waits react to every event and telegram, not to a poll: "when A is on its way, the crane fails" happens at the same
  moment at any speed.
- Expectations get a short settling time after the last step: EWM learns from telegrams a moment after the warehouse
  acted.
- `"modes": ["demo"]` scenarios start from an empty warehouse (`"fresh"`, default true). Against a real EWM that
  isn't possible: its stock must match the Mock PLC's, so such scenarios will need HUs created in EWM first and
  stock loaded from EWM (not built yet).

Control API: `GET /scenarios` (what this Mock PLC can run), `GET /scenario` (current or last run),
`POST /scenario/start {"name":…}`, `POST /scenario/pause`, `/resume`, `/stop`.

## Next steps

See the plan for the full design (device types, mock setups generated from EWM Customizing for all warehouses,
app UI, Kubernetes). Concretely, the next steps are:

1. A real telegram layout and the channel settings of one EWM test channel. Then connect the emulator to a real
   EWM Dev system.
2. EWM as TCP server (the emulator connects out), if that's how the channels are set up.
3. More device types (lift, sorter, in-line stations) and setups generated from Customizing.
4. A `mfs` fixture in sap-plugin for SAP tests, running scenarios (`mfs.runScenario(name)`).
5. Scenarios against a real EWM: HUs created in EWM first, stock loaded from EWM.
