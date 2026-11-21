# SAP Test Lab

A test app for the open-source SAP test automation described in *SAP-Testautomatisierung-Leitfaden*
(Playwright with SAP locators for Fiori/UI5, SAP WebGUI and SAP Ariba). It runs Playwright tests,
shows them as step flows, streams runs live, and tracks the pilot's exit criteria.

```
sap-test/
├── app/          SvelteKit 3 + Bun + UI5 Web Components – the Test-App
└── sap-tests/    SAP test project (guide §4), driven by the app
    ├── sap-plugin/   SAP locators for stock Playwright (ported from Playwright-SAP),
    │                 plus OData fixtures (sap-plugin/odata.ts)
    ├── odata/        Service metadata and the typed OData clients generated from it
    └── recorder/     Playwright-SAP fork, used for recording only
```

The tests run on stock Playwright. `sap-tests/sap-plugin` adds the SAP locators of the
[Playwright-SAP](https://github.com/ArpitSureka/playwright-sap) fork to it (`page.getByRoleUI5`,
`locateUI5`, `locateSID`, `getByRoleSID`, `SAPLogin`): the fork's selector engines, vendored
unchanged under Apache-2.0 and registered as custom selector engines. Specs import `test` and
`expect` from `sap-plugin` instead of `@playwright/test`.

Passwords are typed with `fillSecret(locator, value)` from `sap-plugin` (`SAPLogin` does this
itself), never with `fill`: Playwright writes a filled value into the step title, and so into the
HTML report of every run. `fillSecret` hands the value to the password field through a one-time
page binding instead. The app also masks every password it knows of in the run state and log it
keeps.

### Signing in once per run

A Playwright trace records the password of any browser login: the page snapshots show the filled
field and the network log the login request. So the tests do not sign in themselves. Two setup
projects in `sap-tests/playwright.config.ts` sign in once per run, with trace and video off, and
save the session in `sap-tests/.auth/` (gitignored):

| Project | Tests | Signs in with | Session |
| --- | --- | --- | --- |
| `sap` | `tests/fiori` (not `demokit`), `tests/webgui`, `tests/_reference` | `setup/sap.setup.ts`: `SAPLogin` with `SAP_URL`, `SAP_USERNAME`, `SAP_PASSWORD` | `.auth/sap-session.json` |
| `ariba` | `tests/ariba` | `setup/ariba.setup.ts`: `ARIBA_URL`, `ARIBA_USER`, `ARIBA_PASS` | `.auth/ariba-session.json` |
| `chromium` | everything else (`_demo`, `_plugin`, `api`, `fiori/demokit`) | – | – |

The tests of the `sap` and `ariba` projects start signed in. `page.SAPLogin(…)` stays in the
specs and in recordings, but with a saved session it only opens the URL. A login page there means
the session has expired, which fails the test instead of typing the password into its trace. A
setup project runs only when a selected test needs it (also with a file or `--grep` filter). If it
fails, the tests that need it do not run, and the Results page says so. With `--no-deps`, or for a
second test user signing in within a test, the password is typed in a traced test again.

A trace still holds the session cookies, which are valid until the SAP session ends. Treat
`app/.data/runs` and `sap-tests/.auth` as secret.

The fork itself (Playwright 1.53) is installed in `sap-tests/recorder` and used for recording
only, because its codegen is what writes SAP locators. The app starts it for "Record a test" and
then points the recorded spec's import at `sap-plugin`. The app never imports Playwright itself;
it starts both CLIs with real Node.

## What the app does

The app speaks plain language by default, so people who do not write tests can run them and read
the results: steps read as sentences ("Enter “1000” in “Sold-To Party”"), a failed test shows the
screen it stopped on, and the home page walks through the first steps. The **Technical details**
switch in the top bar (remembered per browser) adds what test authors need: file names and lines,
locators, source code, timelines, logs and the references to the guide. The table lists both.

