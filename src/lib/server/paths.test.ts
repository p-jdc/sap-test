import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { toPosix, within } from './paths.js';

describe('within', () => {
	test.each([
		['a file below the root', 'fiori/a.spec.ts', '/data/tests/fiori/a.spec.ts'],
		['the root itself', '', '/data/tests'],
		['a name that only starts with dots', '..hidden/a.ts', '/data/tests/..hidden/a.ts'],
		['a path that leaves and comes back', '../tests/a.ts', '/data/tests/a.ts']
	])('accepts %s', (_what, rel, expected) => {
		expect(within('/data/tests', rel, posix)).toBe(expected);
	});

	test.each([
		['the parent', '..'],
		['a file beside the root', '../secrets.env'],
		['a folder whose name starts like the root', '../tests-old/a.ts'],
		['an absolute path', '/etc/passwd']
	])('refuses %s', (_what, rel) => {
		expect(within('/data/tests', rel, posix)).toBeNull();
	});

	test('works with Windows paths', () => {
		const root = String.raw`C:\lab\tests`;
		expect(within(root, 'fiori/a.spec.ts', win32)).toBe(String.raw`C:\lab\tests\fiori\a.spec.ts`);
		expect(within(root, String.raw`fiori\a.spec.ts`, win32)).toBe(
			String.raw`C:\lab\tests\fiori\a.spec.ts`
		);
		expect(within(root, '', win32)).toBe(root);
		expect(within(root, String.raw`..\secrets.env`, win32)).toBeNull();
		expect(within(root, '../tests-old/a.ts', win32)).toBeNull();
		expect(within(root, String.raw`D:\other\a.ts`, win32)).toBeNull();
	});
});

test('toPosix gives the same relative path on every platform', () => {
	expect(toPosix(String.raw`fiori\demokit\a.spec.ts`, win32.sep)).toBe('fiori/demokit/a.spec.ts');
	expect(toPosix('fiori/demokit/a.spec.ts', posix.sep)).toBe('fiori/demokit/a.spec.ts');
});

/**
 * paths.js loaded fresh for a stand-in test project with these folders. `inside`: in this
 * repository (under the ignored test-results/), where it shares the repository's install;
 * otherwise in the temporary folder, where it brings its own.
 */
async function pathsWith(dirs: string[], inside: boolean) {
	const base = inside ? join(process.cwd(), 'test-results') : tmpdir();
	mkdirSync(base, { recursive: true });
	const root = mkdtempSync(join(base, 'layout-'));
	made.push(root);
	for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true });
	vi.stubEnv('SAP_TESTS_DIR', join(root, 'sap-tests'));
	// The data folder is set, as in every unit test, so app/.data under the working directory
	// is not looked at here; the script test covers moving it.
	vi.stubEnv('TEST_APP_DATA_DIR', join(root, '.data'));
	vi.stubEnv('TEST_APP_PACKAGES_DIR', '');
	vi.resetModules();
	return { root, paths: await import('./paths.js') };
}

const made: string[] = [];

describe('oldLayoutProblem', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	test('names an old install of a test project in this repository: it would load a second Playwright', async () => {
		const { root, paths } = await pathsWith(['sap-tests/tests', 'sap-tests/node_modules'], true);
		expect(paths.oldLayoutProblem()).toContain(join(root, 'sap-tests/node_modules'));
		expect(paths.oldLayoutProblem()).toContain('bun run setup');
		expect(paths.PACKAGES_DIR).toBe(join(process.cwd(), 'node_modules'));
	});

	test('a test project elsewhere keeps its own install, which is not a leftover', async () => {
		const { root, paths } = await pathsWith(['sap-tests/tests', 'sap-tests/node_modules'], false);
		expect(paths.oldLayoutProblem()).toBeUndefined();
		expect(paths.PACKAGES_DIR).toBe(join(root, 'sap-tests/node_modules'));
	});

	test('a test project that does not exist is named, with the hint on relative paths', async () => {
		const { paths } = await pathsWith([], false);
		expect(paths.oldLayoutProblem()).toContain('does not exist');
		expect(paths.oldLayoutProblem()).toContain('repository root');
	});

	test('says nothing for a checkout in the current layout', async () => {
		const { paths } = await pathsWith(['sap-tests/tests'], true);
		expect(paths.oldLayoutProblem()).toBeUndefined();
	});
});
