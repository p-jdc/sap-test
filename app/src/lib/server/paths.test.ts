import { posix, win32 } from 'node:path';
import { describe, expect, test } from 'vitest';
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
