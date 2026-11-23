# SAP Test Lab

A test app for the open-source SAP test automation described in _SAP-Testautomatisierung-Leitfaden_
(Playwright with SAP locators for Fiori/UI5, SAP WebGUI and SAP Ariba). It runs Playwright tests,
shows them as step flows, streams runs live, and tracks the pilot's exit criteria.

```
sap-test/
├── src/, static/     The Test-App: SvelteKit 3 + Bun + UI5 Web Components
├── tests/            The app's own browser tests (Playwright)
├── reporter/         Playwright reporter the app adds to every run (live steps)
├── drizzle/          Migrations of the app's database
├── scripts/          setup-cert, pregate
├── package.json      One install for everything (bun.lock next to it)
└── sap-tests/        SAP test project (guide §4), driven by the app
    ├── tests/, helpers/, setup/, specs/, systems.json
    ├── sap-plugin/   SAP locators for stock Playwright (ported from Playwright-SAP),
    │                 plus OData, Mock PLC and IDoc fixtures, and the UI5 recorder
    ├── odata/        Service metadata, the typed OData clients generated from it, and a mock
    ├── mfs/, idoc/   Mock PLC and IDoc receiver
    └── recorder/     Starts the Playwright-SAP fork, used to record WebGUI only
```

The app sits at the root, as a SvelteKit project does. The SAP test project in `sap-tests/` has no
install of its own: both share the root `package.json`, one `bun.lock` and one `node_modules`, so
`bun install` at the root installs everything. The Playwright-SAP fork is a dependency under its own
name, `playwright-sap-recorder`, so it does not clash with stock Playwright. Only the Svelte MCP
server for Claude Code keeps a separate install (`.claude/mcp`, see below).

The tests run on stock Playwright. `sap-tests/sap-plugin` adds the SAP locators of the
[Playwright-SAP](https://github.com/ArpitSureka/playwright-sap) fork to it (`page.getByRoleUI5`,
`locateUI5`, `locateSID`, `getByRoleSID`, `SAPLogin`): the fork's selector engines, vendored
unchanged under Apache-2.0 and registered as custom selector engines. Specs import `test` and
`expect` from `sap-plugin` instead of `@playwright/test`.

Fiori / UI5 flows are recorded with the plugin's own recorder (`sap-tests/sap-plugin/record.mjs`),
which also runs on stock Playwright. It asks UI5 itself (`sap.ui.test.RecordReplay`) to describe each
control and writes `page.locateUI5Control({...})`, a locator that can name a row by the record it
shows instead of by its position. A bar, point or slice of a chart (`sap.viz`) is recorded by the
values it stands for: `.locator(ui5ChartPointSelector({ 'Item Category': 'Pop', measureNames: 'Revenue' }))`
on the chart's locator. A date picked in a calendar is recorded as the value it put into the field
(`.fill('12/2026')`, then leaving the field), not as clicks on a day, which only exists while its month is shown.
A click on the icon of a button is recorded as a click on the button.

Passwords are typed with `fillSecret(locator, value)` from `sap-plugin` (`SAPLogin` does this
itself), never with `fill`: Playwright writes a filled value into the step title, and so into the
HTML report of every run. `fillSecret` hands the value to the password field through a one-time
page binding instead. The app also masks every password it knows of in the run state and log it
keeps.

### Signing in once per run

A Playwright trace records the password of any browser login: the page snapshots show the filled
field and the network log the login request. So the tests do not sign in themselves. The systems
they sign in to are listed in `sap-tests/systems.json`, and `sap-tests/playwright.config.ts` makes
two projects for each: `<id>-sign-in` signs in once per run with `setup/sign-in.setup.ts`, with
trace and video off (also with `--trace on`), and saves the session in
`sap-tests/.auth/<id>-session.json` (gitignored); `<id>` holds the system's tests, which start with
that session.

| Project    | Tests                                                             | Signs in with                                             |
| ---------- | ----------------------------------------------------------------- | --------------------------------------------------------- |
| `sap`      | `tests/fiori` (not `demokit`), `tests/webgui`, `tests/_reference` | `sapLogin` with `SAP_URL`, `SAP_USERNAME`, `SAP_PASSWORD` |
| `ariba`    | `tests/ariba`                                                     | `form` with `ARIBA_URL`, `ARIBA_USER`, `ARIBA_PASS`       |
| `chromium` | everything else (`_demo`, `_plugin`, `api`, `fiori/demokit`)      | –                                                         |

`tests/_agents/seed-signed-in.spec.ts` belongs to every system's project (see the test agents
below).

The sign-in methods:

| Method     | For                                                                           | How                                                                                                                |
| ---------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `sapLogin` | Fiori launchpad and WebGUI                                                    | `page.SAPLogin`: the NetWeaver or launchpad login page                                                             |
| `ias`      | SuccessFactors, IBP and other applications behind SAP Cloud Identity Services | The IAS login page, found by its field names (`j_username`, `j_password`), so its language and texts do not matter |
| `form`     | An application's own login page (Ariba, Concur)                               | Fields by their labels and the button by its name, given in the row                                                |

`ias` and `form` also handle a login page that asks for the user first and for the password on a
second page, and wait until an identity service has sent the browser back to the system. Sign-in
through a company identity provider with MFA (Entra and others) is not covered: use a test user
without MFA.

`page.SAPLogin(…)` stays in the specs and in recordings, but with a saved session it only opens the
URL. A login page there means the session has expired, which fails the test instead of typing the
password into its trace. A sign-in project runs only when a selected test needs it (also with a
file or `--grep` filter). If it fails, the tests that need it do not run, and the Results page says
so. With `--no-deps`, or for a second test user signing in within a test, the password is typed in
a traced test again.

#### Adding a system

Add a row to `sap-tests/systems.json` and put its tests in the folder the row names. For example
SuccessFactors behind IAS:

```json
{
  "id": "successfactors",
  "title": "SuccessFactors",
  "description": "Optional: only for SuccessFactors tests",
  "optional": true,
  "signIn": { "method": "ias" },
  "env": { "url": "SF_URL", "user": "SF_USERNAME", "password": "SF_PASSWORD" },
  "tests": ["successfactors"]
}
```

For an application's own login page: `"signIn": { "method": "form", "user": "<label of the user
field>", "password": "<label of the password field>", "submit": "<name of the button>" }`. The tests
start with `await page.goto(process.env.SF_URL!)`, already signed in. The Settings page shows the
new system's fields, and the app masks its password in everything a run records and does not send
the user and password from `.env` to another address saved in the app, as for SAP. `optional`
leaves the system out of the Home page's getting started. A row's `exclude` lists folders inside
its `tests` folders that belong to no system (like `fiori/demokit`). The test project refuses a
table with an unknown method, a variable used twice, or a folder claimed by two systems.

