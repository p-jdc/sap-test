import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';

function withEnvFile(text: string | null) {
	const dir = mkdtempSync(join(tmpdir(), 'env-file-'));
	if (text !== null) writeFileSync(join(dir, '.env'), text);
	vi.stubEnv('SAP_TESTS_DIR', dir);
	vi.resetModules();
	return import('./env-file.js');
}

beforeEach(() => {
	vi.unstubAllEnvs();
	for (const name of ['SAP_URL', 'SAP_USERNAME', 'SAP_PASSWORD', 'ARIBA_URL']) vi.stubEnv(name, '');
});

describe('readTestEnv', () => {
	test('parses values, quotes and comments', async () => {
		const env = await withEnvFile(
			`# comment\nSAP_URL=https://sap.example.com/a=b\n SAP_USERNAME = "TEST USER" \nSAP_PASSWORD='p#w'\n\nnot a line\n`
		);
		expect(env.readTestEnv()).toEqual({
			SAP_URL: 'https://sap.example.com/a=b',
			SAP_USERNAME: 'TEST USER',
			SAP_PASSWORD: 'p#w'
		});
	});

	test('the file wins over the process environment, which fills what the file lacks', async () => {
		const env = await withEnvFile(`SAP_URL=https://file.example.com\n`);
		vi.stubEnv('SAP_URL', 'https://process.example.com');
		vi.stubEnv('SAP_USERNAME', 'FROM_PROCESS');
		expect(env.readTestEnv()).toMatchObject({
			SAP_URL: 'https://file.example.com',
			SAP_USERNAME: 'FROM_PROCESS'
		});
	});
});

describe('envStatus', () => {
	test('reports which variables are set, never their values', async () => {
		const env = await withEnvFile(`SAP_URL=https://sap.example.com\nSAP_PASSWORD=hunter2\n`);
		const status = env.envStatus();
		expect(status.envFile).toBe(true);
		expect(status.vars.find((v) => v.name === 'SAP_PASSWORD')).toEqual({
			name: 'SAP_PASSWORD',
			set: true
		});
		expect(status.vars.find((v) => v.name === 'SAP_USERNAME')?.set).toBe(false);
		expect(JSON.stringify(status)).not.toContain('hunter2');
	});

	test('works without an .env file or an installed Playwright', async () => {
		const env = await withEnvFile(null);
		expect(env.envStatus()).toMatchObject({ envFile: false, playwrightSap: false });
	});
});
