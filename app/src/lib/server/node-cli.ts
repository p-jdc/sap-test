import { execFileSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { TESTS_ROOT } from './paths.js';

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

export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	const PATH = (process.env.PATH ?? '')
		.split(delimiter)
		.filter((d) => !isShim(d))
		.join(delimiter);
	return { ...process.env, PATH, ...extra };
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

/** `node <sap-tests>/node_modules/@playwright/test/cli.js <args>`: stock Playwright, runs the tests. */
export function playwrightCommand(args: string[]): { cmd: string; args: string[] } {
	return {
		cmd: realNode(),
		args: [resolve(TESTS_ROOT, 'node_modules/@playwright/test/cli.js'), ...args]
	};
}

/**
 * Where the Playwright-SAP fork is installed. It is used for recording only: its codegen writes
 * SAP locators (getByRoleUI5, locateSID), which sap-tests/sap-plugin runs on stock Playwright.
 */
export const RECORDER_PACKAGE = resolve(TESTS_ROOT, 'recorder/node_modules/@playwright/test');

/** `node <sap-tests>/recorder/node_modules/@playwright/test/cli.js <args>` */
export function recorderCommand(args: string[]): { cmd: string; args: string[] } {
	return { cmd: realNode(), args: [resolve(RECORDER_PACKAGE, 'cli.js'), ...args] };
}