| Page | What it shows |
| --- | --- |
| Home | Getting-started steps, whether the test tools and the SAP connection are ready, number of tests per SAP application, latest result, **reliability**: consecutive passes per test against the guide's 10-in-a-row criterion (§4.8). Technical details: Playwright, recorder and Node version, which `.env` values are set (never their values) |
| Tests | Every spec under `sap-tests/tests`, grouped by SAP application (Fiori / WebGUI / Ariba / Demo), with the **quality check** from the guide's rules file (§5.2): CSS/XPath on SAP screens, `waitForTimeout`, missing assertion after a save, literal passwords, passwords typed with `fill` instead of `fillSecret`, unreviewed `KI-generiert` tests |
| Steps (per test) | The test parsed into a step graph (Svelte Flow), each step as a sentence. Overlay of any run: passed / failed / not reached per step with timings, live while a run is in progress. Technical details: action, locator type (UI5 / SID / SID path / role / CSS…), value, helper used, and the source panel with the selected step highlighted |
| Results | Run history; per run: live progress, error, screenshot, video, step-by-step replay (the Playwright trace viewer) and the full HTML report. Technical details: per-test step timeline and the raw log |
| Record a test | Starts the Playwright-SAP recorder (`playwright codegen --sap-login`, §4.4) with the saved credentials, writes `tests/<surface>/<name>.spec.ts` and makes it import from `sap-plugin`. Technical details: optionally saves the session (§7.4) |
| Checklist | The guide's §12 rollout checklist, persisted |
| Settings | SAP and Ariba address, user and password, saved in the computer's credential store through [`Bun.secrets`](https://bun.sh/docs/runtime/secrets) instead of a file. Shows whether each value is set, never the value. A user or password from `.env` or the environment is used only with the address set there (or one on the same host): when the address saved here points elsewhere, it is not used and the page says so. Technical details: where each value comes from and an optional Chromium path |

Run data (state, logs, HTML report, traces) lives in `app/.data/runs/<id>/`.

## Setup

Requirements: Bun ≥ 1.4 (installs and runs scripts) and Node 22 (Playwright always runs on Node; CI
uses 22, and the recorder is only tested on 22). If the `node` on your PATH is another version, install 22 next to it and point
`PLAYWRIGHT_NODE` at it, e.g. with Homebrew:

```bash
brew install node@22   # keg-only, leaves the default node alone
echo 'export PLAYWRIGHT_NODE=/opt/homebrew/opt/node@22/bin/node' >> ~/.zshrc
```

The home page (with technical details on) shows which Node runs Playwright and warns, as does each recording's log, when it is not 22.
Other versions are untested rather than known broken: on Node 26 the tests run and report correct
lines (see the CommonJS note below), but the recorder's `playwright install chromium` was seen hanging
while it extracts the browser.

Run everything from the repo root:

```bash
bun run setup          # installs app/ and sap-tests/ plus both Chromium builds
cp sap-tests/.env.example sap-tests/.env   # optional: SAP_URL / SAP_USERNAME / SAP_PASSWORD; or enter them on the Settings page
bun run setup:cert     # optional, once: HTTPS + HTTP/2 via mkcert (brew install mkcert)
bun run dev            # https://localhost:5180 with a cert, otherwise http://localhost:5180
```

HTTPS is there for HTTP/2, not for security: each live run or flow view holds a streaming request
open, and HTTP/1.1 allows only six connections per host, so a few open tabs stall the app. With
`app/cert/` present, `dev`, `preview` and `start` serve HTTPS + HTTP/2 (`start` through a small patch
to `@sveltejs/adapter-bun`, `app/patches/`, the same approach as the reference app). Without it, or with
`DEV_HTTP=1` (e2e tests, CI), they stay on plain HTTP.

| Root script | Does |
| --- | --- |
| `dev`, `build`, `preview`, `start` | The app (`start` serves the production build via adapter-bun; HTTPS + HTTP/2 when `app/cert/` exists) |
| `setup:cert` | Creates `app/cert/` with mkcert (trusted local certificate for localhost) |
| `check` | svelte-check for the app, `tsc` for sap-tests |
| `lint`, `lint:light`, `format` | oxlint/oxfmt/Prettier/knip/ESLint for the app, oxlint/oxfmt for sap-tests |
| `test`, `test:unit`, `test:e2e` | App tests (Vitest once / watch, Playwright e2e) |
| `test:coverage` | Vitest with v8 coverage of `app/src/lib` (text summary + HTML in `app/coverage/`) |
| `test:sap`, `test:sap:list` | Run the SAP suite directly / list its tests |
| `codegen`, `report` | Playwright-SAP recorder (from `sap-tests/recorder`) and HTML report |
| `setup:recorder` | Installs the recorder and its browser (part of `setup`) |
| `pregate` | Fast check before committing: check, lint, unit tests, spec discovery (no e2e) |
| `ci` | Everything CI runs, in order |
| `setup:mcp` | Installs the local Svelte MCP server for Claude Code |

