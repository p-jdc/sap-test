import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { SecretStore } from './secret-store.js';
import { copySystems } from '../../test/systems.js';

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

function withEnvFile(text: string | null, systems: string | null = null) {
	const dir = mkdtempSync(join(tmpdir(), 'env-file-'));
	if (text !== null) writeFileSync(join(dir, '.env'), text);
	if (systems === null) copySystems(dir);
	else writeFileSync(join(dir, 'systems.json'), systems);
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

	test('reads the file the way the test project does (dotenv)', async () => {
		const env = await withEnvFile(
			`export SAP_URL=https://sap.example.com # the test system\nSAP_USERNAME="TEST" # quoted\nSAP_PASSWORD=secret #prod\n`
		);
		expect(await env.readTestEnv(NONE)).toEqual({
			SAP_URL: 'https://sap.example.com',
			SAP_USERNAME: 'TEST',
			SAP_PASSWORD: 'secret'
		});
	});

	test('the process environment wins over the file, as it does in a run', async () => {
		const env = await withEnvFile(`SAP_URL=https://file.example.com\nSAP_USERNAME=FROM_FILE\n`);
		vi.stubEnv('SAP_URL', 'https://process.example.com');
		expect(await env.readTestEnv(NONE)).toMatchObject({
			SAP_URL: 'https://process.example.com',
			SAP_USERNAME: 'FROM_FILE'
		});
		const status = await env.envStatus(NONE);
		expect(status.vars.find((v) => v.name === 'SAP_URL')?.source).toBe('process');
	});
});

