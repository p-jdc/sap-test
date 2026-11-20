import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { SecretStore } from './secret-store.js';

/** An in-memory stand-in for the system credential store. */
function fakeStore(initial: Record<string, string> = {}, available = true) {
	const values = new Map(Object.entries(initial));
	const store: SecretStore = {
		get: (name) => Promise.resolve(values.get(name) ?? null),
		set: (name, value) => {
			values.set(name, value);
			return Promise.resolve();
		},
		delete: (name) => {
			values.delete(name);
			return Promise.resolve();
		},
		available: () => Promise.resolve(available)
	};
	return { store, values };
}

const NONE = fakeStore({}, false).store;

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
		expect(await env.readTestEnv(NONE)).toEqual({
			SAP_URL: 'https://sap.example.com/a=b',
			SAP_USERNAME: 'TEST USER',
			SAP_PASSWORD: 'p#w'
		});
	});

	test('the file wins over the process environment, which fills what the file lacks', async () => {
		const env = await withEnvFile(`SAP_URL=https://file.example.com\n`);
		vi.stubEnv('SAP_URL', 'https://process.example.com');
		vi.stubEnv('SAP_USERNAME', 'FROM_PROCESS');
		expect(await env.readTestEnv(NONE)).toMatchObject({
			SAP_URL: 'https://file.example.com',
			SAP_USERNAME: 'FROM_PROCESS'
		});
	});
});

describe('envStatus', () => {
	test('reports which variables are set, never their values', async () => {
		const env = await withEnvFile(`SAP_URL=https://sap.example.com\nSAP_PASSWORD=hunter2\n`);
		const status = await env.envStatus(NONE);
		expect(status.envFile).toBe(true);
		expect(status.vars.find((v) => v.name === 'SAP_PASSWORD')).toEqual({
			name: 'SAP_PASSWORD',
			set: true,
			source: 'file'
		});
		expect(status.vars.find((v) => v.name === 'SAP_USERNAME')?.set).toBe(false);
		expect(JSON.stringify(status)).not.toContain('hunter2');
	});

	test('works without an .env file or an installed Playwright', async () => {
		const env = await withEnvFile(null);
		expect(await env.envStatus(NONE)).toMatchObject({
			envFile: false,
			playwrightSap: false,
			keychain: false
		});
	});
});

describe('settings in the credential store', () => {
	const FILE = `SAP_URL=https://file.example.com\nSAP_USERNAME=FILE_USER\nSAP_PASSWORD=file-pw\n`;

	test('a stored value wins over .env, and the status names each source', async () => {
		const env = await withEnvFile(FILE);
		vi.stubEnv('ARIBA_URL', 'https://ariba.example.com');
		const { store } = fakeStore({ SAP_PASSWORD: 'stored-pw' });
		expect(await env.readTestEnv(store)).toMatchObject({
			SAP_USERNAME: 'FILE_USER',
			SAP_PASSWORD: 'stored-pw'
		});
		const status = await env.envStatus(store);
		expect(status.keychain).toBe(true);
		expect(Object.fromEntries(status.vars.map((v) => [v.name, v.source]))).toEqual({
			SAP_URL: 'file',
			SAP_USERNAME: 'file',
			SAP_PASSWORD: 'keychain',
			ARIBA_URL: 'process',
			ARIBA_USER: undefined,
			ARIBA_PASS: undefined,
			CHROMIUM_PATH: undefined
		});
		expect(JSON.stringify(status)).not.toContain('stored-pw');
	});

	test('only stored values are handed to the Playwright process', async () => {
		const env = await withEnvFile(FILE);
		const { store } = fakeStore({ SAP_PASSWORD: 'stored-pw', ARIBA_USER: 'buyer' });
		expect(await env.keychainEnv(store)).toEqual({
			SAP_PASSWORD: 'stored-pw',
			ARIBA_USER: 'buyer'
		});
		expect(await env.keychainEnv(NONE)).toEqual({});
	});

	test('saving and removing a setting changes what is resolved', async () => {
		const env = await withEnvFile(FILE);
		const { store } = fakeStore();
		expect(await env.changeSetting('SAP_USERNAME', 'STORED_USER', store)).toEqual({ cleared: [] });
		expect((await env.readTestEnv(store)).SAP_USERNAME).toBe('STORED_USER');
		await env.changeSetting('SAP_USERNAME', null, store);
		expect((await env.readTestEnv(store)).SAP_USERNAME).toBe('FILE_USER');
	});

	test('moving the URL to another host removes the stored credentials of that system', async () => {
		const env = await withEnvFile(null);
		const { store, values } = fakeStore({
			SAP_URL: 'https://sap.example.com/fiori',
			SAP_USERNAME: 'U',
			SAP_PASSWORD: 'P',
			ARIBA_PASS: 'A'
		});
		expect(await env.changeSetting('SAP_URL', 'https://sap.example.com/other', store)).toEqual({
			cleared: []
		});
		expect(await env.changeSetting('SAP_URL', 'https://evil.example.net', store)).toEqual({
			cleared: ['SAP_USERNAME', 'SAP_PASSWORD']
		});
		expect([...values.keys()].toSorted()).toEqual(['ARIBA_PASS', 'SAP_URL']);
	});

	test('removing a stored URL that hid a different .env URL also removes the credentials', async () => {
		const env = await withEnvFile(FILE);
		const { store, values } = fakeStore({
			SAP_URL: 'https://stored.example.com',
			SAP_PASSWORD: 'P'
		});
		expect(await env.changeSetting('SAP_URL', null, store)).toEqual({ cleared: ['SAP_PASSWORD'] });
		expect(values.size).toBe(0);
	});

	test('the first URL for a system keeps credentials entered before it', async () => {
		const env = await withEnvFile(null);
		const { store, values } = fakeStore({ SAP_USERNAME: 'U', SAP_PASSWORD: 'P' });
		expect(await env.changeSetting('SAP_URL', 'https://sap.example.com', store)).toEqual({
			cleared: []
		});
		expect(values.size).toBe(3);
	});
});
