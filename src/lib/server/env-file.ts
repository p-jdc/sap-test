import dotenv from 'dotenv';
import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PLAYWRIGHT_PACKAGE, playwrightNode, RECORDER_PACKAGE } from './node-cli.js';
import { sameOrigin } from './origin.js';
import { TESTS_ROOT } from './paths.js';
import { keychain, type SecretStore } from './secret-store.js';
import {
	API_SYSTEM,
	IDOC_SYSTEMS,
	readSystems,
	secretSettings,
	settingNames,
	signInSystems,
	UFT_GIT_SYSTEM
} from './systems.js';
import { IDOC_SAP_SETTINGS } from '#lib/shared/idoc.js';
import { UFT_SETTINGS } from '#lib/shared/uft.js';
import type { EnvStatus, SettingName, SettingSource } from '#lib/shared/types.js';

/**
 * Reads sap-tests/.env with the parser the test project loads it with (dotenv), so the app sees
 * each value exactly as a run does: comments after a value, `export`, quotes and `\n` included.
 */
function parse(text: string): Record<string, string> {
	return dotenv.parse(text);
}

type Setting = { value: string; source: SettingSource };

type Resolved = {
	/** The settings in effect. */
	values: Map<string, Setting>;
	/** What sap-tests/.env sets, in effect or not. */
	fromFile: Record<string, string>;
	/** Credentials that are set outside the app but not used, with where they are set. */
	withheld: Map<SettingName, SettingSource>;
};

/** The URL setting of each system (systems.json, the OData system, the IDoc targets and the UFT repository) and the credentials that belong to it. */
function credentialGroups(): { url: SettingName; credentials: SettingName[] }[] {
	return [...signInSystems().map((s) => s.env), API_SYSTEM, ...IDOC_SYSTEMS, UFT_GIT_SYSTEM].map(
		({ url, user, password }) => ({
			url,
			credentials: [user, password]
		})
	);
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

/** Under this name the credential store notes the address a stored user or password was saved for. */
const savedFor = (name: SettingName) => `${name}@address`;

function originOf(url: string | undefined): string | undefined {
	try {
		return url ? new URL(url).origin : undefined;
	} catch {
		return undefined;
	}
}

/**
 * A user or password saved in the app belongs to the address its system had when it was saved.
 * The app clears them when its own address setting moves to another host (changeSetting), but
 * the address can also change outside the app, in sap-tests/.env or the environment. So each
 * stored credential carries a note of its address, and one whose system now points at another
 * host is withheld like a credential from .env. A credential stored before this note existed is
 * bound to the address in effect the first time it is read.
 */
async function withholdMoved(
	values: Map<string, Setting>,
	withheld: Map<SettingName, SettingSource>,
	store: SecretStore
): Promise<void> {
	for (const system of credentialGroups()) {
		const origin = originOf(values.get(system.url)?.value);
		if (!origin) continue;
		for (const name of system.credentials) {
			if (values.get(name)?.source !== 'keychain') continue;
			// One system at a time, two small reads each.
			// oxlint-disable-next-line no-await-in-loop
			const saved = await store.get(savedFor(name));
			if (!saved) {
				// oxlint-disable-next-line no-await-in-loop
				await store.set(savedFor(name), origin).catch(() => null);
			} else if (saved !== origin) {
				withheld.set(name, 'keychain');
				values.delete(name);
			}
		}
	}
}

/**
 * Where each setting comes from. The credential store (Settings page) wins over the app's own
 * environment, which wins over sap-tests/.env. That is the order a run sees: stored values are
 * handed to the Playwright process, which otherwise inherits the app's environment, and dotenv
 * there only fills what is not set yet.
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
		else if (fromProcess) values.set(name, { value: fromProcess, source: 'process' });
	});
	const withheld = withholdCredentials(
		values,
		(name) => process.env[name] || fromFile[name] || undefined
	);
	await withholdMoved(values, withheld, store);
	return { values, fromFile, withheld };
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
	// The IDoc receiver's SAP systems and logins: tests send through the receiver and never get them. childEnv
	// empties them for every child process.
	for (const name of IDOC_SAP_SETTINGS) delete vars[name];
	// The repository the UFT tests are read from, and its token: only the app uses them.
	for (const name of UFT_SETTINGS) delete vars[name];
	return vars;
}

/**
 * What a Playwright run needs from the settings: its environment variables (see keychainEnv) and
 * the passwords set anywhere (credential store, environment, .env), to mask in everything the
 * run records.
 */
export async function runSettings(
	store: SecretStore = keychain()
): Promise<{ env: Record<string, string>; secrets: string[] }> {
	const resolved = await resolveSettings(store);
	// Every value a password setting has anywhere, not only the one in effect: masking one too
	// many costs nothing, and a password that is set but shadowed must not show up either.
	const secrets = secretSettings().flatMap((name) =>
		[resolved.values.get(name)?.value, process.env[name], resolved.fromFile[name]].filter(
			(value): value is string => Boolean(value)
		)
	);
	return { env: childVars(resolved), secrets: [...new Set(secrets)] };
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
	const groups = credentialGroups();
	const system = groups.find((s) => s.url === name);
	const before = system ? (await resolveSettings(store)).values.get(name)?.value : undefined;
	if (value === null) await store.delete(name);
	else await store.set(name, value);
	// A user or password is noted with the address it is saved for (withholdMoved).
	const owner = groups.find((s) => s.credentials.includes(name));
	if (owner) {
		const origin =
			value === null
				? undefined
				: originOf((await resolveSettings(store)).values.get(owner.url)?.value);
		if (origin) await store.set(savedFor(name), origin);
		else await store.delete(savedFor(name));
	}
	if (!system || !before) return { cleared: [] };
	const after = await resolveSettings(store);
	const url = after.values.get(name)?.value;
	if (url && sameOrigin(before, url)) return { cleared: [] };
	// Stored credentials of the old address, in use or already withheld.
	const cleared = system.credentials.filter(
		(c) => after.values.get(c)?.source === 'keychain' || after.withheld.get(c) === 'keychain'
	);
	await Promise.all(cleared.flatMap((c) => [store.delete(c), store.delete(savedFor(c))]));
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

function systemsStatus(): Pick<EnvStatus, 'systems' | 'systemsError'> {
	const { systems, error } = readSystems();
	return error ? { systems, systemsError: error } : { systems };
}

export async function envStatus(store: SecretStore = keychain()): Promise<EnvStatus> {
	const [{ values, withheld }, keychainAvailable] = await Promise.all([
		resolveSettings(store),
		store.available()
	]);
	// Not installed yet reads as undefined and is shown as missing in the UI.
	const playwrightVersion = packageVersion(PLAYWRIGHT_PACKAGE);
	const recorderVersion = packageVersion(RECORDER_PACKAGE);
	return {
		testsDir: TESTS_ROOT,
		envFile: existsSync(resolve(TESTS_ROOT, '.env')),
		keychain: keychainAvailable,
		...systemsStatus(),
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
