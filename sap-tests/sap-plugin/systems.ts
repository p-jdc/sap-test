// The systems the tests sign in to, from sap-tests/systems.json. playwright.config.ts makes a
// sign-in project and a test project for each; setup/sign-in.setup.ts signs in to each one; the
// test app shows their settings. Adding a system is a row there and a folder under tests/.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * How a system is signed in to:
 * - `sapLogin`: page.SAPLogin, the NetWeaver or Fiori launchpad login of an SAP system.
 * - `ias`: the login page of SAP Cloud Identity Services, which SuccessFactors, IBP and other SAP
 *   cloud applications send you to.
 * - `form`: a login page of the application itself, found by the labels of its user and password
 *   fields and the name of its button.
 * `ias` and `form` also handle a page that asks for the user first and for the password on a
 * second page.
 */
export type SignInMethod =
	| { method: 'sapLogin' }
	| { method: 'ias' }
	| { method: 'form'; user: string; password: string; submit: string };

export type SignInSystem = {
	/** Project name and session file name: lower case letters, digits and dashes. */
	id: string;
	/** Shown in the test app (Settings, Home) and in the sign-in's title. */
	title: string;
	description?: string;
	/** Not needed for the SAP tests to run; the app does not ask for it to get started. */
	optional?: boolean;
	signIn: SignInMethod;
	/** The environment variables (sap-tests/.env or the app's Settings) with the address and the user. */
	env: { url: string; user: string; password: string };
	/** Folders under tests/ whose tests start signed in to this system. */
	tests: string[];
	/** Folders inside those that do not (for example fiori/demokit, SAP's public demo apps). */
	exclude?: string[];
};

export const SYSTEMS_FILE = resolve(__dirname, '..', 'systems.json');

const ID = /^[a-z][a-z0-9-]*$/;
const VAR = /^[A-Z][A-Z0-9_]*$/;
const FOLDER = /^[\w-]+(\/[\w-]+)*$/;

function fail(message: string): never {
	throw new Error(`${SYSTEMS_FILE}: ${message}`);
}

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';
const record = (value: unknown): Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: {};
const isFolderList = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((f) => isText(f) && FOLDER.test(f));

function folders(value: unknown, where: string): string[] {
	if (value === undefined) return [];
	if (!isFolderList(value))
		fail(`${where} must be a list of folders under tests/, like "fiori" or "fiori/demokit"`);
	return value;
}

function method(value: unknown, where: string): SignInMethod {
	const m = record(value);
	if (m.method === 'sapLogin' || m.method === 'ias') return { method: m.method };
	if (m.method === 'form') {
		const { user, password, submit } = m;
		if (!isText(user) || !isText(password) || !isText(submit))
			fail(
				`${where}: method "form" needs "user", "password" and "submit" (field labels and button name)`
			);
		return { method: 'form', user, password, submit };
	}
	return fail(`${where}.method must be "sapLogin", "ias" or "form"`);
}

const inside = (folder: string, root: string) => folder === root || folder.startsWith(`${root}/`);

/** Reads and checks systems.json. Every problem is an error that names the file. */
export function parseSystems(text: string): SignInSystem[] {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch (error) {
		return fail(`not valid JSON: ${String(error)}`);
	}
	const list = record(data).systems;
	if (!Array.isArray(list)) fail('needs a "systems" list');
	const systems = list.map((raw, i): SignInSystem => {
		const s = record(raw);
		const where = `systems[${i}]`;
		if (!isText(s.id) || !ID.test(s.id) || s.id === 'chromium')
			fail(`${where}.id must be lower case letters, digits and dashes, and not "chromium"`);
		if (!isText(s.title)) fail(`${where}.title is missing`);
		const env = record(s.env);
		for (const key of ['url', 'user', 'password'] as const) {
			const name = env[key];
			if (!isText(name) || !VAR.test(name))
				fail(`${where}.env.${key} must be a variable name like SAP_URL`);
		}
		if (!String(env.url).endsWith('_URL')) fail(`${where}.env.url must end with _URL`);
		const tests = folders(s.tests, `${where}.tests`);
		if (tests.length === 0) fail(`${where}.tests needs at least one folder`);
		const exclude = folders(s.exclude, `${where}.exclude`);
		for (const e of exclude)
			if (!tests.some((t) => e.startsWith(`${t}/`)))
				fail(`${where}.exclude: "${e}" is not inside one of its tests folders`);
		return {
			id: s.id,
			title: s.title,
			...(isText(s.description) ? { description: s.description } : {}),
			...(s.optional === true ? { optional: true } : {}),
			signIn: method(s.signIn, `${where}.signIn`),
			env: { url: String(env.url), user: String(env.user), password: String(env.password) },
			tests,
			...(exclude.length > 0 ? { exclude } : {})
		};
	});
	systems.forEach((a, i) => {
		for (const b of systems.slice(i + 1)) {
			if (a.id === b.id) fail(`the id "${a.id}" is used twice`);
			// A test in two systems' folders would run twice, signed in to each.
			for (const fa of a.tests)
				for (const fb of b.tests)
					if (inside(fa, fb) || inside(fb, fa))
						fail(`"${a.id}" and "${b.id}" both claim tests/${inside(fa, fb) ? fa : fb}`);
		}
	});
	return systems;
}

let cached: SignInSystem[] | undefined;

export function signInSystems(): SignInSystem[] {
	cached ??= parseSystems(readFileSync(SYSTEMS_FILE, 'utf8'));
	return cached;
}

export function signInSystem(id: string): SignInSystem {
	const system = signInSystems().find((s) => s.id === id);
	if (!system) throw new Error(`No system "${id}" in ${SYSTEMS_FILE}`);
	return system;
}

/** A path separator on any platform. */
const SEP = String.raw`[\\/]`;
const escape = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pathPattern = (folder: string) => folder.split('/').map(escape).join(SEP);

/** Matches the test files that start signed in to the system (its folders, without the excluded ones). */
export function testFiles(system: SignInSystem): RegExp {
	const not = (system.exclude ?? []).map(pathPattern);
	const skip = not.length > 0 ? `(?!(?:${not.join('|')})${SEP})` : '';
	const included = system.tests.map(pathPattern).join('|');
	return new RegExp(`${SEP}tests${SEP}${skip}(?:${included})${SEP}`);
}

/** Selects a system's sign-in in setup/sign-in.setup.ts (its tag) for that system's sign-in project. */
export const signInTag = (system: SignInSystem) => `@sign-in-${system.id}`;
