import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// The test project's own rules for systems.json, so the app and a run cannot disagree on whether
// the file is valid. The module has no imports and is bundled into the app's server.
import { FIXED_SETTINGS, parseSystems } from '../../../../sap-tests/sap-plugin/systems-schema.js';
import { TESTS_ROOT } from './paths.js';
import type { SettingName, SignInSystemInfo } from '#lib/shared/types.js';

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

/**
 * Reads systems.json. `error` says what is wrong with the file, in words that name it; the
 * systems are then none, so that the pages still open and can show the error. A missing file is
 * no error for the app: a test project without sign-ins.
 */
export function readSystems(file: string = SYSTEMS_FILE): {
	systems: SignInSystemInfo[];
	error?: string;
} {
	if (!existsSync(file)) return { systems: [] };
	try {
		const systems = parseSystems(readFileSync(file, 'utf8'), file).map(
			({ id, title, description, optional, signIn, env }) => {
				const system: SignInSystemInfo = { id, title, method: signIn.method, env };
				if (description) system.description = description;
				if (optional) system.optional = true;
				return system;
			}
		);
		return { systems };
	} catch (e) {
		return { systems: [], error: e instanceof Error ? e.message : String(e) };
	}
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
	return [...systems.map((s) => s.env.password), API_SYSTEM.password];
}
