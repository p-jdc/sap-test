// The rules for sap-tests/systems.json, in one place: the test project builds its projects from
// what this accepts (systems.ts), and the test app checks the file with the same rules
// (app/src/lib/server/systems.ts imports this file). No imports and nothing that depends on where
// the file is: it is bundled into the app's server.

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

const ID = /^[a-z][a-z0-9-]*$/;
const VAR = /^[A-Z][A-Z0-9_]*$/;
const FOLDER = /^[\w-]+(\/[\w-]+)*$/;

type Fail = (message: string) => never;

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- this is where the file is parsed: every value read from it is checked by its user below
const record = (value: unknown): Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: {};
const isFolderList = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((f) => isText(f) && FOLDER.test(f));

function folders(value: unknown, where: string, fail: Fail): string[] {
	if (value === undefined) return [];
	if (!isFolderList(value))
		fail(`${where} must be a list of folders under tests/, like "fiori" or "fiori/demokit"`);
	return value;
}

function method(value: unknown, where: string, fail: Fail): SignInMethod {
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

/**
 * The system whose sign-in a test file starts with, the same rule as sap-plugin/systems.ts
 * (testFiles): inside one of its folders and not inside one it excludes. `file` is relative to
 * tests/, with `/`.
 */
export function systemOfFile<T extends Pick<SignInSystem, 'tests' | 'exclude'>>(
	file: string,
	systems: readonly T[]
): T | undefined {
	return systems.find(
		(s) =>
			s.tests.some((t) => file.startsWith(`${t}/`)) &&
			!(s.exclude ?? []).some((e) => file.startsWith(`${e}/`))
	);
}

/**
 * The settings of the test project that belong to no system. A system must not use their names.
 */
export const FIXED_SETTINGS = [
	'SAP_API_URL',
	'SAP_API_USERNAME',
	'SAP_API_PASSWORD',
	'SAP_CLIENT',
	'CHROMIUM_PATH',
	// self-signed.ts
	'SAP_SELF_SIGNED_HOST',
	// The SAP systems the IDoc receiver sends IDocs into (idoc/server.mts). The receiver gets them, test runs
	// don't: they send through the receiver.
	'IDOC_S4_URL',
	'IDOC_S4_CLIENT',
	'IDOC_S4_USER',
	'IDOC_S4_PASSWORD',
	'IDOC_EWM_URL',
	'IDOC_EWM_CLIENT',
	'IDOC_EWM_USER',
	'IDOC_EWM_PASSWORD',
	// Where the app reads UFT tests from to translate them: a Git repository (src/lib/shared/uft.ts).
	// Only the app reads them; test runs and recordings never get them.
	'UFT_GIT_URL',
	'UFT_GIT_BRANCH',
	'UFT_GIT_USER',
	'UFT_GIT_TOKEN'
] as const;

// A value saved for a setting becomes an environment variable of every run. Names that the
// shell, Node, Bun, Playwright or the app read themselves are not settings.
const RESERVED =
	/^(?:PATH|HOME|USER|SHELL|CI|DEBUG|TMPDIR|(?:NODE|NPM|BUN|PLAYWRIGHT|PW|TEST_APP|MFS)_.*)$/;

/**
 * Checks the text of systems.json. Every problem is an error that names `file`.
 */
export function parseSystems(text: string, file: string): SignInSystem[] {
	const fail: Fail = (message) => {
		throw new Error(`${file}: ${message}`);
	};
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
			if (RESERVED.test(name))
				fail(`${where}.env.${key}: "${name}" is a variable other programs read, not a setting`);
		}
		if (!String(env.url).endsWith('_URL')) fail(`${where}.env.url must end with _URL`);
		const tests = folders(s.tests, `${where}.tests`, fail);
		if (tests.length === 0) fail(`${where}.tests needs at least one folder`);
		const exclude = folders(s.exclude, `${where}.exclude`, fail);
		for (const e of exclude)
			if (!tests.some((t) => e.startsWith(`${t}/`)))
				fail(`${where}.exclude: "${e}" is not inside one of its tests folders`);
		return {
			id: s.id,
			title: s.title,
			...(isText(s.description) ? { description: s.description } : {}),
			...(s.optional === true ? { optional: true } : {}),
			signIn: method(s.signIn, `${where}.signIn`, fail),
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
	// One name for two values would hand one system's user or password to another.
	const names: string[] = [...FIXED_SETTINGS];
	for (const system of systems)
		for (const name of [system.env.url, system.env.user, system.env.password]) {
			if (names.includes(name)) fail(`the setting ${name} is used twice`);
			names.push(name);
		}
	return systems;
}
