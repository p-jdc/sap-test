// The systems the tests sign in to, from sap-tests/systems.json. playwright.config.ts makes a
// sign-in project and a test project for each; setup/sign-in.setup.ts signs in to each one; the
// test app shows their settings. Adding a system is a row there and a folder under tests/.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseSystems as parse } from './systems-schema';
import type { SignInSystem } from './systems-schema';

export type { SignInMethod, SignInSystem } from './systems-schema';

export const SYSTEMS_FILE = resolve(__dirname, '..', 'systems.json');

/** Reads and checks the text of systems.json (systems-schema.ts). Every problem names the file. */
export const parseSystems = (text: string): SignInSystem[] => parse(text, SYSTEMS_FILE);

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
