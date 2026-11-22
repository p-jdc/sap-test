/**
 * Bun applies patches/@sveltejs%2Fadapter-bun@<version>.patch only to that exact version, and on a
 * mismatch it merely warns and installs the adapter unpatched: `bun run start` would then ignore
 * TLS_CERT_FILE/HTTP_2 and quietly serve plain HTTP/1.1. This pins the three places that must agree.
 */
import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { z } from 'zod';

const pkg = z
	.object({
		devDependencies: z.record(z.string(), z.string()),
		patchedDependencies: z.record(z.string(), z.string())
	})
	.parse(JSON.parse(readFileSync('package.json', 'utf8')));

test('adapter-bun is pinned to the exact version its patch is keyed to', () => {
	const version = pkg.devDependencies['@sveltejs/adapter-bun'];
	expect(version).toMatch(/^\d+\.\d+\.\d+$/);
	const patch = pkg.patchedDependencies[`@sveltejs/adapter-bun@${String(version)}`];
	expect(patch).toBeDefined();
	expect(existsSync(String(patch))).toBe(true);
});

test('the installed adapter carries the patch', () => {
	const index = readFileSync('node_modules/@sveltejs/adapter-bun/src/index.js', 'utf8');
	expect(index).toContain("env('TLS_CERT_FILE')");
	expect(index).toContain("boolean_env('HTTP_2')");
});
