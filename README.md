# SAP Test Lab

A test app for the open-source SAP test automation described in *SAP-Testautomatisierung-Leitfaden*
(Playwright + Playwright-SAP for Fiori/UI5, SAP WebGUI and SAP Ariba). It runs Playwright tests,
shows them as step flows, streams runs live, and tracks the pilot's exit criteria.

```
sap-test/
├── app/          SvelteKit 3 + Bun + UI5 Web Components – the Test-App
└── sap-tests/    Playwright-SAP test project (guide §4), driven by the app
```

They are separate packages on purpose: `sap-tests` pins the Playwright-SAP fork (Playwright 1.53,
aliased as `@playwright/test`), the app never imports Playwright itself and starts the fork's CLI
in `sap-tests/` with real Node.

## What the app does

| Page | What it shows |
| --- | --- |
| Dashboard | Playwright-SAP version, which `.env` values are set (never their values), suite size per surface, last run, **pilot stability**: consecutive passes per flow against the guide's 10-in-a-row criterion (§4.8) |
| Tests & Flows | Every spec under `sap-tests/tests`, grouped by surface (Fiori / WebGUI / Ariba / Demo), with **rule findings** from the guide's rules file (§5.2): CSS/XPath on SAP screens, `waitForTimeout`, `getByRoleUI5` with two properties, missing assertion after a save, literal passwords, unreviewed `KI-generiert` tests |
| Flow (per test) | The test parsed into a step graph (Svelte Flow): action, locator type (UI5 / SID / SID path / role / CSS…), value, helper used. Overlay of any run: passed / failed / not reached per step with timings, live while a run is in progress. Source panel with the selected step highlighted |
| Runs | Run history; per run: live progress, per-test step timeline, error, screenshot, video, link to the Playwright trace viewer and HTML report |
| Recorder | Starts `playwright codegen --sap-login` (§4.4) with credentials from `sap-tests/.env`, writes `tests/<surface>/<name>.spec.ts`, optionally saves the session (§7.4) |
| Checklist | The guide's §12 rollout checklist, persisted |

Run data (state, logs, HTML report, traces) lives in `app/.data/runs/<id>/`.

## Setup

Requirements: Node 22 (Playwright-SAP) and Bun ≥ 1.4 (app). Run everything from the repo root:

```bash
bun run setup          # installs app/ (bun) and sap-tests/ (npm) plus both Chromium builds
cp sap-tests/.env.example sap-tests/.env   # SAP_URL / SAP_USERNAME / SAP_PASSWORD (test system, user without MFA)
bun run dev            # http://localhost:5173
```

| Root script | Does |
| --- | --- |
| `dev`, `build`, `preview`, `start` | The app (`start` serves the production build via adapter-bun) |
| `check` | svelte-check for the app, `tsc` for sap-tests |
| `lint`, `lint:light`, `format` | oxlint/oxfmt/Prettier/knip/ESLint for the app, oxlint/oxfmt for sap-tests |
| `test`, `test:unit`, `test:e2e` | App tests (Vitest once / watch, Playwright e2e) |
| `test:sap`, `test:sap:list` | Run the SAP suite directly / list its tests |
| `codegen`, `report` | Playwright-SAP recorder and HTML report |
| `ci` | Everything CI runs, in order |
| `setup:mcp` | Installs the local Svelte MCP server for Claude Code |

The root is deliberately not a workspace: `app/` (Bun) and `sap-tests/` (npm, Playwright-SAP aliased as
`@playwright/test`) keep separate dependency trees so the fork and the app's own Playwright never collide.

The `_demo` tests run offline against an inline page, so the app has something to show before an SAP
system is connected; the Fiori/WebGUI/Ariba templates skip until their `.env` values are set. One
demo test fails on purpose to produce a trace. `tests/fiori/rule-findings.example.spec.ts` is a
`test.fixme` that shows what the rule check flags. Delete both once real flows exist.

### Settings (environment variables of the app)

| Variable | Default | Purpose |
| --- | --- | --- |
| `SAP_TESTS_DIR` | `../sap-tests` | Test project to drive |
| `TEST_APP_DATA_DIR` | `./.data` | Run history and artifacts |
| `PLAYWRIGHT_NODE` | first `node` on PATH | Node binary used to start Playwright (Bun's `node` shim is skipped) |

In `sap-tests/.env`, `CHROMIUM_PATH` lets the fork use an already installed Chromium where
`playwright install` cannot download.

## Development

```bash
cd app
bun run check      # svelte-check
bun run test       # Vitest, two projects (like the reference app):
                   #   server – Node: spec parser, guide rules, run overlay
                   #   client – real Chromium via @vitest/browser-playwright + vitest-browser-svelte:
                   #            StatusTag, HistoryDots, StepNode inside a real SvelteFlow
bun run test:unit  # same, in watch mode
bun run test:e2e   # Playwright: builds + previews the app, drives dashboard, flows, rule check
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
- **sap-tests** has its own `npm run lint` (oxlint, type-aware). Its main job is
  `no-floating-promises`: a missing `await` in a recorded flow is the classic source of flaky tests.
  It also bans `waitForTimeout` (guide §5.2). `npm run format` uses oxfmt with the same style.

CI (`.github/workflows/ci.yml`) runs on every pull request and on pushes to `main`: type check, each
lint/format tool as its own log group, unit/component and e2e tests for the app, plus type check,
lint, format check and spec discovery (`playwright test --list`) for `sap-tests`. The SAP flows
themselves need a test system and are not run in CI.

First time: `bunx playwright install chromium` (the app's own Playwright, separate from the
fork in `sap-tests`). Where that cannot download, set `CHROMIUM_PATH` to an installed Chromium.

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
- Not covered (guide §10): SAP GUI for Windows.
- Octane import is not part of this version.
