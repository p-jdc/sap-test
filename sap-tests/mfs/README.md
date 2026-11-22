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

`mfs:server` settings (environment): `MFS_SETUP` (default `sap-example`), `MFS_HOST` (address of the PLC ports),
`MFS_BASE_PORT` (first PLC port, default 47101), `MFS_CONTROL_PORT` (default 47100), `MFS_SPEED` (time factor,
default 1), `MFS_FAKE_EWM=1` (demo: also start the fake EWM; its actions are under `/ewm` in the control API).
Once ready it prints `MFS_READY {…}` with the ports.

The control API puts HUs in, switches devices off and breaks connections, so it has its own address:
`MFS_CONTROL_HOST` (default `127.0.0.1`, this computer only). To reach it from elsewhere, as on the cluster, set
`MFS_CONTROL_HOST` and `MFS_CONTROL_TOKEN`; the emulator does not start with the first and without the second.
Every request then needs `Authorization: Bearer <token>`, except `GET /health`. Requests that change something
must be JSON (`content-type: application/json`). The app makes up a token for each emulator it starts; for one
that runs elsewhere (`MFS_EMULATOR_URL`), give the app its token as `MFS_EMULATOR_TOKEN`.

## What's real and what's made up

| Part                                         | Status                                                                                                                                                                                                           |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Warehouse layout `setups/sap-example`        | SAP's MFS training example (SAP Learning, "Integrating a Material Flow System"): 3 aisles with stacker cranes, transfer car, identification point, clearing, goods issue, pick point. Travel times are invented. |
| Telegram layout `layouts/demo.telegram.json` | **Made up.** Real layouts come from the EWM Customizing of the PLC interface type and differ per project. Everything about the telegrams is read from the layout file (see "Telegram layout").                   |
| Protocol rules (`channel.mts`)               | Sequence numbers, acknowledgement with resend, duplicate detection, life telegrams. How a telegram is acknowledged comes from the layout file; timeouts come from the channel Customizing.                       |
| Fake EWM (`fake-ewm.mts`)                    | Simplified stand-in for EWM: one task per stage, round-robin aisle choice, first free bin. Only there so the emulator can run without SAP.                                                                       |

## Telegram layout

One file per PLC interface type, `layouts/<name>.telegram.json`. A setup names its layout in `telegramLayout`.
The code holds no telegram names, field names or result codes: a layout with other names needs a new file, not
new code. `tests/_mfs/foreign-layout.mts` is a second, deliberately different layout that the tests run a whole
putaway with.

| Part                     | What it decides                                                                                                                                                                                                                                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `header`, `telegrams`    | The fields of the header and of each telegram type, with their lengths. `"type": "numc"` is digits padded with zeros; everything else is padded with `fill`.                                                                                                                                                                                                |
| `start`, `end`, `length` | Where a telegram ends. With `end`: at that character. Without: after `length` characters (every telegram is filled up to it), or, without `length`, after the length of its type. `start` is optional in all three.                                                                                                                                         |
| `roles`                  | Which header fields hold sender, receiver, sequence number and type, and which type is the life telegram. Sequence numbers run up to the largest number the field holds.                                                                                                                                                                                    |
| `handshake`              | `{ "mode": "telegram", "type", "seqField" }`: acknowledged with a telegram of its own that names the sequence number. `{ "mode": "echo", "field", "request", "confirm", "swapAddresses" }`: the telegram itself is sent back with the header field changed from `request` to `confirm`; `swapAddresses` (default true) exchanges sender and receiver in it. |
| `messages`               | What the telegrams mean: `task`, `confirmation`, and optionally `scan` and `status`. Each has the telegram `type`, `fields` (the emulator's name → the layout's field) and `codes` (the emulator's result → the code sent).                                                                                                                                 |

In `messages`, a field that is left out is neither sent nor read (a task without a task number, for example). A
result without a code of its own is sent as `codes.error`. Without `status`, device failures are not reported;
a setup with an identification point needs `scan`. The emulator's results are `ok`, `noRoute`, `wrongPlc`, `noHu`
and `occupied` for a confirmation, `ok`, `noRead`, `contour` and `overweight` for a scan, `up` and `down` for a
status. A layout file with a wrong reference (a field or type that does not exist), a code or handshake value that
does not fit its field, or a confirmation that names neither its task number nor its move is refused when it is
read, with every problem listed.

Not covered yet: acknowledgements that send back only the header, telegrams in both directions of one type with
different fields, and binary fields.

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

## In tests: the `mfs` fixture

```ts
import { test, expect } from '../../sap-plugin/mfs';

test('crane failure: the waiting HU is stored once the crane runs again', async ({ mfs, page }) => {
  const result = await mfs.runScenario('crane-down');
  // result.hus.A is the HU number the scenario used: check in EWM what became of it.
});
```

- `runScenario(name | scenario, { timeout, expectPass })` starts the scenario (a file in `scenarios/`, or one written
  in the test), follows it and returns the run: status, steps, expected results, HU numbers.
- Each scenario step is a step in the Playwright report. The run is attached to the test.
- The test fails with the failed step or the unmet expectation. `{ expectPass: false }` returns the failed run
  instead.
- A scenario still running when the test ends is stopped.
- Which Mock PLC: `MFS_EMULATOR_URL` (and `MFS_EMULATOR_TOKEN` when it needs one), the same settings the app uses.
  With `MFS_MOCK=1` (`bun run test:mfs`), Playwright starts a local one with the simulated EWM. Without either, tests
  with the fixture are skipped.

## Next steps

See the plan for the full design (device types, mock setups generated from EWM Customizing for all warehouses,
app UI, Kubernetes). Concretely, the next steps are:

1. A real telegram layout and the channel settings of one EWM test channel. Then connect the emulator to a real
   EWM Dev system.
2. EWM as TCP server (the emulator connects out), if that's how the channels are set up.
3. More device types (lift, sorter, in-line stations) and setups generated from Customizing.
4. Scenarios against a real EWM: HUs created in EWM first, stock loaded from EWM.