The root is deliberately not a workspace: `sap-tests/recorder` holds the fork aliased as
`@playwright/test`, and separate dependency trees keep it from colliding with stock Playwright.

### OData API tests

`sap-tests/tests/api` calls SAP OData services directly, without a browser, through typed clients
from the [SAP Cloud SDK for JavaScript](https://sap.github.io/cloud-sdk/) (OData V2). The clients
are generated from the service metadata in `sap-tests/odata/metadata` into `sap-tests/odata/clients`
after every `bun install`. They are not committed. Specs import `test` from `sap-plugin/odata`, which adds three fixtures
to the SAP locators:

| Fixture | What it is |
| --- | --- |
| `sapApi` | The system to call: `SAP_API_URL` (host only), `SAP_API_USERNAME`, `SAP_API_PASSWORD`, optional `SAP_CLIENT`, from the app's Settings page or `sap-tests/.env`. The test is skipped when they are missing. There is no fallback to `SAP_URL`, because the tests write data |
| `gwsample` | Typed client for the Gateway sample service `GWSAMPLE_BASIC` |
| `cleanup` | `cleanup(label, undo)` registers an undo step for created data. The steps run after the test, newest first, also after a failure. A failing step fails the test |

Because the fixtures extend the SAP locators, one test can create data over the API, run the flow in
the UI and check the result over the API. The bundled tests target `GWSAMPLE_BASIC`, the sample
service that ships with SAP Gateway in every ABAP system. It is often active in development systems,
otherwise activate it in `/IWFND/MAINT_SERVICE`; the ABAP Cloud Developer Trial (Docker) works too.
SAP's public demo system ES5 (sapes5.sapdevcenter.com), which used to host it, has been shut down.

The app's Settings page has a group for these values (`SAP_API_URL`, `SAP_API_USERNAME`,
`SAP_API_PASSWORD`, `SAP_CLIENT`); saved there, runs started from the app use them. The mock mode
below is started from the terminal only.

Without a system, `bun run test:api:mock` (in `sap-tests`) runs the same tests against a local
mock of the services: SAP's Fiori mock server (`@sap-ux/fe-mockserver-core`) serves each metadata
file at its `basePath`, with the fixed data in `odata/mock/data/<service>/<EntitySet>.json`. Writes
stay in memory until the run ends. Playwright starts the mock and points `SAP_API_*` at it, whatever
`.env` says. CI runs this on every pull request. The mock checks requests against the metadata, not
against SAP's business logic, so a pass on the mock does not replace a run on a real system.

To add or update a service:

```bash
cd sap-tests
# new service: put its $metadata into odata/metadata/<NAME>.edmx
bun run odata:fetch      # refreshes every odata/metadata/*.edmx from SAP_API_URL
bun run odata:generate   # regenerates odata/clients (also writes odata/metadata/options-per-service.json)
bun run typecheck        # tests that use a changed or removed field fail here
```

Commit the metadata: its diff shows the change to the interface in review. The generated clients
are large (about 7,000 lines for `GWSAMPLE_BASIC`) and are rebuilt from it, so they stay out of git.
For a new service, check `basePath` in `options-per-service.json`, add a fixture next to `gwsample`
in `sap-plugin/odata.ts` and mock data under `odata/mock/data/<directoryName>/`. The app lists these tests under
"SAP services (API)" and shows each request as a step.

The `_demo` tests run offline against an inline page, so the app has something to show before an SAP
system is connected; the Fiori/WebGUI/Ariba templates skip until their `.env` values are set. One
demo test fails on purpose to produce a trace. `tests/fiori/rule-findings.example.spec.ts` is a
`test.fixme` that shows what the rule check flags. Delete both once real flows exist.

### Settings (environment variables of the app)

