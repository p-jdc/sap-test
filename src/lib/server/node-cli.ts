import { execFileSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { IDOC_SAP_SETTINGS } from '#lib/shared/idoc.js';
import { PACKAGES_DIR, TESTS_ROOT } from './paths.js';

/**
 * Playwright (and the Playwright-SAP recorder) must run on Node. When the app runs under `bun --bun`,
 * Bun prepends a `node` shim directory (…/bun-node-*) to PATH, so a plain `npx playwright` would run
 * under Bun and silently exit. Resolve a real node instead, and strip the shim from the child's PATH.
 */
function isShim(dir: string) {
	return dir.includes('bun-node-');
}

function realNode(): string {
	if (process.env.PLAYWRIGHT_NODE) return process.env.PLAYWRIGHT_NODE;
	for (const dir of (process.env.PATH ?? '').split(delimiter)) {
		if (!dir || isShim(dir)) continue;
		const candidate = join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// keep looking
		}
	}
	return 'node';
}

/**
 * The app's own secrets. Tests, the recorders and the mock servers never need them, so they are
 * not handed on. This is not isolation: a child of the same user can still read the app's own
 * environment (/proc/<pid>/environ on Linux). Only a separate pod or user keeps them from a test.
 */
export const APP_SECRETS = [
	'BETTER_AUTH_SECRET',
	'TEST_APP_SETUP_TOKEN',
	'TEST_APP_RECOVERY_TOKEN',
	'ANTHROPIC_FOUNDRY_API_KEY',
	'ANTHROPIC_API_KEY',
	'GOOGLE_APPLICATION_CREDENTIALS'
];

/**
 * The app's environment for a child process: without Bun's node shim and the app's secrets, and with the IDoc
 * receiver's SAP systems empty. Those only the receiver gets, through `extra`. Empty rather than left out, so that a
 * test run's dotenv doesn't fill them from sap-tests/.env either.
 */
export function childEnv(
	extra: Record<string, string> = {},
	env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
	const PATH = (env.PATH ?? '')
		.split(delimiter)
		.filter((d) => !isShim(d))
		.join(delimiter);
	const kept = Object.fromEntries(
		Object.entries(env).filter(([name]) => !APP_SECRETS.includes(name))
	);
	const noSapSystems = Object.fromEntries(IDOC_SAP_SETTINGS.map((name) => [name, '']));
	return { ...kept, ...noSapSystems, PATH, ...extra };
}

/** The Node major CI runs on, and the only one the Playwright-SAP recorder is tested on (README). */
export const REQUIRED_NODE_MAJOR = 22;

/**
 * Why `version` (the output of `node --version`) is not the tested Node for Playwright, or null
 * when it is. A caution, not a hard failure: the tests run on stock Playwright, which works on newer
 * Node too, but CI runs only 22, and on 26 the recorder's browser install hung while extracting.
 */
export function nodeWarning(version: string | null, path: string): string | null {
	const fix = `Set PLAYWRIGHT_NODE to a Node ${REQUIRED_NODE_MAJOR} binary and restart the app.`;
	if (!version)
		return `Could not run "${path} --version" to check the Node used for Playwright. ${fix}`;
	const major = Number(/^v?(\d+)\./.exec(version)?.[1]);
	if (major === REQUIRED_NODE_MAJOR) return null;
	return (
		`Playwright runs on Node ${version} (${path}). The Playwright-SAP recorder is only tested on Node ${REQUIRED_NODE_MAJOR}; ` +
		`on other versions its browser install has been seen to hang. ${fix}`
	);
}

export type PlaywrightNode = { path: string; version: string | null; warning: string | null };

let checked: PlaywrightNode | undefined;

/** The node that runs Playwright, its version and a warning if it is the wrong one. Checked once. */
export function playwrightNode(): PlaywrightNode {
	if (checked) return checked;
	const path = realNode();
	let version: string | null = null;
	try {
		version = execFileSync(path, ['--version'], {
			encoding: 'utf8',
			env: childEnv(),
			timeout: 5_000
		}).trim();
	} catch {
		// reported through the warning below
	}
	checked = { path, version, warning: nodeWarning(version, path) };
	return checked;
}

/** Stock Playwright: runs the SAP tests, and records Ariba and other web pages. */
export const PLAYWRIGHT_PACKAGE = resolve(PACKAGES_DIR, '@playwright/test');

/** `node node_modules/@playwright/test/cli.js <args>` */
export function playwrightCommand(args: string[]): { cmd: string; args: string[] } {
	return { cmd: realNode(), args: [resolve(PLAYWRIGHT_PACKAGE, 'cli.js'), ...args] };
}

/**
 * Where the Playwright-SAP fork is installed, under its own name so it does not clash with stock
 * Playwright. It records WebGUI only: its codegen signs in to SAP
 * and writes SID locators (getByRoleSID, locateSID), which sap-tests/sap-plugin runs on stock
 * Playwright.
 */
export const RECORDER_PACKAGE = resolve(PACKAGES_DIR, 'playwright-sap-recorder');

/**
 * `node <sap-tests>/recorder/codegen.cjs <args>`: the fork's CLI behind a wrapper that takes the SAP
 * login from the environment (`--sap-login-from-env`), so the password is not on the command line.
 */
export function recorderCommand(args: string[]): { cmd: string; args: string[] } {
	return { cmd: realNode(), args: [resolve(TESTS_ROOT, 'recorder/codegen.cjs'), ...args] };
}

/**
 * The recorder for Fiori/UI5 in sap-tests/sap-plugin: runs on stock Playwright and asks UI5 itself
 * to describe each control, so its locators need no positions.
 */
export const UI5_RECORDER = resolve(TESTS_ROOT, 'sap-plugin/record.mjs');

/** `node <sap-tests>/sap-plugin/record.mjs <args>` */
export function ui5RecorderCommand(args: string[]): { cmd: string; args: string[] } {
	return { cmd: realNode(), args: [UI5_RECORDER, ...args] };
}
