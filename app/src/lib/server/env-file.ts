import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { playwrightNode, RECORDER_PACKAGE } from './node-cli.js';
import { sameOrigin } from './origin.js';
import { TESTS_ROOT } from './paths.js';
import { keychain, type SecretStore } from './secret-store.js';
import { API_SYSTEM, secretSettings, settingNames, signInSystems } from './systems.js';
import type { EnvStatus, SettingName, SettingSource } from '#lib/shared/types.js';

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

type Setting = { value: string; source: SettingSource };

type Resolved = {
	/** The settings in effect. */
	values: Map<string, Setting>;
	/** Credentials that are set outside the app but not used, with where they are set. */
	withheld: Map<SettingName, SettingSource>;
};

/** The URL setting of each system (systems.json and the OData system) and the credentials that belong to it. */
function credentialGroups(): { url: SettingName; credentials: SettingName[] }[] {
	return [...signInSystems().map((s) => s.env), API_SYSTEM].map(({ url, user, password }) => ({
		url,
		credentials: [user, password]
	}));
}

/**
 * Credentials from sap-tests/.env or the app's environment belong to the URL set there. When the
 * URL saved in the app points at another host, or nothing outside the app sets one, they are
 * withheld (removed from `values`): otherwise saving a URL on the Settings page would send a
 * password kept in .env to that host. Credentials saved in the app are protected by changeSetting.
 */
function withholdCredentials(
	values: Map<string, Setting>,
	outside: (name: SettingName) => string | undefined
): Map<SettingName, SettingSource> {
	const withheld = new Map<SettingName, SettingSource>();
	for (const system of credentialGroups()) {
		const url = values.get(system.url);
		if (url?.source !== 'keychain') continue;
		const outsideUrl = outside(system.url);
		if (outsideUrl && sameOrigin(outsideUrl, url.value)) continue;
		for (const name of system.credentials) {
			const credential = values.get(name);
			if (!credential || credential.source === 'keychain') continue;
			withheld.set(name, credential.source);
			values.delete(name);
		}
	}
	return withheld;
}

/**
 * Where each setting comes from. The credential store (Settings page) wins over sap-tests/.env,
 * which wins over the app's own environment.
 */
async function resolveSettings(store: SecretStore): Promise<Resolved> {
	const file = resolve(TESTS_ROOT, '.env');
	const fromFile = existsSync(file) ? parse(readFileSync(file, 'utf8')) : {};
	const values = new Map<string, Setting>();
	for (const [name, value] of Object.entries(fromFile)) {
		if (value) values.set(name, { value, source: 'file' });
	}
	const names = settingNames();
	const stored = await Promise.all(names.map((name) => store.get(name)));
	names.forEach((name, i) => {
		const secret = stored[i];
		const fromProcess = process.env[name];
		if (secret) values.set(name, { value: secret, source: 'keychain' });
		else if (!values.has(name) && fromProcess)
			values.set(name, { value: fromProcess, source: 'process' });
	});
	const withheld = withholdCredentials(
		values,
		(name) => fromFile[name] || process.env[name] || undefined
	);
	return { values, withheld };
}

/** Every setting in effect with its value. Values stay server-side; the UI only sees set/unset. */
export async function readTestEnv(
	store: SecretStore = keychain()
): Promise<Record<string, string>> {
	const { values } = await resolveSettings(store);
	return Object.fromEntries([...values].map(([name, { value }]) => [name, value]));
}

/**
 * The environment variables to hand to a Playwright process: the settings held in the credential
 * store, and an empty value for each withheld credential. Values from sap-tests/.env are not
 * included: the test project loads that file itself (dotenv), and dotenv does not replace a
 * variable that is already set, even to an empty value, so these win there too.
 */
export async function keychainEnv(
	store: SecretStore = keychain()
): Promise<Record<string, string>> {
	return childVars(await resolveSettings(store));
}

function childVars({ values, withheld }: Resolved): Record<string, string> {
	const vars: Record<string, string> = {};
	for (const [name, { value, source }] of values) if (source === 'keychain') vars[name] = value;
	for (const name of withheld.keys()) vars[name] = '';
	return vars;
}

/**
 * What a Playwright run needs from the settings: its environment variables (see keychainEnv) and
 * the passwords it can use, from wherever they are set, to mask in everything the run records.
 */
export async function runSettings(
	store: SecretStore = keychain()
): Promise<{ env: Record<string, string>; secrets: string[] }> {
	const resolved = await resolveSettings(store);
	const secrets = secretSettings().flatMap((name) => {
		const value = resolved.values.get(name)?.value;
		return value ? [value] : [];
	});
	return { env: childVars(resolved), secrets };
}

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
	const system = credentialGroups().find((s) => s.url === name);
	const before = system ? (await resolveSettings(store)).values.get(name)?.value : undefined;
	if (value === null) await store.delete(name);
	else await store.set(name, value);
	if (!system || !before) return { cleared: [] };
	const after = (await resolveSettings(store)).values;
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
	const [{ values, withheld }, keychainAvailable] = await Promise.all([
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
		systems: signInSystems(),
		vars: settingNames().map((name) => {
			const source = values.get(name)?.source;
			const entry: EnvStatus['vars'][number] = { name, set: source !== undefined, source };
			const unused = withheld.get(name);
			if (unused) entry.withheld = unused;
			return entry;
		}),
		playwrightVersion,
		sapPlugin: existsSync(resolve(TESTS_ROOT, 'sap-plugin/index.ts')),
		recorderVersion,
		node: playwrightNode()
	};
}
