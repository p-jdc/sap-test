import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TESTS_ROOT } from './paths.js';
import type { EnvStatus } from '#lib/shared/types.js';

const KNOWN = [
	'SAP_URL',
	'SAP_USERNAME',
	'SAP_PASSWORD',
	'ARIBA_URL',
	'ARIBA_USER',
	'ARIBA_PASS',
	'CHROMIUM_PATH'
];

function parse(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const eq = line.indexOf('=');
		if (eq < 1) continue;
		let value = line.slice(eq + 1).trim();
		if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
		out[line.slice(0, eq).trim()] = value;
	}
	return out;
}

/** sap-tests/.env merged over process env. Values stay server-side; the UI only sees set/unset. */
export function readTestEnv(): Record<string, string> {
	const file = resolve(TESTS_ROOT, '.env');
	const fromFile = existsSync(file) ? parse(readFileSync(file, 'utf8')) : {};
	const merged: Record<string, string> = {};
	for (const k of KNOWN) {
		const v = fromFile[k] ?? process.env[k];
		if (v) merged[k] = v;
	}
	return { ...fromFile, ...merged };
}

export function envStatus(): EnvStatus {
	const values = readTestEnv();
	let playwrightVersion: string | undefined;
	let playwrightSap = false;
	try {
		const pkg = JSON.parse(
			readFileSync(resolve(TESTS_ROOT, 'node_modules/@playwright/test/package.json'), 'utf8')
		);
		playwrightVersion = pkg.version;
		playwrightSap = pkg.name === '@playwright-sap/test';
	} catch {
		// not installed yet – shown as missing in the UI
	}
	return {
		testsDir: TESTS_ROOT,
		envFile: existsSync(resolve(TESTS_ROOT, '.env')),
		vars: KNOWN.map((name) => ({ name, set: Boolean(values[name]) })),
		playwrightVersion,
		playwrightSap
	};
}
