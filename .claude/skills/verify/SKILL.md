---
name: verify
description: How to start this app and drive it in a browser to see a change working (own server on its own port and data directory, chrome-devtools MCP or the e2e tests). Use when a change needs to be seen at the UI, not only in unit tests.
---

# Verifying a change in the Test Lab app

A passing unit test does not show that a page works. This is the recipe for looking.

## First choice: the e2e tests

`bun run test:e2e` (repo root) builds the app, previews it on ports 4180 and 4181 (the second with
sign-in on) with its own data directories, and drives the main flows, including a real run of the
offline demo tests and the Mock PLC. If the change is covered there, or is worth a test there, that
is the verification. Drive a browser by hand only for what these tests do not reach.

## Starting a server of your own

Other sessions and the user run servers from other checkouts at the same time. Never use, stop or
restart a server you did not start.

1. **Take a free port; do not reuse the defaults.** Dev is 5180, preview and e2e are 4180/4181,
   `start` is 3000. Both dev and preview fail when their port is taken (`strictPort`), they do not
   move on. Check first: `lsof -nP -iTCP:<port> -sTCP:LISTEN`.
2. **Give it its own data directory** in the scratchpad, so the run history of the user's app
   stays untouched: `TEST_APP_DATA_DIR=<scratchpad>/data`.
3. **Plain HTTP:** `DEV_HTTP=1`. Without it a checkout with `cert/` serves HTTPS.
4. Start it in the background from the checkout under test and keep the PID:
   - Dev: `DEV_HTTP=1 DEV_PORT=<port> TEST_APP_DATA_DIR=<dir> bun run dev`
   - Built, as in production: `bun run build`, then
     `PORT=<port> ORIGIN=http://127.0.0.1:<port> TEST_APP_DATA_DIR=<dir> bun run start`.
     **Without `ORIGIN` every command (remote function that changes something) answers
     "Forbidden"**, while pages and queries work. That looks like a bug in the change; it is not.
5. A new worktree needs `bun run setup` first.
6. **Stop it by PID when done** (`kill <pid>`). Never `pkill` by name: it takes the user's and
   other sessions' servers with it.

Sign-in is off unless `TEST_APP_AUTH=passkey` is set. With it on, a fresh data directory logs a
one-time setup link for the first admin; `TEST_APP_SETUP_TOKEN` fixes the token (see
`playwright.config.ts` and `tests/sign-in.test.ts` for a working setup with a virtual
passkey).

## Driving it

- Use the chrome-devtools MCP tools (`new_page`, `take_snapshot`, `click`, `fill`,
  `take_screenshot`, `list_console_messages`). Open your own page and close it afterwards; leave
  the user's tabs alone.
- UI5 Web Components render in shadow DOM. Snapshots show their accessible names; for a value
  inside one, read the property with `evaluate_script` on the element instead of the inner DOM.
- After each flow, check `list_console_messages` for errors.
- What can run without an SAP system: the tests under `sap-tests/tests/_demo`, the Mock PLC page
  (`/mfs`), the Mock IDoc page (`/idoc`, with its sample IDocs) and the recorder against a local page. Anything that signs in to a system needs the
  user's systems and credentials: do not read `sap-tests/.env`, and ask before starting a run
  against a real system.
- Live pages hold a streaming request open. On plain HTTP a browser allows six connections per
  host, so close pages you no longer need or later ones hang without an error.

## Reporting

Say what you opened, what you did and what you saw; attach a screenshot when the look is the
point. If a flow could not be checked (no SAP system, sign-in needed), say that instead of
implying it works. Then stop your server and remove your data directory.