The Tests page groups the tests by system, and "Record a test" offers each folder of each system
(except folders starting with `_`). Which recorder records it follows from the row:

| System signs in with | Folder                                       | Recorder                               | Signed in by                                                                                       |
| -------------------- | -------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `sapLogin`           | named `webgui` (e.g. `webgui`, `ewm/webgui`) | Playwright-SAP (`codegen --sap-login`) | the recorder, with the system's user and password                                                  |
| `sapLogin`           | any other                                    | the UI5 recorder of `sap-plugin`       | the recorder; the spec reads the system's own variables (`process.env.EWM_URL`, …)                 |
| `ias` or `form`      | any                                          | stock Playwright (`codegen`)           | the session the last test run saved (`--load-storage`); without one, you, in the recorder's window |

A UI5 recording "without login" goes to a folder the system excludes inside the chosen one (for
SAP: `fiori/demokit`). A recorder gets only the chosen system's login; every other system's user
and password are blanked in its environment.

A trace still holds the session cookies, which are valid until the SAP session ends. Treat
`.data/runs` and `sap-tests/.auth` as secret.

The fork itself (Playwright 1.53) is installed as `playwright-sap-recorder` and used for recording
WebGUI only, because its codegen is what writes SID locators and the plugin's recorder has not been
tried on a real WebGUI system. Systems that do not sign in with SAP's login, such as Ariba, record
with stock Playwright's codegen: their tests use standard locators. The app starts the matching
recorder for "Record a test"; for both codegens it then points the recorded spec's import at
`sap-plugin`. The app never imports
Playwright itself; it starts the CLIs with real Node.

## What the app does

The app speaks plain language by default, so people who do not write tests can run them and read
the results: steps read as sentences ("Enter “1000” in “Sold-To Party”"), a failed test shows the
screen it stopped on, and the home page walks through the first steps. The **Technical details**
switch in the top bar (remembered per browser) adds what test authors need: file names and lines,
locators, source code, timelines, logs and the references to the guide. The table lists both.

| Page             | What it shows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home             | Getting-started steps, whether the test tools and the SAP connection are ready, number of tests per kind (Fiori, WebGUI, API, demo; other tests by the system they sign in to), latest result, **reliability**: consecutive passes per test against the guide's 10-in-a-row criterion (§4.8). Technical details: Playwright, recorder and Node version, which `.env` values are set (never their values)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Tests            | Every spec under `sap-tests/tests`, grouped by the system of `sap-tests/systems.json` it starts signed in to (other tests, such as API and demo tests, in a group of their own), with the **quality check** from the guide's rules file (§5.2): CSS/XPath on SAP screens, `waitForTimeout`, missing assertion after a save, literal passwords, passwords typed with `fill` instead of `fillSecret`, unreviewed `KI-generiert` tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Steps (per test) | The test parsed into a step graph (Svelte Flow), each step as a sentence. Overlay of any run: passed / failed / not reached per step with timings, live while a run is in progress. Technical details: action, locator type (UI5 / SID / SID path / role / CSS…), value, helper used, and the source panel with the selected step highlighted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Results          | Run history; per run: live progress, error, screenshot, video, step-by-step replay (the Playwright trace viewer) and the full HTML report. Technical details: per-test step timeline and the raw log                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Record a test    | Pick a system and its folder (from `sap-tests/systems.json`, see "Adding a system"); starts a recorder with that system's saved credentials and writes `tests/<folder>/<name>.spec.ts`, importing from `sap-plugin`. Fiori: the UI5 recorder of `sap-plugin`, which logs in, shows a "Recording" mark with the step count and writes a spec that starts with `page.SAPLogin`. WebGUI: the Playwright-SAP recorder (`playwright codegen --sap-login`, §4.4), started through `sap-tests/recorder/codegen.cjs`, which hands it the login from the environment so the password is not on its command line. Systems with a login page of their own (Ariba): stock Playwright's `codegen`, without credentials; it starts from the session the last test run saved for the system (`sap-tests/.auth`, `--load-storage`) when the start page is on the system's address, and otherwise the person signs in. The line codegen writes for that session (`test.use({ storageState: … })`) is removed from the saved spec, which gets the session from its project |
| Mock PLC         | Stands in for the PLCs of an EWM-controlled automated warehouse (MFS) on Dev and Qual systems: the warehouse drawn live with its HUs, PLC connections, devices that can be switched off, protocol faults, "what happened" and the telegram log. Mode _Wait for EWM_ opens the PLC ports for a real EWM; mode _Demo_ adds a simulated EWM so the whole flow runs without SAP. **Scenarios** (choose one at the start or on the running Mock PLC) play prepared situations, such as a crane failing with a task waiting or a connection lost mid-task, step by step, and check what EWM did. The Mock PLC runs as its own process (`sap-tests/mfs`, see its README); with `MFS_EMULATOR_URL` the app controls one that runs elsewhere (its control token goes in `MFS_EMULATOR_TOKEN`). Technical details: ports, life telegrams, acknowledgements                                                                                                                                                                                                         |
| Mock IDoc        | Stands in for the partner system SAP sends IDocs to (`sap-tests/idoc`, see its README): start and stop the receiver, the address SAP posts to (SM59 type G destination, WE21 XML HTTP port), the received IDocs newest first with their control record and segments, and the answers per partner: refuse with an HTTP error, answer late to test SAP's timeout, or accept. **Try it without SAP** sends a sample IDoc in SAP's place. Tests started from the app reach the receiver it started through the `idocInbox` fixture. Its settings (address, HTTPS, login; `IDOC_*`, listed in `sap-tests/.env.example`) come from the app's environment or else `sap-tests/.env`; with `IDOC_HUB_URL` the app controls one that runs elsewhere (its control token goes in `IDOC_HUB_TOKEN`). Technical details: the SAP setup steps, the whole control record, SOAP and the request as SAP sent it                                                                                                                                                            |
| Settings         | With sign-in on, admins only; People (invites, roles, removal) and the Activity log there too. SAP and Ariba address, user and password, saved in the computer's credential store through [`Bun.secrets`](https://bun.sh/docs/runtime/secrets) instead of a file. Shows whether each value is set, never the value. A user or password from `.env` or the environment is used only with the address set there (or one on the same host): when the address saved here points elsewhere, it is not used and the page says so. Technical details: where each value comes from and an optional Chromium path                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