| Variable | Default | Purpose |
| --- | --- | --- |
| `SAP_TESTS_DIR` | `../sap-tests` | Test project to drive |
| `TEST_APP_DATA_DIR` | `./.data` | Run history and artifacts |
| `TEST_APP_KEEP_RUNS` | unset (keep all) | Keep only the newest N runs; older ones are deleted after each run. Off by default because the run history is the evidence for the pilot criterion |
| `TEST_APP_KEEP_ARTIFACTS` | `50` | Runs that keep their report, screenshots, videos and traces. Older runs lose these files (most of a run's size) after each run but keep their results, steps and log, so the history and the reliability table stay complete. `all` never deletes them |
| `PLAYWRIGHT_NODE` | first `node` on PATH | Node binary used to start Playwright (Bun's `node` shim is skipped). Should be Node 22 (the tested version); set it when the default `node` is another version |
| `DEV_PORT` | `5180` | Port of `bun run dev` (fails if taken instead of moving to another port) |
| `PREVIEW_PORT` | `4180` | Port of `bun run preview` and of the e2e tests |
| `PORT` | `3000` | Port of `bun run start` (adapter-bun) |
| `HOST` | `127.0.0.1` | Address `bun run start` listens on. The app has no login and can start runs and the recorder, so it is local-only unless you change this |
| `TEST_APP_ALLOWED_HOSTS` | unset | Extra host names the app answers to, comma-separated. By default it answers only to `localhost` and IP addresses, so a web page cannot reach it under its own name (DNS rebinding). Set this when you open the app under another name, for example behind a proxy |

In `sap-tests/.env`, `CHROMIUM_PATH` lets the tests use an already installed Chromium where
`playwright install` cannot download.

### AI test agents (guide §5.4, §6.4)

Playwright's own test agents are set up for Claude Code and adapted to the SAP rules in
`sap-tests/CLAUDE.md`. They were generated with `playwright init-agents --loop=claude` in `sap-tests`
and then moved to the repo root, where Claude Code sessions start:

| File | Role |
| --- | --- |
| `.claude/agents/playwright-test-planner.md` | Explores the running application and writes a test plan to `sap-tests/specs/`. No code |
| `.claude/agents/playwright-test-generator.md` | Turns a plan into a test under `sap-tests/tests/`, with SAP locators, and runs it |
| `.claude/agents/playwright-test-healer.md` | Finds the cause of a failing test and repairs the test, or reports an application error. Never removes or loosens a check |

They work through the `playwright-test` server in `.mcp.json` (Playwright's `run-test-mcp-server`,
started with `PLAYWRIGHT_NODE` or the first `node`), which opens a visible browser. Each run starts
from a seed test: `sap-tests/tests/_agents/seed.spec.ts` (empty page) or `seed-sap.spec.ts` (logged
in with the values from `sap-tests/.env`; values saved on the Settings page are not read). The seeds
import from `sap-plugin`, which is what makes `page.getByRoleUI5` and the other SAP locators work in
the agents' browser.

Ask for a role by name in Claude Code, for example "use the planner agent to plan the checkout of
<address>". A person reviews every plan and every generated or repaired test; such tests carry
`// KI-generiert, geprüft von: <Name>` until a reviewer puts their name there, and the app lists
them as not reviewed. What the agents see on screen is sent to the AI provider, so use them on test
systems with synthetic data only (guide §9).

After a Playwright upgrade, run `init-agents` again in a scratch folder and compare: the tool lists
in the three files name tools of that Playwright version.

## Development

```bash
cd app
bun run check      # svelte-check
bun run test       # Vitest, two projects (like the reference app):
                   #   server – Node: spec parser, guide rules, run overlay
                   #   client – real Chromium via @vitest/browser-playwright + vitest-browser-svelte:
                   #            StatusTag, HistoryDots, StepNode inside a real SvelteFlow
bun run test:unit  # same, in watch mode
bun run test:e2e   # Playwright: builds + previews the app, drives home page, steps, rule check
                   # and a real live run of the _demo tests (uses .data-e2e, not your run history)
bun run lint:light # oxlint (type-aware) + oxfmt + prettier (.svelte) + knip – fast, use while iterating
bun run lint       # lint:light + eslint
bun run format     # oxfmt + prettier for .svelte
```

### Lint and format

Same layout as the reference app, but stricter:

- **oxlint** (`app/.oxlintrc.json`) does almost all linting, type-aware through `oxlint-tsgolint`,
  with Svelte rules from `@rsvelte/oxlint-plugin`. Instead of a hand-picked rule list, the whole
  `correctness`, `suspicious`, `perf` and `pedantic` categories are errors, and the scripts run with
  `--deny-warnings`, so the app stays at zero findings. The few pedantic rules that do not fit are
  turned off in the config, each with its reason.
- **TypeScript** runs with `noUncheckedIndexedAccess`, so `arr[i]` and `record[key]` are typed as
  possibly missing and have to be checked.
- **oxfmt** formats TS/JS/JSON/Markdown/YAML; **Prettier** only formats `.svelte` files.
- **knip** reports unused files, exports and dependencies.
- **ESLint** keeps only what oxlint cannot do (eslint-plugin-svelte, incl.
  `svelte/no-navigation-without-resolve`); `eslint-plugin-oxlint` turns off everything oxlint runs.
- **sap-tests** has its own `bun run lint` (oxlint, type-aware). Its main job is
  `no-floating-promises`: a missing `await` in a recorded flow is the classic source of flaky tests.
  It also bans `waitForTimeout` (guide §5.2). `bun run format` uses oxfmt with the same style.

CI (`.github/workflows/ci.yml`) runs on every pull request and on pushes to `main`: type check, each
lint/format tool as its own log group, unit/component and e2e tests for the app, plus type check,
lint, format check, spec discovery (`playwright test --list`), the plugin tests and the API tests on
the mock for `sap-tests`. The SAP flows themselves need a test system and are not run in CI.

A second workflow (`.github/workflows/demo-kit.yml`) runs the flows in `tests/fiori/demokit` against
SAP's public UI5 demo apps every weekday night, and on demand from the Actions tab. They are kept out
of the pull request checks because they depend on a site outside the project. Locally:
`bun run test:demokit` in `sap-tests`.

First time: `bunx playwright install chromium` (the app's own Playwright, separate from the
one in `sap-tests`). Where that cannot download, set `CHROMIUM_PATH` to an installed Chromium.

The Svelte MCP server for Claude Code is installed locally and pinned, like in the reference app:

```bash
bun install --cwd .claude/mcp
```

`.mcp.json` points at `.claude/mcp/node_modules/@sveltejs/mcp`; use the `svelte-docs` subagent for
lookups.

### Notes

- SSR is off (`app/src/routes/+layout.ts`): UI5 Web Components need `window`/`customElements` at
  import time and have no server renderer. Remote functions and `+server` routes still run on the server.
- UI5 loads its "72" font from a CDN by default; behind a strict proxy the app falls back to system fonts.
- Bun installs everything. Stock Playwright runs on Bun 1.4 (the app's own Playwright 1.63 lists and
  runs its e2e tests under `bun --bun`), but the Playwright-SAP fork (1.53) does not: under `bun --bun`
  it exits 0 without loading any test. The app therefore starts both Playwright CLIs with the first
  real `node` on PATH (`PLAYWRIGHT_NODE` overrides). `sap-tests` moved to stock Playwright after this
  was observed; whether its suite also runs on Bun alone has not been tried.
- `sap-tests/package.json` deliberately has no `"type": "module"`. As ES modules the specs go through
  Playwright's loader thread, and on newer Node (seen on 26 with the fork) its source maps arrive after the spec has
  run, so Playwright reports the transpiled line numbers. `file:line` runs then find no tests and the
  flow overlay matches the wrong steps. Loaded as CommonJS the source maps are set in-process.
- The recorder passes the SAP password to `codegen --sap-login` as a command-line argument (the
  fork has no other way), so other users on the same machine can see it in the process list while
  a recording runs. Record on a machine you do not share. For Fiori/WebGUI the start URL must be on
  the same host as `SAP_URL`, so the credentials are never typed into another site.
- A run that was still going when the app stopped is shown as interrupted; the app also stops the
  Playwright process when it exits.
- Tests generated in a loop over literal values are listed one per value. Where the values are not
  in the spec file, the test is listed once with its title pattern and matched to run results by
  file and line.
- Settings saved in the app live in the system credential store (macOS Keychain, Windows
  Credential Manager, libsecret on Linux) under the service name `sap-test-lab`. A saved value wins
  over `sap-tests/.env`, which wins over the app's own environment. Runs and recordings started
  from the app get the saved values as environment variables; `bun run test:sap` and
  `bun run codegen` from the terminal do not read the credential store and still need `.env`.
  Where no credential store exists (CI, headless Linux) the page says so and `.env` is used.
  Moving a system's URL to another host removes the saved user and password of that system.
- Not covered (guide §10): SAP GUI for Windows.
- Octane import is not part of this version.