describe('runSettings', () => {
	test('masks a password wherever it is set, also one that is not in effect', async () => {
		const env = await withEnvFile(`SAP_PASSWORD=from-file\n`);
		vi.stubEnv('SAP_PASSWORD', 'from-shell');
		expect((await env.runSettings(NONE)).secrets.toSorted()).toEqual(['from-file', 'from-shell']);
		const { store } = fakeStore({ SAP_PASSWORD: 'from-app' });
		expect((await env.runSettings(store)).secrets.toSorted()).toEqual([
			'from-app',
			'from-file',
			'from-shell'
		]);
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
			sapPlugin: false,
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

	test('a run gets the stored values and every password in effect, to mask', async () => {
		const env = await withEnvFile(FILE);
		vi.stubEnv('ARIBA_PASS', 'env-ariba');
		const { store } = fakeStore({ SAP_API_PASSWORD: 'stored-api', ARIBA_USER: 'buyer' });
		expect(await env.runSettings(store)).toEqual({
			env: { SAP_API_PASSWORD: 'stored-api', ARIBA_USER: 'buyer' },
			secrets: ['file-pw', 'env-ariba', 'stored-api']
		});
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

	test('the API system has its own credentials, cleared only when its own URL moves', async () => {
		const env = await withEnvFile(null);
		const { store, values } = fakeStore({
			SAP_URL: 'https://sap.example.com',
			SAP_PASSWORD: 'P',
			SAP_API_URL: 'https://dev.example.com',
			SAP_API_USERNAME: 'API',
			SAP_API_PASSWORD: 'AP',
			SAP_CLIENT: '100'
		});
		expect(await env.keychainEnv(store)).toMatchObject({
			SAP_API_URL: 'https://dev.example.com',
			SAP_CLIENT: '100'
		});
		expect(await env.changeSetting('SAP_API_URL', 'https://other.example.com', store)).toEqual({
			cleared: ['SAP_API_USERNAME', 'SAP_API_PASSWORD']
		});
		// The SAP password stays, with the note of the address it belongs to.
		expect([...values.keys()].toSorted()).toEqual([
			'SAP_API_URL',
			'SAP_CLIENT',
			'SAP_PASSWORD',
			'SAP_PASSWORD@address',
			'SAP_URL'
		]);
	});

	test('a stored user and password are not used once the address moved to another host outside the app', async () => {
		// The address comes from .env; user and password were saved in the app for it.
		const first = await withEnvFile(`SAP_URL=https://sap.example.com/fiori\n`);
		const { store, values } = fakeStore();
		await first.changeSetting('SAP_USERNAME', 'U', store);
		await first.changeSetting('SAP_PASSWORD', 'P', store);
		expect(values.get('SAP_PASSWORD@address')).toBe('https://sap.example.com');
		expect(await first.keychainEnv(store)).toEqual({ SAP_USERNAME: 'U', SAP_PASSWORD: 'P' });

		// Someone points .env at another host: the stored password must not go there.
		const moved = await withEnvFile(`SAP_URL=https://other.example.net/fiori\n`);
		expect(await moved.keychainEnv(store)).toEqual({ SAP_USERNAME: '', SAP_PASSWORD: '' });
		expect((await moved.runSettings(store)).env).toEqual({ SAP_USERNAME: '', SAP_PASSWORD: '' });
		const status = await moved.envStatus(store);
		expect(status.vars.find((v) => v.name === 'SAP_PASSWORD')).toEqual({
			name: 'SAP_PASSWORD',
			set: false,
			source: undefined,
			withheld: 'keychain'
		});

		// Saved again, it belongs to the new address. Another path on the same host changes nothing.
		await moved.changeSetting('SAP_PASSWORD', 'P2', store);
		expect(await moved.keychainEnv(store)).toEqual({ SAP_USERNAME: '', SAP_PASSWORD: 'P2' });
		const samePath = await withEnvFile(`SAP_URL=https://other.example.net/sap/bc/gui\n`);
		expect((await samePath.keychainEnv(store)).SAP_PASSWORD).toBe('P2');
	});

	test('a password stored before addresses were noted is bound to the address it is first used with', async () => {
		const env = await withEnvFile(`SAP_URL=https://sap.example.com\n`);
		const { store, values } = fakeStore({ SAP_PASSWORD: 'P' });
		expect((await env.keychainEnv(store)).SAP_PASSWORD).toBe('P');
		expect(values.get('SAP_PASSWORD@address')).toBe('https://sap.example.com');
		const moved = await withEnvFile(`SAP_URL=https://other.example.net\n`);
		expect((await moved.keychainEnv(store)).SAP_PASSWORD).toBe('');
		// Removing it removes the note too.
		await moved.changeSetting('SAP_PASSWORD', null, store);
		expect(values.size).toBe(0);
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

	test('credentials from .env are not used with a stored URL on another host', async () => {
		const env = await withEnvFile(FILE);
		const { store } = fakeStore();
		await env.changeSetting('SAP_URL', 'https://evil.example.net', store);
		const resolved = await env.readTestEnv(store);
		expect(resolved.SAP_URL).toBe('https://evil.example.net');
		expect(resolved).not.toHaveProperty('SAP_USERNAME');
		expect(resolved).not.toHaveProperty('SAP_PASSWORD');
		// Empty values, so the test project's dotenv does not load them from .env either.
		expect(await env.keychainEnv(store)).toEqual({
			SAP_URL: 'https://evil.example.net',
			SAP_USERNAME: '',
			SAP_PASSWORD: ''
		});
		const status = await env.envStatus(store);
		expect(status.vars.find((v) => v.name === 'SAP_PASSWORD')).toEqual({
			name: 'SAP_PASSWORD',
			set: false,
			source: undefined,
			withheld: 'file'
		});
		expect(JSON.stringify(status)).not.toContain('file-pw');

		// Back on the host of the .env URL, they are used again.
		await env.changeSetting('SAP_URL', 'https://file.example.com/fiori', store);
		expect((await env.readTestEnv(store)).SAP_PASSWORD).toBe('file-pw');
		expect(await env.keychainEnv(store)).toEqual({ SAP_URL: 'https://file.example.com/fiori' });
	});

	test('credentials from the environment, which sets no URL, are not used with a stored URL', async () => {
		const env = await withEnvFile(null);
		vi.stubEnv('SAP_USERNAME', 'ENV_USER');
		vi.stubEnv('SAP_PASSWORD', 'env-pw');
		const { store } = fakeStore({ SAP_URL: 'https://sap.example.com', ARIBA_PASS: 'A' });
		expect(await env.keychainEnv(store)).toEqual({
			SAP_URL: 'https://sap.example.com',
			ARIBA_PASS: 'A',
			SAP_USERNAME: '',
			SAP_PASSWORD: ''
		});
		const status = await env.envStatus(store);
		expect(status.vars.find((v) => v.name === 'SAP_USERNAME')?.withheld).toBe('process');
		// Without a stored URL, the environment's credentials are used as before.
		expect((await env.readTestEnv(fakeStore().store)).SAP_PASSWORD).toBe('env-pw');
	});
});

describe('the SAP systems the IDoc receiver sends into', () => {
	test('reach the receiver, never a run, and their passwords are masked', async () => {
		const env = await withEnvFile(null);
		const { store } = fakeStore({
			IDOC_EWM_URL: 'https://ewm.example.com',
			IDOC_EWM_USER: 'IDOC_IN',
			IDOC_EWM_PASSWORD: 'ewm-pw'
		});
		await env.changeSetting('IDOC_EWM_PASSWORD', 'ewm-pw', store);
		expect(await env.readTestEnv(store)).toMatchObject({
			IDOC_EWM_URL: 'https://ewm.example.com',
			IDOC_EWM_USER: 'IDOC_IN',
			IDOC_EWM_PASSWORD: 'ewm-pw'
		});
		expect(await env.runSettings(store)).toEqual({ env: {}, secrets: ['ewm-pw'] });

		// Moving EWM to another host drops the login saved for the old one.
		expect(await env.changeSetting('IDOC_EWM_URL', 'https://other.example.net', store)).toEqual({
			cleared: ['IDOC_EWM_USER', 'IDOC_EWM_PASSWORD']
		});
		expect(await env.readTestEnv(store)).toEqual({ IDOC_EWM_URL: 'https://other.example.net' });
	});
});

describe('systems from sap-tests/systems.json', () => {
	const successFactors = JSON.stringify({
		systems: [
			{
				id: 'successfactors',
				title: 'SuccessFactors',
				signIn: { method: 'ias' },
				env: { url: 'SF_URL', user: 'SF_USERNAME', password: 'SF_PASSWORD' },
				tests: ['successfactors']
			}
		]
	});

	test('a new system gets settings, a masked password and the credential guard', async () => {
		const env = await withEnvFile(
			'SF_URL=https://sf.example.com\nSF_USERNAME=tester\nSF_PASSWORD=sf-pw\nSAP_PASSWORD=not-a-setting',
			successFactors
		);
		const status = await env.envStatus(NONE);
		expect(status.systems).toEqual([
			{
				id: 'successfactors',
				title: 'SuccessFactors',
				method: 'ias',
				env: { url: 'SF_URL', user: 'SF_USERNAME', password: 'SF_PASSWORD' },
				record: [{ folder: 'successfactors', recorder: 'web' }]
			}
		]);
		expect(status.vars.map((v) => v.name)).toEqual([
			'SF_URL',
			'SF_USERNAME',
			'SF_PASSWORD',
			'SAP_API_URL',
			'SAP_API_USERNAME',
			'SAP_API_PASSWORD',
			'SAP_CLIENT',
			'CHROMIUM_PATH',
			'SAP_SELF_SIGNED_HOST',
			'IDOC_S4_URL',
			'IDOC_S4_CLIENT',
			'IDOC_S4_USER',
			'IDOC_S4_PASSWORD',
			'IDOC_EWM_URL',
			'IDOC_EWM_CLIENT',
			'IDOC_EWM_USER',
			'IDOC_EWM_PASSWORD',
			'UFT_GIT_URL',
			'UFT_GIT_BRANCH',
			'UFT_GIT_USER',
			'UFT_GIT_TOKEN'
		]);
		expect((await env.runSettings(NONE)).secrets).toEqual(['sf-pw']);

		// The address saved in the app points elsewhere: the .env user and password are not sent there.
		const { store } = fakeStore({ SF_URL: 'https://other.example.net' });
		expect(await env.runSettings(store)).toEqual({
			env: { SF_URL: 'https://other.example.net', SF_USERNAME: '', SF_PASSWORD: '' },
			// Withheld from the run, and masked all the same.
			secrets: ['sf-pw']
		});
	});

	test('a broken table is reported with the file name, and the pages still get their status', async () => {
		const twice = JSON.stringify({
			systems: ['a', 'b'].map((id) => ({
				id,
				title: id,
				signIn: { method: 'ias' },
				env: { url: 'X_URL', user: 'X_USER', password: 'X_PASS' },
				tests: [id]
			}))
		});
		const cases: [string, RegExp][] = [
			[twice, /systems\.json: the setting X_URL is used twice/],
			[successFactors.replace('"ias"', '"sso"'), /systems\.json: .*signIn\.method/s],
			[successFactors.replace('SF_PASSWORD', 'NODE_OPTIONS'), /NODE_OPTIONS.*not a setting/],
			['{ "systems": [', /systems\.json: not valid JSON/]
		];
		for (const [table, message] of cases) {
			// oxlint-disable-next-line no-await-in-loop -- each case loads the module afresh
			const env = await withEnvFile(null, table);
			// oxlint-disable-next-line no-await-in-loop
			const status = await env.envStatus(NONE);
			expect(status.systemsError).toMatch(message);
			expect(status.systems).toEqual([]);
			// The settings of no system are still there.
			expect(status.vars.map((v) => v.name)).toContain('SAP_API_URL');
		}
	});

	test('the app accepts exactly what the test project accepts', async () => {
		// Rules the app once did not have: a system needs test folders and an id of its own.
		const noTests = successFactors.replace(',"tests":["successfactors"]', '');
		expect((await (await withEnvFile(null, noTests)).envStatus(NONE)).systemsError).toMatch(
			/tests needs at least one folder/
		);
		const good = await (await withEnvFile(null, successFactors)).envStatus(NONE);
		expect(good.systemsError).toBeUndefined();
		expect(good.systems.map((system) => system.id)).toEqual(['successfactors']);
	});
});