The run history (each run and the result and steps of each test) is kept in the app's database,
`.data/app.sqlite`, next to sign-in. The log, HTML report, screenshots, videos and traces of a
run stay files in `.data/runs/<id>/`. Runs kept in files by an earlier version
(`state.json`, `meta.json`) move into the database at the first start, and those files are
deleted (the retention rules delete steps and error messages in the database only). An earlier
version started afterwards shows no runs: it reads only those files. What retention deletes is
overwritten in the database file, not left readable in it.

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

Run everything from the repo root.

**Upgrading a checkout from before the single `package.json`** (the app used to live in `app/`):
run `bun run setup` once after pulling. It moves the app's data (`app/.data`: run history, users,
passkeys), its certificate (`app/cert`) and its settings files (`app/.env` and the like, which Bun
loaded while the app ran from `app/`) to the root, where the app now looks for them, and deletes the
old installs (`app/node_modules`, `sap-tests/node_modules`, `sap-tests/recorder/node_modules`). If
something exists in both places, it moves nothing and asks you to keep one. Until then the app
refuses to start and names what is left over. Relative paths in `TEST_APP_DATA_DIR` and
`SAP_TESTS_DIR` are now taken from the repository root, not from `app/`; the app names a setting
that still points to the old place. What remains in `app/` is build output, ignored by git, and can
be deleted.

```bash
bun run setup          # installs everything (one bun install) plus both Chromium builds
cp sap-tests/.env.example sap-tests/.env   # optional: SAP_URL / SAP_USERNAME / SAP_PASSWORD; or enter them on the Settings page
bun run setup:cert     # optional, once: HTTPS + HTTP/2 via mkcert (brew install mkcert)
bun run dev            # https://localhost:5180 with a cert, otherwise http://localhost:5180
```

HTTPS is there for HTTP/2, not for security: each live run or flow view holds a streaming request
open, and HTTP/1.1 allows only six connections per host, so a few open tabs stall the app. With
`cert/` present, `dev`, `preview` and `start` serve HTTPS + HTTP/2 (`start` through a small patch
to `@sveltejs/adapter-bun`, `patches/`, the same approach as the reference app). Without it, or with
`DEV_HTTP=1` (e2e tests, CI), they stay on plain HTTP.

| Root script                                                                            | Does                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dev`, `build`, `preview`, `start`                                                     | The app (`start` serves the production build via adapter-bun; HTTPS + HTTP/2 when `cert/` exists)                                                                                                                                                                                               |
| `setup:cert`                                                                           | Creates `cert/` with mkcert (trusted local certificate for localhost)                                                                                                                                                                                                                           |
| `check`                                                                                | svelte-check for the app, `tsc` for sap-tests                                                                                                                                                                                                                                                   |
| `lint`, `lint:light`, `format`                                                         | oxlint/oxfmt/Prettier/knip/ESLint, one run for the app and sap-tests (oxlint takes `sap-tests/.oxlintrc.json` for the files there)                                                                                                                                                              |
| `test`, `test:unit`, `test:e2e`                                                        | App tests (Vitest once / watch, Playwright e2e)                                                                                                                                                                                                                                                 |
| `test:coverage`                                                                        | Vitest with v8 coverage of `src/lib` (text summary + HTML in `coverage/`)                                                                                                                                                                                                                       |
| `test:sap`, `test:sap:list`                                                            | Run the SAP suite directly / list its tests                                                                                                                                                                                                                                                     |
| `test:plugin`, `test:mfs`, `test:idoc`, `test:api:mock`, `test:demokit`                | The sap-tests suites that need no SAP system (plugin, Mock PLC, IDoc receiver, OData mock, UI5 demo kit)                                                                                                                                                                                        |
| `codegen`, `report`                                                                    | Playwright-SAP recorder (WebGUI) and HTML report of the last SAP run                                                                                                                                                                                                                            |
| `odata:fetch`, `odata:generate`, `mfs:server`, `mfs:demo`, `idoc:server`, `idoc:certs` | sap-tests tools, see their sections                                                                                                                                                                                                                                                             |
| `record`                                                                               | UI5 recorder on stock Playwright: `bun run record <url> [tests/<folder>/<name>.spec.ts] [--name <title>] [--login]`; close the window to save                                                                                                                                                   |
| `setup:recorder`                                                                       | Installs the recorder and its browser (part of `setup`)                                                                                                                                                                                                                                         |
| `pregate`                                                                              | Every mechanical check before a pull request, short of the e2e tests: types, lint and format side by side (all failures in one round), then the app's unit tests and the sap-tests suites that need no SAP system. About five minutes; `bun run pregate --only static` for the first part alone |
| `ci`                                                                                   | Everything CI runs, in order                                                                                                                                                                                                                                                                    |
| `setup:mcp`                                                                            | Installs the local Svelte MCP server for Claude Code                                                                                                                                                                                                                                            |

The SAP scripts change into `sap-tests/` before they start Playwright, so its config, `.env` and
`.auth` are found as before. Run every script from the root; `sap-tests/` has no `package.json`.

### OData API tests

`sap-tests/tests/api` calls SAP OData services directly, without a browser, through typed clients
from the [SAP Cloud SDK for JavaScript](https://sap.github.io/cloud-sdk/) (OData V2). The clients
are generated from the service metadata in `sap-tests/odata/metadata` into `sap-tests/odata/clients`
after every `bun install`. They are not committed. Specs import `test` from `sap-plugin/odata`, which adds three fixtures
to the SAP locators:

| Fixture    | What it is                                                                                                                                                                                                                                                                 |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sapApi`   | The system to call: `SAP_API_URL` (host only), `SAP_API_USERNAME`, `SAP_API_PASSWORD`, optional `SAP_CLIENT`, from the app's Settings page or `sap-tests/.env`. The test is skipped when they are missing. There is no fallback to `SAP_URL`, because the tests write data |
| `gwsample` | Typed client for the Gateway sample service `GWSAMPLE_BASIC`                                                                                                                                                                                                               |
| `cleanup`  | `cleanup(label, undo)` registers an undo step for created data. The steps run after the test, newest first, also after a failure. A failing step fails the test                                                                                                            |

Because the fixtures extend the SAP locators, one test can create data over the API, run the flow in
the UI and check the result over the API. The bundled tests target `GWSAMPLE_BASIC`, the sample
service that ships with SAP Gateway in every ABAP system. It is often active in development systems,
otherwise activate it in `/IWFND/MAINT_SERVICE`; the ABAP Cloud Developer Trial (Docker) works too.
SAP's public demo system ES5 (sapes5.sapdevcenter.com), which used to host it, has been shut down.

