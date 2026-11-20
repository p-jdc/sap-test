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

/** `node <sap-tests>/node_modules/@playwright/test/cli.js <args>` */
export function playwrightCommand(args: string[]): { cmd: string; args: string[] } {
	return {
		cmd: realNode(),
		args: [resolve(TESTS_ROOT, 'node_modules/@playwright/test/cli.js'), ...args]
	};
}
