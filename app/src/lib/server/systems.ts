import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { TESTS_ROOT } from './paths.js';
import type { SettingName, SignInSystemInfo } from '#lib/shared/types.js';

/**
 * The systems the tests sign in to, from sap-tests/systems.json. The test project checks the
 * whole file (sap-plugin/systems.ts) and makes its projects from it; the app needs each system's
 * texts and the names of its settings.
 */
const SYSTEMS_FILE = resolve(TESTS_ROOT, 'systems.json');

const VAR = /^[A-Z][A-Z0-9_]*$/;

const SystemsSchema = z.object({
	systems: z.array(
		z.object({
			id: z.string().regex(/^[a-z][a-z0-9-]*$/),
			title: z.string().min(1),
			description: z.string().optional(),
			optional: z.boolean().optional(),
			signIn: z.object({ method: z.enum(['sapLogin', 'ias', 'form']) }),
			env: z.object({
				url: z.string().regex(VAR).endsWith('_URL'),
				user: z.string().regex(VAR),
				password: z.string().regex(VAR)
			})
		})
	)
});

/** The settings of the test project that belong to no system of systems.json. */
const FIXED_SETTINGS = [
	'SAP_API_URL',
	'SAP_API_USERNAME',
	'SAP_API_PASSWORD',
	'SAP_CLIENT',
	'CHROMIUM_PATH'
] as const satisfies readonly SettingName[];

/** The system the OData tests call: it has credentials, but no sign-in. */
export const API_SYSTEM = {
	url: 'SAP_API_URL',
	user: 'SAP_API_USERNAME',
	password: 'SAP_API_PASSWORD'
} as const;

/** Reads systems.json; none without the file. A broken file is an error that names it. */
export function signInSystems(file: string = SYSTEMS_FILE): SignInSystemInfo[] {
	if (!existsSync(file)) return [];
	const parsed = SystemsSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
	if (!parsed.success) throw new Error(`${file}: ${z.prettifyError(parsed.error)}`);
	const systems = parsed.data.systems.map(({ id, title, description, optional, signIn, env }) => {
		const system: SignInSystemInfo = { id, title, method: signIn.method, env };
		if (description) system.description = description;
		if (optional) system.optional = true;
		return system;
	});
	const names = [
		...FIXED_SETTINGS,
		...systems.flatMap((s) => [s.env.url, s.env.user, s.env.password])
	];
	const twice = names.find((name, i) => names.indexOf(name) !== i);
	if (twice) throw new Error(`${file}: the setting ${twice} is used twice`);
	return systems;
}

/** Every setting the app knows: each system's address, user and password, then the fixed ones. */
export function settingNames(systems = signInSystems()): SettingName[] {
	return [...systems.flatMap((s) => [s.env.url, s.env.user, s.env.password]), ...FIXED_SETTINGS];
}

/** The settings that hold passwords: stored exactly as typed and masked in everything a run records. */
export function secretSettings(systems = signInSystems()): SettingName[] {
	return [...systems.map((s) => s.env.password), API_SYSTEM.password];
}