The app's Settings page has a group for these values (`SAP_API_URL`, `SAP_API_USERNAME`,
`SAP_API_PASSWORD`, `SAP_CLIENT`); saved there, runs started from the app use them, unless the
Mock OData page points them at the mock (below).

Without a system, `bun run test:api:mock` (in `sap-tests`) runs the same tests against a local
mock of the services: SAP's Fiori mock server (`@sap-ux/fe-mockserver-core`) serves each metadata
file at its `basePath`, with the fixed data in `odata/mock/data/<service>/<EntitySet>.json`. Writes
stay in memory until the run ends. Playwright starts the mock and points `SAP_API_*` at it, whatever
`.env` says. CI runs this on every pull request. The mock checks requests against the metadata, not
against SAP's business logic, so a pass on the mock does not replace a run on a real system.
`bun run test:odata` tests the mock itself.

In the app, the **Mock OData** page starts the same mock (`odata/mock/server.mts`) on free ports on
this computer and shows:

- where each service is served, and a switch that points the API tests started in the app at the
  mock instead of the system in the settings (off at every start);
- every request it answered, with what was sent and what came back (bodies up to 16 KB, `$batch`
  included);
- answers per service: fail with an HTTP status and message, in the form SAP Gateway sends errors,
  or answer late, for negative tests;
- the data it holds now, writes included, and a reset to the data files.

The mock has no login, so it never listens beyond this computer. Its control API (log, answers,
data, reset) takes a token the app makes up for each start.

To add or update a service:

```bash
# new service: put its $metadata into sap-tests/odata/metadata/<NAME>.edmx
bun run odata:fetch      # refreshes every odata/metadata/*.edmx from SAP_API_URL
bun run odata:generate   # regenerates odata/clients (also writes odata/metadata/options-per-service.json)
bun run check            # tests that use a changed or removed field fail here
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

| Variable                                                  | Default                        | Purpose                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SAP_TESTS_DIR`                                           | `./sap-tests`                  | Test project to drive. Inside this repository it shares the root install; a test project elsewhere needs its own `node_modules`                                                                                                                                                  |
| `TEST_APP_PACKAGES_DIR`                                   | the install of `SAP_TESTS_DIR` | Where the app finds Playwright, the recorders and the packages of the Mock PLC and the IDoc receiver, and the recorders load them from. Set by the app's own tests, which run stand-ins; not needed otherwise                                                                    |
| `TEST_APP_DATA_DIR`                                       | `./.data`                      | The database (`app.sqlite`: run history and sign-in) and each run's files                                                                                                                                                                                                        |
| `TEST_APP_KEEP_RUNS`                                      | unset (keep all)               | Keep only the newest N runs; older ones are deleted after each run. Off by default because the run history is the evidence for the pilot criterion                                                                                                                               |
| `TEST_APP_KEEP_REPORT_DAYS`                               | `14`                           | Days a run keeps its Playwright report, screenshots, videos and traces. Also the days a failure stays in full after the test passed again                                                                                                                                        |
| `TEST_APP_KEEP_STEPS_DAYS`                                | `30`                           | Days a run keeps the steps of its tests and its log                                                                                                                                                                                                                              |
| `TEST_APP_KEEP_FAILURE_DAYS`                              | `90`                           | The longest a failure is kept in full, fixed or not. These files show SAP data, so set this to what your company allows                                                                                                                                                          |
| `TEST_APP_RETENTION`                                      | on                             | `off` never deletes anything from a run                                                                                                                                                                                                                                          |
| `TEST_APP_HEALER`                                         | off                            | `on` shows "Diagnose with healer" on failed tests (see "The healer in the app"). Sends the test, its error and what the screens show to the AI provider of `TEST_APP_AI`: turn it on once that is approved (guide §9)                                                            |
| `TEST_APP_HEALER_BUDGET_USD`                              | `5`                            | The most one healer session may cost, as the Agent SDK estimates it; it stops there                                                                                                                                                                                              |
| `PLAYWRIGHT_NODE`                                         | first `node` on PATH           | Node binary used to start Playwright (Bun's `node` shim is skipped). Should be Node 22 (the tested version); set it when the default `node` is another version                                                                                                                   |
| `DEV_PORT`                                                | `5180`                         | Port of `bun run dev` (fails if taken instead of moving to another port)                                                                                                                                                                                                         |
| `PREVIEW_PORT`                                            | `4180`                         | Port of `bun run preview` and of the e2e tests                                                                                                                                                                                                                                   |
| `PORT`                                                    | `3000`                         | Port of `bun run start` (adapter-bun)                                                                                                                                                                                                                                            |
| `HOST`                                                    | `127.0.0.1`                    | Address `bun run start` listens on. Another address (the network) needs `TEST_APP_AUTH=passkey`: without sign-in the app refuses to start there, since it can start runs and the recorder with the saved credentials                                                             |
| `TEST_APP_AUTH`                                           | `off`                          | `passkey`: everyone signs in with a passkey (see below)                                                                                                                                                                                                                          |
| `BETTER_AUTH_URL`                                         | unset                          | The app's https address, e.g. `https://lab.example.com`, with sign-in on. Passkeys belong to its host name, and cookies are Secure. Required when `HOST` is not this computer (the app refuses to start without it); on a laptop the address of each request is used             |
| `TEST_APP_CLIENT_IP_HEADER`                               | unset                          | The header the reverse proxy sets to the client's address (e.g. `x-real-ip`), for rate limiting per client. Unset, `X-Forwarded-For` is read, which a client can set itself                                                                                                      |
| `BETTER_AUTH_SECRET`                                      | generated                      | Signs the session cookies. Unset, one is generated once into `<data dir>/auth-secret` (readable by this user only)                                                                                                                                                               |
| `TEST_APP_SETUP_TOKEN`                                    | random                         | The token of the setup link for the first admin (at least 24 characters). Unset, a random one is logged at each start while nobody is registered                                                                                                                                 |
| `TEST_APP_RECOVERY`                                       | unset                          | `on`: logs a recovery link at start, for when no admin can sign in any more (see below). Unset it again afterwards                                                                                                                                                               |
| `TEST_APP_RECOVERY_TOKEN`                                 | random                         | The token of the recovery link (at least 24 characters). It works once, also across restarts. Unset, a random one is logged at each start with `TEST_APP_RECOVERY=on`                                                                                                            |
| `TEST_APP_ALLOWED_HOSTS`                                  | unset                          | Extra host names the app answers to, comma-separated. By default it answers only to `localhost` and IP addresses, so a web page cannot reach it under its own name (DNS rebinding). Set this when you open the app under another name, for example behind a proxy                |
| `TEST_APP_AI`                                             | `off`                          | `vertex` or `foundry`: the AI features use Claude through the company's Vertex AI or Microsoft Foundry (see "AI provider" below). `anthropic`: the direct Anthropic API, for local tests only (refused with sign-in on or `HOST` on the network). No other value is accepted     |
| `TEST_APP_AI_MODEL`                                       | `claude-opus-5-5`              | The model. On Foundry, the name of its deployment                                                                                                                                                                                                                                |
| `GOOGLE_VERTEX_PROJECT`, `GOOGLE_VERTEX_LOCATION`         | unset                          | With `TEST_APP_AI=vertex`: the Google Cloud project and its location, `eu` for the EU endpoint. Sign-in uses Google's credentials: `gcloud auth application-default login` on a laptop, a service account (`GOOGLE_APPLICATION_CREDENTIALS`) or workload identity on the cluster |
| `ANTHROPIC_FOUNDRY_RESOURCE`, `ANTHROPIC_FOUNDRY_API_KEY` | unset                          | With `TEST_APP_AI=foundry`: the name of the Foundry resource (the first part of `<resource>.services.ai.azure.com`) and its key                                                                                                                                                  |
| `ANTHROPIC_API_KEY`                                       | unset                          | With `TEST_APP_AI=anthropic`: your Anthropic API key, for local tests                                                                                                                                                                                                            |

### Signing in to the app (passkeys)

With `TEST_APP_AUTH=passkey`, every page, data request and run file needs a signed-in person.
People sign in with a passkey (Touch ID, Windows Hello, a phone or a security key); there are no
passwords. Users, sessions and passkeys are kept by [Better Auth](https://better-auth.com) in the
app's database, `<data dir>/app.sqlite` (Bun's built-in SQLite through
[Drizzle](https://orm.drizzle.team)), readable by this user only. Its schema is in
`src/lib/server/db`; `bun run db:generate` turns a change there into a migration in
`drizzle/`, which the app applies when it starts.

- **First admin.** While nobody is registered, the server logs a one-time link
  (`/signin?setup=…`). Whoever opens it registers a passkey and becomes the admin. On a cluster,
  read it with `kubectl logs`, or set `TEST_APP_SETUP_TOKEN`.
- **Lost admin access.** If no admin can sign in any more (a lost passkey, a new computer),
  restart the app with `TEST_APP_RECOVERY=on`. The server logs a link (`/signin?recover=…`)
  that registers a passkey as a new admin. It works once, for an hour after the start, and the
  Activity log shows it. Remove the old account under Settings → People, then unset
  `TEST_APP_RECOVERY`. Only who starts the server and reads its log gets the link.
- **Everyone else** gets an invite link from an admin (Settings → People). It works once, for 72
  hours, and is not shown again. The invite sets the role: admins also change the settings
  (which hold the SAP passwords) and manage people; members run, record and read results.
- **Managing people** (Settings → People, through Better Auth's admin plugin): make someone admin
  or member, block them (signed out at once, cannot sign in until unblocked) or remove them with
  their passkeys and sessions. Nobody blocks or removes themselves, and the last admin keeps the
  role. Admins cannot act as another person (impersonation is off). A session otherwise ends
  after 12 hours without use.
- **Rate limiting** of sign-in calls is always on (Better Auth turns it on in production mode only).
- **Activity** (Settings): sign-ins, registrations, invites, removals, runs, recordings and changed
  settings (the name, never the value), newest first. It stays in the same database; nothing is
  sent elsewhere.
- Passkeys need a host name, not an IP address: open the app as `localhost`, or under
  `BETTER_AUTH_URL` on a server, over https there.

Later, with a company directory, Microsoft (Entra ID) sign-in can be added next to passkeys.

**What is kept of a run.** Which test passed or failed, when, and how long it took is kept for good;
it is the evidence for the pilot criterion. Everything else goes by age and by what came after:

- The newest run is always kept in full.
- A failure stays in full (trace, video, screenshot, steps, error message, log) while the test has
  not passed again, then for `TEST_APP_KEEP_REPORT_DAYS` more, and never longer than
  `TEST_APP_KEEP_FAILURE_DAYS`.
- Of a series of failures at the same place in the test, only the first and the latest stay in full.

The rules are applied after each run, when the app starts and once a day.

In `sap-tests/.env`, `CHROMIUM_PATH` lets the tests use an already installed Chromium where
`playwright install` cannot download.

**A trial system with a self-signed certificate.** An SAP system reached by its IP address, such as
an SAP Cloud Appliance Library appliance, has a certificate no browser trusts, and Playwright stops
at it. Set `SAP_SELF_SIGNED_HOST` to that system's host (e.g. `203.0.113.10`, without `https://`,
port or path; Settings, Technical details, or `sap-tests/.env`). The browsers of systems that sign
in with the SAP login (`sapLogin` in `systems.json`) then skip the certificate check in runs and in
the UI5 and WebGUI recorders, but only while the system's address is on that host: point `SAP_URL`
at another system and the exception no longer applies. Ariba and other systems where a person signs
in always keep the full check. While it applies, the check is off for that system's whole browser,
not only for the trial host: a page that loads something from another address, or a redirect to
one, is accepted with a bad certificate too. Only use it for a test system you set up yourself,
ideally restricted to your IP, and remove it once you test against a system with a proper
certificate: without the check, the browser cannot tell a host from an impostor, and the test
user's password is typed into it. Recording from the command line, pass `--ignore-https-errors` to
`bun run record` or `bun run codegen` yourself.

### Gate before a pull request

`/gate` in Claude Code checks a committed branch before it becomes a pull request. It is a smaller
form of the reference app's four-lens review:

1. `bun run pregate`. A failure ends the gate there.
2. One reviewer (`.claude/agents/gate-reviewer.md`) reads the branch's changes against main. A
   second one looks only at security when the change touches sign-in, credentials, endpoints, the
   code that starts processes, or the CI workflows.
3. Every serious finding goes to a verifier (`.claude/agents/gate-verifier.md`) that tries to
   refute it against the code.
4. The verdict follows a fixed rule: a confirmed serious finding fails the gate. Its final line
   (`GATE: PASS`, `PASS-WITH-FIXES`, `FAIL`) goes into the pull request description.

It is a convention, written down in `CLAUDE.md`: nothing on GitHub prevents a merge without it,
and a review by agents can miss defects or be wrong about one. It does not replace a person
reading a change to sign-in or credentials.

### AI provider

With the company's systems, the AI features reach Claude only through the two platforms the
company approved: Google's Vertex AI and Microsoft Foundry. Other models may only be used through
these two as well. `TEST_APP_AI` chooses the platform and is `off` by default; the settings it
needs are in the table above.

For local tests before the company access, `TEST_APP_AI=anthropic` uses the direct Anthropic API
with your own key. The app refuses it as soon as sign-in is on or `HOST` reaches the network, so
it cannot be used on the cluster. Use it with the demo tests only (`_demo`, the UI5 demokit): what
the AI sees is sent to Anthropic. Moving to the company platform changes only the settings.

- **Where the code is:** only `src/lib/server/ai/` uses the AI SDK (`ai`, `@ai-sdk/anthropic`,
  `@ai-sdk/google-vertex`, at exact versions, since these packages change often). A lint rule
  (`no-restricted-imports` in `.oxlintrc.json`) refuses them anywhere else: a model named by a
  plain string would go to Vercel's AI Gateway, and the Anthropic provider without an address and
  a key would go to the direct API.
- **Credentials** stay on the server, in its environment (a Kubernetes secret on the cluster).
  They never reach the browser. Test runs, recordings and the mock servers start without them,
  and without the app's sign-in secrets, so they are not handed to a test. That is no barrier: a
  test runs as the same user in the same container, and can still read the app's environment
  (`/proc/<pid>/environ` on Linux), a key file of that user, and on the cluster the pod's Google
  identity. Before an AI key goes onto the cluster, test runs must move to pods of their own or
  run as another user without the app's service account (decided in #15).
- **Checking the connection:** Settings shows the platform, the model and any missing setting. An
  admin can send one short test message ("Check connection"); its answer, time and tokens show
  there, and the server log notes each check. Nothing from a test or a system goes into it.
- **What will be sent:** so far only that test message. The planned features send the error, the
  steps and the screenshot of a failed test, the test's code and the rules in
  `sap-tests/CLAUDE.md` (#14), and the agents (#15) send what they see in the browser. Everything
  on those screens counts as shared with the provider, so they may only use test systems with
  synthetic or anonymised data. SAP credentials and the values of `sap-tests/.env` never go into
  a request.
- **Review:** the app saves what the AI writes for review and never commits or merges it. Such
  tests carry `// KI-generiert, geprüft von: <Name>` until a reviewer puts their name there.
- **The agents' sandbox** (#15) is decided when that work starts. The agents edit files and run
  tests, and must reach the RISE systems, so the likely place is one Kubernetes Job per agent run
  on the company cluster.

### AI test agents (guide §5.4, §6.4)

Playwright's own test agents are set up for Claude Code and adapted to the SAP rules in
`sap-tests/CLAUDE.md`. They were generated with `playwright init-agents --loop=claude` in `sap-tests`
and then moved to the repo root, where Claude Code sessions start:

| File                                          | Role                                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `.claude/agents/playwright-test-planner.md`   | Explores the running application and writes a test plan to `sap-tests/specs/`. No code                                    |
| `.claude/agents/playwright-test-generator.md` | Turns a plan into a test under `sap-tests/tests/`, with SAP locators, and runs it                                         |
| `.claude/agents/playwright-test-healer.md`    | Finds the cause of a failing test and repairs the test, or reports an application error. Never removes or loosens a check |

They work through the `playwright-test` server in `.mcp.json` (Playwright's `run-test-mcp-server`,
started with `PLAYWRIGHT_NODE` or the first `node`), which opens a visible browser. Each run starts
from a seed test: `sap-tests/tests/_agents/seed.spec.ts` (empty page, project `chromium`) or
`seed-signed-in.spec.ts` with a system's id as the project (`sap`, `ariba`, ...: its sign-in
project signs in first with the values from `sap-tests/.env`, in a browser of its own, so the
agents' browser never sends the password; values saved on the Settings page are not read). The seeds
import from `sap-plugin`, which is what makes `page.getByRoleUI5` and the other SAP locators work in
the agents' browser.

Ask for a role by name in Claude Code, for example "use the planner agent to plan the checkout of
<address>". A person reviews every plan and every generated or repaired test; such tests carry
`// KI-generiert, geprüft von: <Name>` until a reviewer puts their name there, and the app lists
them as not reviewed. What the agents see on screen is sent to the AI provider, so use them on test
systems with synthetic data only (guide §9), and set Claude Code up to use Vertex AI or Microsoft
Foundry, like the app (see "AI provider" above).

#### In VS Code (GitHub Copilot) and Codex

The same three agents exist for GitHub Copilot in VS Code and for Codex, in the formats of
`init-agents --loop=vscode` and `--loop=codex`:

| Tool                     | Files                                                                     | Start a role                                              |
| ------------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------- |
| Claude Code              | `.claude/agents/playwright-test-*.md`, server in `.mcp.json`              | by name in the chat                                       |
| GitHub Copilot (VS Code) | `.github/agents/playwright-test-*.agent.md`, server in `.vscode/mcp.json` | pick the agent in the chat's agent list                   |
| Codex                    | `.codex/agents/playwright_test_*.toml`, each with its own server entry    | ask for the agent by name, e.g. `playwright_test_planner` |

The Claude Code files are the ones to edit. `bun run agents` writes the others from them: the same
prompt, the tools named as Copilot and Codex name them (Read, Grep and the like become Copilot's
`search`, Edit and Write `edit`; in Codex the planner and generator run `read-only`, the healer
`workspace-write`), and the Claude Code instructions for a missing server replaced by the other
tool's. `bun run pregate` fails when a generated file is out of date. Copilot and Codex start the
server with the first `node` on the path (`PLAYWRIGHT_NODE` is not read) and need the repository
root as the folder they work in.

Copilot and Codex do not read `.claude/settings.json`, so nothing there keeps their agents out of
`sap-tests/.env` and saved sessions: the generated prompts tell them to stay out, which is weaker
than a rule that is enforced. Codex agents also always have a shell, which the Claude Code agents
do not: `read-only` stops them from writing, not from reading any file, and `workspace-write` lets
the healer write anywhere in the repository, not only in `sap-tests/tests` and `sap-tests/helpers`.
Their prompts limit the shell to reading and searching `sap-tests` and rule out git, installs and
running Playwright outside the MCP server; Codex's approval settings (`/approvals`) can make every
command wait for a person. The model is the one chosen in Copilot or Codex. Copilot's cloud
agent on GitHub cannot reach the SAP systems, so no `copilot-setup-steps.yml` is set up. The
healer button in the app uses the Claude Code file only.

After a Playwright upgrade, run `init-agents` again in a scratch folder (with `--loop=claude`,
`vscode` and `codex`) and compare: the tool lists in the agent files name tools of that Playwright
version, and `scripts/agents.ts` follows the other two formats.

#### The healer in the app

With `TEST_APP_HEALER=on`, every failed test of a finished run has a button "Diagnose with healer".
The app then starts the healer of `.claude/agents/playwright-test-healer.md` through the Claude Agent
SDK (`src/lib/server/healer.ts`): the same instructions and tools as in Claude Code, with
Playwright's `run-test-mcp-server` in a headless browser. It reaches Claude like the app's other AI
features: through `TEST_APP_AI` (Vertex AI or Microsoft Foundry, with Claude Code's own switches
for them, and the model of `TEST_APP_AI_MODEL`, on Foundry the deployment), or, on a local app
with `TEST_APP_AI` off, through the Claude login of the computer. The run page shows what it does, its closing
report (the cause, test or application, what it changed) and a diff of every file it changed.

- Its changes stay in the working tree of the app's checkout. Nothing is committed: a person checks
  that no assertion was removed or loosened, puts their name in the line `KI-generiert, geprüft
  von:`, and commits, or presses "Discard the repair", which puts back the files as they were
  before (a file someone changed since is left alone). "Diagnose again" on a repair that was not
  discarded goes on from it: the diff and the discard still go back to before the first session.
- With sign-in on, only an admin can start or stop the healer or discard its repair. Off (the
  default), the run page shows no healer, only what it did before it was turned off.
- The app, not only the instructions, limits the tools: it reads and searches only in
  `sap-tests/tests`, `helpers`, `sap-plugin`, `specs` and `setup` and in `.playwright-mcp`, and it reads the files the tools name in the results of its own test runs,
  but not Playwright's raw network, trace or video files (never a settings file or the saved
  sessions in `.auth`), and
  changes only `.ts` files in `sap-tests/tests` and `sap-tests/helpers`, outside `_demo`, `_plugin`,
  `_reference` and `_agents`. It has no shell. `browser_run_code_unsafe` is refused (it runs code in
  the MCP server's process) and so is any browser tool given a file to save to or read. No settings,
  hooks or MCP servers of Claude Code's configuration apply, nor the claude.ai connectors of the
  Claude login. Its task, which quotes the test's title and error, is given to Claude Code as it is:
  an `@path` in it does not attach a file.
- The MCP server runs the tests in `sap-tests`, so its config reads `sap-tests/.env` as a run's
  does, with the saved settings and only the part of the app's environment the tests use (the
  settings the app knows, variables starting with `SAP_`, `ARIBA_`, `ODATA_`, `IDOC_`, `MFS_`,
  `PLAYWRIGHT_`, `PW_` or `NODE_`, and what the system needs, such as `PATH`, `HOME` and the
  proxy). Not the app's sign-in secret, the AI provider's credentials or the model's key. The
  passwords go to it only. They are not in the model
  process's environment or on its command line (the SDK hands the server's settings over stdin).
  Every answer of the server passes `src/lib/server/healer-mask.ts` before the model sees it, also
  one that ends as an error: it masks the passwords as they are and URL- or form-encoded, login
  headers (`Cookie`, `Set-Cookie`, `Authorization`, `X-CSRF-Token`) and SAP's session cookies
  (`MYSAPSSO2`, `SAP_SESSIONID_…`). What the built-in tools return is masked the same way, and a
  failure of that masking blocks the result. A request
  of the browser's network list can be read only for its response, not for the headers and body
  it sent. Other encodings of a password (Base64 in a hand-made header, for example) are not
  caught.
- **What the app cannot prevent:** the healer changes test code and runs it. That code runs as the
  app's user on the computer or pod of the app, with the test users' passwords: it can read them
  and send them anywhere, in a way that no masking catches, and it can read or change any file that
  user can (the app's database and code included). The limits above apply to the healer's tools,
  not to the code it writes. A misled model (for example by text on an SAP screen or in an error
  message) could do that. So use the healer only with test users of test systems, and read every
  repair before it is committed or run again.
- One healer at a time, and not during a run (a run waits for the healer as well). The results of
  its test runs (traces, screenshots and videos of the SAP screens) are kept with the run
  (`healer/` in the run's folder) and removed with the run's own files
  (`TEST_APP_KEEP_REPORT_DAYS`); its report and the record of the files before it are removed with
  the run's log. The console logs and snapshots of its browser tools, which Playwright writes to
  `.playwright-mcp` at the repository root, are moved there when the session ends (if the app
  stops during a session, they stay at the root). Once a run's files are gone, the healer no
  longer starts on it.

## Development

```bash
bun run check      # svelte-check for the app, tsc for sap-tests
bun run test       # Vitest, two projects (like the reference app):
                   #   server – on Bun, like the app (Bun's SQLite): spec parser, guide rules,
                   #            run overlay, run history. Never touches this computer's
                   #            credential store (src/test/server-setup.ts)
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

- **oxlint** (`.oxlintrc.json`) does almost all linting, type-aware through `oxlint-tsgolint`,
  with Svelte rules from `@rsvelte/oxlint-plugin`. Instead of a hand-picked rule list, the whole
  `correctness`, `suspicious`, `perf` and `pedantic` categories are errors, and the scripts run with
  `--deny-warnings`, so the app stays at zero findings. The few pedantic rules that do not fit are
  turned off in the config, each with its reason.
- **TypeScript** runs with `noUncheckedIndexedAccess`, so `arr[i]` and `record[key]` are typed as
  possibly missing and have to be checked.
- **oxfmt** formats TS/JS/JSON/Markdown/YAML; **Prettier** only formats `.svelte` files.
- **knip** reports unused files, exports and dependencies.
- **Security and type-safety rules** run in oxlint as JS plugins, in the app and in `sap-tests`:
  `eslint-plugin-secure-coding` and `eslint-plugin-browser-security` (credentials in code or URLs,
  injection, unsafe regular expressions, `innerHTML`, secrets in browser storage, …), and five
  rules from [anti-slop](https://github.com/dmmulroy/anti-slop) that flag ways around the type
  checker (`Reflect.get`, `as unknown as T`, `Record<string, unknown>`), vendored in
  `tools/oxlint/anti-slop`. The rule list follows the play-bun-ai project. They are
  heuristics: a clean run does not mean the code is free of these problems.
- **ESLint** keeps only what oxlint cannot do (eslint-plugin-svelte, incl.
  `svelte/no-navigation-without-resolve`); `eslint-plugin-oxlint` turns off everything oxlint runs.
- **sap-tests** has its own oxlint rules (`sap-tests/.oxlintrc.json`, type-aware), run by the same
  `bun run lint`. Their main job is
  `no-floating-promises`: a missing `await` in a recorded flow is the classic source of flaky tests.
  It also enforces the rules of `sap-tests/CLAUDE.md` that a machine can decide: no `waitForTimeout`
  (guide §5.2), `test` and `expect` from sap-plugin in files under `tests/`, and passwords typed
  with `fillSecret` and never written into the code (two rules of our own in
  `sap-tests/tools/oxlint/sap-rules`, which go by field and variable names). `bun run format` uses
  oxfmt with the same style.

CI (`.github/workflows/ci.yml`) runs on every pull request and on pushes to `main`: type check, each
lint/format tool as its own log group, unit/component and e2e tests for the app, plus type check,
lint, format check, spec discovery (`playwright test --list`), the Mock PLC tests, the plugin tests and the API tests on
the mock for `sap-tests`. The SAP flows themselves need a test system and are not run in CI.

A second workflow (`.github/workflows/demo-kit.yml`) runs the flows in `tests/fiori/demokit` against
SAP's public UI5 demo apps every weekday night, and on demand from the Actions tab. They are kept out
of the pull request checks because they depend on a site outside the project. Locally:
`bun run test:demokit` in `sap-tests`.

Both workflows pin each action to a commit, with its version as a comment
(`actions/checkout@<commit> # v7.0.1`): a tag like `v7` can be moved to other code, which would then
run in CI. Dependabot (`.github/dependabot.yml`) opens a pull request each week an action has a new
release, with the new commit and version.

First time: `bunx playwright install chromium` (the app's own Playwright, separate from the
one in `sap-tests`). Where that cannot download, set `CHROMIUM_PATH` to an installed Chromium.

The Svelte MCP server for Claude Code is installed locally and pinned, like in the reference app:

```bash
bun install --cwd .claude/mcp
```

`.mcp.json` points at `.claude/mcp/node_modules/@sveltejs/mcp`; use the `svelte-docs` subagent for
lookups.

`.claude/settings.json` keeps Claude Code away from `sap-tests/.env`: the file tools are denied
there, and a hook (`.claude/hooks/guard-dotenv.ts`) refuses shell commands (the Bash and Monitor
tools) that name a `.env` file
(also `.env.local` and the like; not `.env.example` or `.env.test`), except to ask whether it
exists. The hook reads the command text, so it stops `cat sap-tests/.env` but not a path built from
a glob or a search of the whole folder; it is a tripwire, not a wall. It also refuses a command
whose text merely mentions the name, such as a commit message or a search for `'\.env'`; that text
goes into a file (`git commit -F`, `grep -f`). If the hook cannot run, for example without `bun`, every shell command is
refused until it can.

Skills for Claude Code are in `.claude/skills/` (Svelte 5 practice and testing, checking before
claiming something works, and how to start and drive this app for a look in the browser); the
README there lists them and where each came from.

### Notes

- SSR is off (`src/routes/+layout.ts`): UI5 Web Components need `window`/`customElements` at
  import time and have no server renderer. Remote functions and `+server` routes still run on the server.
- UI5 loads its "72" font from a CDN by default; behind a strict proxy the app falls back to system fonts.
- Bun installs everything. Stock Playwright runs on Bun 1.4 (the app's own Playwright 1.63 lists and
  runs its e2e tests under `bun --bun`), but the Playwright-SAP fork (1.53) does not: under `bun --bun`
  it exits 0 without loading any test. The app therefore starts both Playwright CLIs with the first
  real `node` on PATH (`PLAYWRIGHT_NODE` overrides). `sap-tests` moved to stock Playwright after this
  was observed; whether its suite also runs on Bun alone has not been tried.
- The specs load as ES modules (the root `package.json` has `"type": "module"`). They were kept as
  CommonJS before: with the fork running the tests, on Node 26, Playwright reported the transpiled
  line numbers, so `file:line` runs found no tests and the flow overlay matched the wrong steps. On
  stock Playwright 1.63 and Node 26 test and step lines come out right (checked when the app moved
  to the root). If they go wrong again, that is the cause.
- The Playwright-SAP recorder takes the SAP login only as `codegen --sap-login <user> <password>`,
  and a command line can be read by every user of the machine. So it runs behind
  `sap-tests/recorder/codegen.cjs`: with `--sap-login-from-env` it reads `SAP_USERNAME` and
  `SAP_PASSWORD` from its environment (from the terminal: `sap-tests/.env`) and adds the login to
  its own copy of the arguments, which the process list does not show. From the terminal:
  `bun run codegen <url> --sap-login-from-env`; do not pass `--sap-login` yourself. For Fiori/WebGUI
  the start URL must be on the same host as `SAP_URL`, so the credentials are never typed into
  another site.
- A run that was still going when the app stopped is shown as interrupted; the app also stops the
  Playwright process when it exits.
- Tests generated in a loop over literal values are listed one per value. Where the values are not
  in the spec file, the test is listed once with its title pattern and matched to run results by
  file and line.
- Settings saved in the app live in the system credential store (macOS Keychain, Windows
  Credential Manager, libsecret on Linux) under the service name `sap-test-lab`. A saved value wins
  over the app's own environment, which wins over `sap-tests/.env` (as in any run: dotenv only
  fills what is not set yet). Runs and recordings started
  from the app get the saved values as environment variables; `bun run test:sap` and
  `bun run codegen` from the terminal do not read the credential store and still need `.env`.
  Where no credential store exists (CI, headless Linux) the page says so and `.env` is used.
  Moving a system's URL to another host removes the saved user and password of that system.
- Passwords go only to `https://` addresses: the Settings page does not save an `http://` address,
  and `fillSecret` (and so `SAPLogin` and every sign-in), the OData tests' basic authentication and
  the recorders refuse one, also when it comes from `.env`. Over `http://` the password would cross
  the network unencrypted. Addresses on this computer (`localhost`, `127.x.x.x`, `::1`) may use
  `http://`, for the OData mock and local stand-ins.
- Not covered (guide §10): SAP GUI for Windows.
- Octane import is not part of this version.
