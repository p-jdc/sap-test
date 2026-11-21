import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { playwrightNode, RECORDER_PACKAGE } from './node-cli.js';
import { sameOrigin } from './origin.js';
import { TESTS_ROOT } from './paths.js';
import { keychain, type SecretStore } from './secret-store.js';
import {
	SETTING_NAMES,
	type EnvStatus,
	type SettingName,
	type SettingSource
} from '#lib/shared/types.js';

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

type Resolved = Map<string, { value: string; source: SettingSource }>;

/**
 * Where each setting comes from. The credential store (Settings page) wins over sap-tests/.env,
 * which wins over the app's own environment.
 */
async function resolveSettings(store: SecretStore): Promise<Resolved> {
	const file = resolve(TESTS_ROOT, '.env');
	const fromFile = existsSync(file) ? parse(readFileSync(file, 'utf8')) : {};
	const out: Resolved = new Map();
	for (const [name, value] of Object.entries(fromFile)) {
		if (value) out.set(name, { value, source: 'file' });
	}
	const stored = await Promise.all(SETTING_NAMES.map((name) => store.get(name)));
	SETTING_NAMES.forEach((name, i) => {
		const secret = stored[i];
		const fromProcess = process.env[name];
		if (secret) out.set(name, { value: secret, source: 'keychain' });
		else if (!out.has(name) && fromProcess)
			out.set(name, { value: fromProcess, source: 'process' });
	});
	return out;
}

/** Every setting with its value. Values stay server-side; the UI only sees set/unset. */
export async function readTestEnv(
	store: SecretStore = keychain()
): Promise<Record<string, string>> {
	const resolved = await resolveSettings(store);
	return Object.fromEntries([...resolved].map(([name, { value }]) => [name, value]));
}

/**
 * The settings held in the credential store, to hand to a Playwright process as environment
 * variables. Values from sap-tests/.env are not included: the test project loads that file itself
 * (dotenv), and dotenv does not replace a variable that is already set, so these win there too.
 */
export async function keychainEnv(
	store: SecretStore = keychain()
): Promise<Record<string, string>> {
	const resolved = await resolveSettings(store);
	return Object.fromEntries(
		[...resolved].flatMap(([name, { value, source }]) =>
			source === 'keychain' ? [[name, value]] : []
		)
	);
}

/** The URL setting of a system and the credentials that belong to it. */
const SYSTEMS: { url: SettingName; credentials: SettingName[] }[] = [
	{ url: 'SAP_URL', credentials: ['SAP_USERNAME', 'SAP_PASSWORD'] },
	{ url: 'ARIBA_URL', credentials: ['ARIBA_USER', 'ARIBA_PASS'] },
	{ url: 'SAP_API_URL', credentials: ['SAP_API_USERNAME', 'SAP_API_PASSWORD'] }
];

/**
 * Saves or removes (value null) one setting in the credential store. When that moves a system's
 * URL to another host, the stored credentials of that system are removed and returned in
 * `cleared`: a password entered for one system must not be sent to another.
 */
export async function changeSetting(
	name: SettingName,
	value: string | null,
	store: SecretStore = keychain()
): Promise<{ cleared: SettingName[] }> {
	const system = SYSTEMS.find((s) => s.url === name);
	const before = system ? (await resolveSettings(store)).get(name)?.value : undefined;
	if (value === null) await store.delete(name);
	else await store.set(name, value);
	if (!system || !before) return { cleared: [] };
	const after = await resolveSettings(store);
	const url = after.get(name)?.value;
	if (url && sameOrigin(before, url)) return { cleared: [] };
	const cleared = system.credentials.filter((c) => after.get(c)?.source === 'keychain');
	await Promise.all(cleared.map((c) => store.delete(c)));
	return { cleared };
}

const PackageSchema = z.object({ version: z.string().optional() });

function packageVersion(packageDir: string): string | undefined {
	try {
		return PackageSchema.parse(
			JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf8'))
		).version;
	} catch {
		return undefined;
	}
}

export async function envStatus(store: SecretStore = keychain()): Promise<EnvStatus> {
	const [resolved, keychainAvailable] = await Promise.all([
		resolveSettings(store),
		store.available()
	]);
	// Not installed yet reads as undefined and is shown as missing in the UI.
	const playwrightVersion = packageVersion(resolve(TESTS_ROOT, 'node_modules/@playwright/test'));
	const recorderVersion = packageVersion(RECORDER_PACKAGE);
	return {
		testsDir: TESTS_ROOT,
		envFile: existsSync(resolve(TESTS_ROOT, '.env')),
		keychain: keychainAvailable,
		vars: SETTING_NAMES.map((name) => {
			const source = resolved.get(name)?.source;
			return { name, set: source !== undefined, source };
		}),
		playwrightVersion,
		sapPlugin: existsSync(resolve(TESTS_ROOT, 'sap-plugin/index.ts')),
		recorderVersion,
		node: playwrightNode()
	};
}
