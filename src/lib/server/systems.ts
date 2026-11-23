import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// The test project's own rules for systems.json, so the app and a run cannot disagree on whether
// the file is valid. The module has no imports and is bundled into the app's server.
import {
	FIXED_SETTINGS,
	parseSystems,
	systemOfFile,
	type SignInSystem
} from '../../../sap-tests/sap-plugin/systems-schema.js';
import { TESTS_ROOT } from './paths.js';
import type { RecordTarget, SettingName, SignInSystemInfo } from '#lib/shared/types.js';

/**
 * The systems the tests sign in to, from sap-tests/systems.json. The test project makes its
 * projects from the file (sap-plugin/systems.ts); the app needs each system's texts and the names
 * of its settings.
 */
const SYSTEMS_FILE = resolve(TESTS_ROOT, 'systems.json');

/** The system the OData tests call: it has credentials, but no sign-in. */
export const API_SYSTEM = {
	url: 'SAP_API_URL',
	user: 'SAP_API_USERNAME',
	password: 'SAP_API_PASSWORD'
} as const;

/** The SAP systems the IDoc receiver sends IDocs into: credentials, but no sign-in, and only for the receiver. */
export const IDOC_SYSTEMS = [
	{ url: 'IDOC_S4_URL', user: 'IDOC_S4_USER', password: 'IDOC_S4_PASSWORD' },
	{ url: 'IDOC_EWM_URL', user: 'IDOC_EWM_USER', password: 'IDOC_EWM_PASSWORD' }
] as const;

/** Whether only the IDoc receiver gets this setting, never a test run. */
export function receiverOnly(name: SettingName): boolean {
	return /^IDOC_(S4|EWM)_/.test(name);
}

/**
 * Where a recording for the system can be saved, and with which recorder: each of its folders
 * except those starting with `_` (reference and agent tests). An SAP system records with the UI5
 * recorder, in a folder named `webgui` with the Playwright-SAP recorder signed in to SAP; any other
 * system with stock Playwright's codegen, which starts from the session of the last test run or
 * else lets the person sign in. A UI5 recording without
 * sign-in goes to a folder the system excludes inside the target (fiori/demokit).
 */
function recordTargets(system: SignInSystem): RecordTarget[] {
	return system.tests
		.filter((folder) => !hidden(folder))
		.map((folder): RecordTarget => {
			if (system.signIn.method !== 'sapLogin') return { folder, recorder: 'web' };
			if (folder.split('/').at(-1) === 'webgui') return { folder, recorder: 'webgui' };
			const target: RecordTarget = { folder, recorder: 'ui5' };
			const noLoginFolder = system.exclude?.find((e) => e.startsWith(`${folder}/`));
			if (noLoginFolder) target.noLoginFolder = noLoginFolder;
			return target;
		});
}

/** Reference and agent tests (`_reference`, `x/_agents`): nothing is recorded into them. */
const hidden = (folder: string) => folder.split('/').some((part) => part.startsWith('_'));

function parsed(file: string): { systems: SignInSystem[]; error?: string } {
	if (!existsSync(file)) return { systems: [] };
	try {
		return { systems: parseSystems(readFileSync(file, 'utf8'), file) };
	} catch (e) {
		return { systems: [], error: e instanceof Error ? e.message : String(e) };
	}
}

/**
 * Reads systems.json. `error` says what is wrong with the file, in words that name it; the
 * systems are then none, so that the pages still open and can show the error. A missing file is
 * no error for the app: a test project without sign-ins.
 */
export function readSystems(file: string = SYSTEMS_FILE): {
	systems: SignInSystemInfo[];
	error?: string;
} {
	const { systems, error } = parsed(file);
	const infos = systems.map((s) => {
		const { id, title, description, optional, signIn, env } = s;
		const system: SignInSystemInfo = {
			id,
			title,
			method: signIn.method,
			env,
			record: recordTargets(s)
		};
		if (description) system.description = description;
		if (optional) system.optional = true;
		return system;
	});
	return error ? { systems: infos, error } : { systems: infos };
}

/**
 * For each spec file (relative to tests/), the system its tests start signed in to.
 */
export function systemsOfFiles(
	files: string[],
	file: string = SYSTEMS_FILE
): Map<string, { id: string; title: string } | undefined> {
	const { systems } = parsed(file);
	return new Map(
		files.map((f) => {
			const system = systemOfFile(f, systems);
			return [f, system && { id: system.id, title: system.title }];
		})
	);
}

/** The systems of systems.json; none when the file is missing or broken (see systemsProblem). */
export function signInSystems(file: string = SYSTEMS_FILE): SignInSystemInfo[] {
	return readSystems(file).systems;
}

/** What is wrong with systems.json, or undefined. No run or recording starts while it is broken. */
export function systemsProblem(file: string = SYSTEMS_FILE): string | undefined {
	return readSystems(file).error;
}

/** Every setting the app knows: each system's address, user and password, then the fixed ones. */
export function settingNames(systems = signInSystems()): SettingName[] {
	return [...systems.flatMap((s) => [s.env.url, s.env.user, s.env.password]), ...FIXED_SETTINGS];
}

/** The settings that hold passwords: stored exactly as typed and masked in everything a run records. */
export function secretSettings(systems = signInSystems()): SettingName[] {
	return [
		...systems.map((s) => s.env.password),
		API_SYSTEM.password,
		...IDOC_SYSTEMS.map((s) => s.password)
	];
}
