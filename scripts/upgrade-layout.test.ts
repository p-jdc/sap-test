import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, 'upgrade-layout.ts');

/** A checkout with the given files, each holding its own path. */
function checkout(files: string[]): string {
	const root = mkdtempSync(join(tmpdir(), 'upgrade-'));
	for (const file of files) {
		mkdirSync(join(root, file, '..'), { recursive: true });
		writeFileSync(join(root, file), file);
	}
	return root;
}

function upgrade(root: string) {
	return Bun.spawnSync(['bun', SCRIPT, root], { stdout: 'pipe', stderr: 'pipe' });
}

test('moves the data and the certificate to the root and deletes the old installs', () => {
	const root = checkout([
		'app/.data/app.sqlite',
		'app/cert/key.pem',
		'app/node_modules/x/package.json',
		'sap-tests/node_modules/@playwright/test/package.json',
		'sap-tests/recorder/node_modules/x/package.json',
		'sap-tests/tests/a.spec.ts'
	]);
	expect(upgrade(root).exitCode).toBe(0);
	expect(readFileSync(join(root, '.data/app.sqlite'), 'utf8')).toBe('app/.data/app.sqlite');
	expect(readFileSync(join(root, 'cert/key.pem'), 'utf8')).toBe('app/cert/key.pem');
	expect(existsSync(join(root, 'app/.data'))).toBe(false);
	expect(existsSync(join(root, 'app/node_modules'))).toBe(false);
	expect(existsSync(join(root, 'sap-tests/node_modules'))).toBe(false);
	expect(existsSync(join(root, 'sap-tests/recorder/node_modules'))).toBe(false);
	expect(existsSync(join(root, 'sap-tests/tests/a.spec.ts'))).toBe(true);
});

test('stops and keeps both when the data is in the old and the new place', () => {
	const root = checkout(['app/.data/app.sqlite', '.data/app.sqlite', 'sap-tests/node_modules/x']);
	const result = upgrade(root);
	expect(result.exitCode).toBe(1);
	expect(result.stderr.toString()).toContain('Both app/.data and .data exist');
	expect(existsSync(join(root, 'app/.data/app.sqlite'))).toBe(true);
	expect(existsSync(join(root, '.data/app.sqlite'))).toBe(true);
	// Nothing else changes until the person has decided.
	expect(existsSync(join(root, 'sap-tests/node_modules/x'))).toBe(true);
});

test('does nothing in an up-to-date checkout', () => {
	const root = checkout(['.data/app.sqlite', 'sap-tests/tests/a.spec.ts']);
	const result = upgrade(root);
	expect(result.exitCode).toBe(0);
	expect(result.stdout.toString()).toBe('');
});
