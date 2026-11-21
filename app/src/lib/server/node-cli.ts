import { execFileSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { TESTS_ROOT } from './paths.js';

/**
 * Playwright (and the Playwright-SAP fork) must run on Node. When the app runs under `bun --bun`,
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

/** The Node major the Playwright-SAP fork is run and tested on (README, CI). */
export const REQUIRED_NODE_MAJOR = 22;

/**
 * Why `version` (the output of `node --version`) is not fine for Playwright, or null when it is.
 * Not just a style rule: on Node 26 the fork (Playwright 1.53) records test locations one or more
 * lines off, so running a single test (`file:line`) ends in "No tests found", and its browser
 * install hangs while extracting.
 */
export function nodeWarning(version: string | null, path: string): string | null {
	const fix = `Set PLAYWRIGHT_NODE to a Node ${REQUIRED_NODE_MAJOR} binary and restart the app.`;
	if (!version)
		return `Could not run "${path} --version" to check the Node used for Playwright. ${fix}`;
	const major = Number(/^v?(\d+)\./.exec(version)?.[1]);
	if (major === REQUIRED_NODE_MAJOR) return null;
	return (
		`Playwright runs on Node ${version} (${path}), but Playwright-SAP needs Node ${REQUIRED_NODE_MAJOR}. ` +
		`On other versions it can report wrong test lines, so running a single test finds "No tests found". ${fix}`
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

/** `node <sap-tests>/node_modules/@playwright/test/cli.js <args>` */
export function playwrightCommand(args: string[]): { cmd: string; args: string[] } {
	return {
		cmd: realNode(),
		args: [resolve(TESTS_ROOT, 'node_modules/@playwright/test/cli.js'), ...args]
	};
}
