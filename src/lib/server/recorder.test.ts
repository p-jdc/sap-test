import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { RecorderState } from './recorder.js';
import { must } from '../../test/must.js';
import { copySystems } from '../../test/systems.js';

async function recorderWith(envFile: string, systemsJson?: string) {
	// A stand-in test project, and its install in a folder of its own: the recorders must load from
	// the install the app names (TEST_APP_PACKAGES_DIR), not from one they find next to them.
	const dir = join(mkdtempSync(join(tmpdir(), 'recorder-')), 'sap-tests');
	mkdirSync(dir);
	const packages = mkdtempSync(join(tmpdir(), 'recorder-packages-'));
	vi.stubEnv('TEST_APP_PACKAGES_DIR', packages);
	writeFileSync(join(dir, '.env'), envFile);
	if (systemsJson) writeFileSync(join(dir, 'systems.json'), systemsJson);
	else copySystems(dir);
	vi.stubEnv('SAP_TESTS_DIR', dir);
	vi.resetModules();
	const { readSystems } = await import('./systems.js');
	const { systems } = readSystems();
	/** A system of the stand-in's systems.json. */
	const system = (id: string) => must(systems.find((s) => s.id === id));
	return { dir, packages, systems, system, recorder: await import('./recorder.js') };
}

/** Every login a recorder could inherit from this app's environment, blanked. */
const BLANK = {
	SAP_USERNAME: '',
	SAP_PASSWORD: '',
	ARIBA_USER: '',
	ARIBA_PASS: '',
	SAP_API_USERNAME: '',
	SAP_API_PASSWORD: ''
};

const SAP = `SAP_URL=https://sap.example.com/fiori\nSAP_USERNAME=U\nSAP_PASSWORD=P\n`;

/** This repository's wrapper around the fork's CLI, which the stand-in test projects get a copy of. */
const CODEGEN_WRAPPER = resolve(import.meta.dirname, '../../../sap-tests/recorder/codegen.cjs');

beforeEach(() => {
	vi.unstubAllEnvs();
	for (const name of ['SAP_URL', 'SAP_USERNAME', 'SAP_PASSWORD', 'ARIBA_URL']) vi.stubEnv(name, '');
});

// Every case here is refused before the recorder would start a browser.
describe('startRecording refuses', () => {
	test('a start URL on another host when it would log in with the .env credentials', async () => {
		const { dir, recorder } = await recorderWith(SAP);
		const result = await recorder.startRecording({
			folder: 'fiori',
			name: 'Create order',
			url: 'https://evil.example.net/login'
		});
		expect(result.ok).toBe(false);
		expect(JSON.stringify(result)).toContain('same host as SAP_URL');
		expect(recorder.recorderState().status).toBe('idle');
		expect(existsSync(join(dir, 'tests'))).toBe(false);
	});

	test('a start URL over http, which would send the password unencrypted', async () => {
		const { recorder } = await recorderWith(
			`SAP_URL=http://sap.example.com/fiori\nSAP_USERNAME=U\nSAP_PASSWORD=P\n`
		);
		const fiori = await recorder.startRecording({ folder: 'fiori', name: 'x' });
		expect(JSON.stringify(fiori)).toContain('must start with https://');
		const webgui = await recorder.startRecording({ folder: 'webgui', name: 'x' });
		expect(JSON.stringify(webgui)).toContain('must start with https://');
		expect(recorder.recorderState().status).toBe('idle');
	});

	test('a name without letters or digits', async () => {
		const { recorder } = await recorderWith(SAP);
		expect(await recorder.startRecording({ folder: 'fiori', name: ' ../ ' })).toEqual({
			ok: false,
			error: 'Give the flow a name.'
		});
	});

	test('another host for WebGUI even when asked to skip the login', async () => {
		const { recorder } = await recorderWith(SAP);
		const result = await recorder.startRecording({
			folder: 'webgui',
			name: 'x',
			url: 'https://evil.example.net/login',
			noLogin: true
		});
		expect(JSON.stringify(result)).toContain('same host as SAP_URL');
	});

	test('a folder no system records into', async () => {
		const { recorder } = await recorderWith(SAP);
		const folders = ['_reference', 'nowhere', 'fiori/demokit'];
		const results = await Promise.all(
			folders.map((folder) => recorder.startRecording({ folder, name: 'x' }))
		);
		expect(results).toEqual(
			folders.map((folder) => ({
				ok: false,
				error: `No system in systems.json records into tests/${folder}.`
			}))
		);
	});

	test('missing credentials and a missing URL', async () => {
		const { recorder } = await recorderWith(`SAP_URL=https://sap.example.com\n`);
		const webgui = await recorder.startRecording({ folder: 'webgui', name: 'x' });
		expect(JSON.stringify(webgui)).toContain('SAP_USERNAME / SAP_PASSWORD missing');
		const ariba = await recorder.startRecording({ folder: 'ariba', name: 'x' });
		expect(JSON.stringify(ariba)).toContain('ARIBA_URL is not set');
	});
});

// A stand-in for the Playwright-SAP recorder's CLI: it notes its arguments and, as FAKE_RECORDER
// says, writes the spec a recording would write, exits without one, or waits to be stopped.
const FAKE_RECORDER = String.raw`
const { writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
writeFileSync('argv.json', JSON.stringify(args));
console.log('logging in with ' + args.at(-1));
process.stderr.write('a warning without newline');
const mode = process.env.FAKE_RECORDER;
if (mode === 'save')
	writeFileSync(args[args.indexOf('-o') + 1], "import { test } from '@playwright/test';\n");
if (mode === 'stuck') {
	process.on('SIGTERM', () => {});
	setInterval(() => {}, 1000);
}
if (mode === 'hang') {
	process.on('SIGTERM', () => process.exit(0));
	setInterval(() => {}, 1000);
}
`;

// A stand-in for the UI5 recorder (sap-plugin/record.mjs): it notes its arguments and whether it
// was given credentials, and writes the spec to its second argument.
const FAKE_UI5_RECORDER = String.raw`
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
writeFileSync('argv.json', JSON.stringify(args));
console.log('password: ' + (process.env.SAP_PASSWORD || 'none'));
writeFileSync(args[1], "import { test } from '../../sap-plugin';\n");
`;

type Recorder = Awaited<ReturnType<typeof recorderWith>>['recorder'];

async function installedRecorder(mode: 'save' | 'empty' | 'hang' | 'stuck') {
	const made = await recorderWith(SAP);
	const pkg = join(made.packages, 'playwright-sap-recorder');
	mkdirSync(pkg, { recursive: true });
	writeFileSync(join(pkg, 'cli.js'), FAKE_RECORDER);
	mkdirSync(join(made.dir, 'recorder'), { recursive: true });
	copyFileSync(CODEGEN_WRAPPER, join(made.dir, 'recorder/codegen.cjs'));
	mkdirSync(join(made.dir, 'sap-plugin'), { recursive: true });
	writeFileSync(join(made.dir, 'sap-plugin/record.mjs'), FAKE_UI5_RECORDER);
	vi.stubEnv('FAKE_RECORDER', mode);
	return made;
}

/** Resolves with the state once `done` holds for it. */
async function stateWhen(recorder: Recorder, done: (state: RecorderState) => boolean) {
	await vi.waitFor(() => {
		expect(done(recorder.recorderState())).toBe(true);
	});
	return recorder.recorderState();
}

const ended = (state: RecorderState) => state.status !== 'recording';

describe('startRecording', () => {
	test('says how to install the recorder when it is missing', async () => {
		const { recorder } = await recorderWith(SAP);
		const result = await recorder.startRecording({ folder: 'webgui', name: 'x' });
		expect(JSON.stringify(result)).toContain('bun run setup');
		const fiori = await recorder.startRecording({ folder: 'fiori', name: 'x' });
		expect(JSON.stringify(fiori)).toContain('The UI5 recorder is missing');
		expect(recorder.recorderState().status).toBe('idle');
	});

	test('records into the surface folder and points the saved spec at the plugin', async () => {
		const { dir, recorder } = await installedRecorder('save');
		const result = await recorder.startRecording({
			folder: 'webgui',
			name: ' Create Order! '
		});
		expect(result).toEqual({ ok: true, file: 'webgui/create-order.spec.ts' });
		expect(recorder.recorderState().status).toBe('recording');

		const state = await stateWhen(recorder, ended);
		expect(state.status).toBe('saved');
		expect(state.log.at(-1)).toBe('Saved webgui/create-order.spec.ts');
		expect(readFileSync(join(dir, 'tests/webgui/create-order.spec.ts'), 'utf8')).toBe(
			"import { test } from '../../sap-plugin';\n"
		);
		expect(JSON.parse(readFileSync(join(dir, 'argv.json'), 'utf8'))).toEqual([
			'codegen',
			'https://sap.example.com/fiori',
			'--target',
			'playwright-test',
			'-o',
			'tests/webgui/create-order.spec.ts',
			// Added by recorder/codegen.cjs inside the recorder process, not on its command line.
			'--sap-login',
			'U',
			'P'
		]);
	});

	test('a recorder that does not stop when asked is ended', async () => {
		const { recorder } = await installedRecorder('stuck');
		await recorder.startRecording({ folder: 'webgui', name: 'x' });
		await stateWhen(recorder, (state) => state.log.includes('logging in with ***'));
		recorder.stopRecording(100);
		const state = await stateWhen(recorder, ended);
		expect(state.status).toBe('error');
		expect(state.log).toContain('The recorder did not stop when asked and was ended.');
	});

	test('keeps the password out of the log, also in output without a final newline', async () => {
		const { recorder } = await installedRecorder('save');
		await recorder.startRecording({ folder: 'webgui', name: 'x' });
		const state = await stateWhen(recorder, ended);
		expect(state.log).toContain('logging in with ***');
		expect(state.log).toContain('a warning without newline');
	});

	test('a recording that wrote no file ends as an error', async () => {
		const { recorder } = await installedRecorder('empty');
		await recorder.startRecording({ folder: 'webgui', name: 'x' });
		const state = await stateWhen(recorder, ended);
		expect(state.status).toBe('error');
		expect(state.log.at(-1)).toBe('The recorder exited with code 0 and wrote no file.');
	});

	test('refuses a second recording and an existing file; stopping ends the recording', async () => {
		const { dir, recorder } = await installedRecorder('hang');
		mkdirSync(join(dir, 'tests/webgui'), { recursive: true });
		writeFileSync(join(dir, 'tests/webgui/taken.spec.ts'), '');
		expect(await recorder.startRecording({ folder: 'webgui', name: 'taken' })).toEqual({
			ok: false,
			error: 'webgui/taken.spec.ts already exists.'
		});

		await recorder.startRecording({ folder: 'webgui', name: 'x' });
		expect(await recorder.startRecording({ folder: 'webgui', name: 'y' })).toEqual({
			ok: false,
			error: 'A recording is already running.'
		});
		// Stop only once the stand-in runs (and so listens for the signal).
		await stateWhen(recorder, (state) => state.log.includes('logging in with ***'));
		recorder.stopRecording();
		expect((await stateWhen(recorder, ended)).status).toBe('error');
	});

	test('Fiori records with the UI5 recorder, which gets the password in its environment', async () => {
		const { dir, recorder } = await installedRecorder('save');
		const result = await recorder.startRecording({ folder: 'fiori', name: 'Create order' });
		expect(result).toEqual({ ok: true, file: 'fiori/create-order.spec.ts' });
		const state = await stateWhen(recorder, ended);
		expect(state.status).toBe('saved');
		expect(state.log).toContain('password: ***');
		expect(JSON.parse(readFileSync(join(dir, 'argv.json'), 'utf8'))).toEqual([
			'https://sap.example.com/fiori',
			'tests/fiori/create-order.spec.ts',
			'--name',
			'Create order',
			'--login',
			'--env',
			'SAP_URL,SAP_USERNAME,SAP_PASSWORD',
			'--url-from-env'
		]);
	});

	test('a Fiori page without login: any host, no password, saved where no sign-in is needed', async () => {
		const { dir, recorder } = await installedRecorder('save');
		vi.stubEnv('SAP_PASSWORD', 'from-the-app-environment');
		const result = await recorder.startRecording({
			folder: 'fiori',
			name: 'Cart demo',
			url: 'https://ui5.example.com/cart/index.html',
			noLogin: true
		});
		expect(result).toEqual({ ok: true, file: 'fiori/demokit/cart-demo.spec.ts' });
		const state = await stateWhen(recorder, ended);
		expect(state.status).toBe('saved');
		expect(state.log).toContain('password: none');
		expect(JSON.parse(readFileSync(join(dir, 'argv.json'), 'utf8'))).toEqual([
			'https://ui5.example.com/cart/index.html',
			'tests/fiori/demokit/cart-demo.spec.ts',
			'--name',
			'Cart demo',
			'--env',
			'SAP_URL,SAP_USERNAME,SAP_PASSWORD'
		]);
	});
});

describe('recorderInvocation', () => {
	const env = { SAP_URL: 'https://sap.example.com/fiori', SAP_USERNAME: 'U', SAP_PASSWORD: 'P' };

	test('Fiori records with the UI5 recorder and keeps the password out of the arguments', async () => {
		const { dir, recorder, systems, system } = await recorderWith(SAP);
		const invocation = recorder.recorderInvocation(
			{ recorder: 'ui5', name: ' Create order ' },
			system('sap'),
			systems,
			'fiori/create-order.spec.ts',
			env.SAP_URL,
			env
		);
		expect(invocation.args).toEqual([
			join(dir, 'sap-plugin', 'record.mjs'),
			env.SAP_URL,
			'tests/fiori/create-order.spec.ts',
			'--name',
			'Create order',
			'--login',
			'--env',
			'SAP_URL,SAP_USERNAME,SAP_PASSWORD',
			'--url-from-env'
		]);
		expect(invocation.env).toEqual({ ...BLANK, SAP_USERNAME: 'U', SAP_PASSWORD: 'P' });
		expect(invocation.needs.path).toBe(join(dir, 'sap-plugin', 'record.mjs'));
	});

	test('a start page other than SAP_URL is written into the spec as it is', async () => {
		const { recorder, systems, system } = await recorderWith(SAP);
		const { args } = recorder.recorderInvocation(
			{ recorder: 'ui5', name: 'x' },
			system('sap'),
			systems,
			'fiori/x.spec.ts',
			'https://sap.example.com/fiori#Shell-home',
			env
		);
		expect(args).not.toContain('--url-from-env');
	});

	test('without login the recorder gets no login flag and no credentials', async () => {
		const { recorder, systems, system } = await recorderWith(SAP);
		const invocation = recorder.recorderInvocation(
			{ recorder: 'ui5', name: 'cart', noLogin: true },
			system('sap'),
			systems,
			'fiori/cart.spec.ts',
			'https://ui5.example.com/cart/index.html',
			env
		);
		expect(invocation.args).not.toContain('--login');
		expect(invocation.args).not.toContain('P');
		expect(invocation.env).toEqual(BLANK);
	});

	test('WebGUI records with the Playwright-SAP recorder, the password not on its command line', async () => {
		const { dir, packages, recorder, systems, system } = await recorderWith(SAP);
		const fork = join(packages, 'playwright-sap-recorder');
		const webgui = recorder.recorderInvocation(
			{ recorder: 'webgui', name: 'x' },
			system('sap'),
			systems,
			'webgui/x.spec.ts',
			env.SAP_URL,
			env
		);
		expect(webgui.args).toEqual([
			join(dir, 'recorder', 'codegen.cjs'),
			'codegen',
			env.SAP_URL,
			'--target',
			'playwright-test',
			'-o',
			'tests/webgui/x.spec.ts',
			'--sap-login-from-env'
		]);
		expect(webgui.env).toEqual({ ...BLANK, SAP_USERNAME: 'U', SAP_PASSWORD: 'P' });
		expect(webgui.needs.path).toBe(fork);
		const ariba = recorder.recorderInvocation(
			{ recorder: 'web', name: 'x' },
			system('ariba'),
			systems,
			'ariba/x.spec.ts',
			'https://ariba.example.com',
			{ ...env, ARIBA_USER: 'A', ARIBA_PASS: 'AP' }
		);
		// Ariba records with stock Playwright's codegen, not the fork.
		expect(ariba.args).toEqual([
			join(packages, '@playwright', 'test', 'cli.js'),
			'codegen',
			'https://ariba.example.com',
			'--target',
			'playwright-test',
			'-o',
			'tests/ariba/x.spec.ts'
		]);
		expect(ariba.needs.path).toBe(join(packages, '@playwright', 'test'));
		// A person signs in to Ariba: its recorder gets no password, not even Ariba's.
		expect(ariba.env).toEqual(BLANK);
	});

	test('another SAP system records with its own settings, and the spec reads them by name', async () => {
		const { recorder, systems, system } = await recorderWith(SAP, OTHER_SYSTEMS);
		const settings = {
			...env,
			EWM_URL: 'https://ewm.example.com/fiori',
			EWM_USER: 'E',
			EWM_PASSWORD: 'EP'
		};
		const fiori = recorder.recorderInvocation(
			{ recorder: 'ui5', name: 'x' },
			system('ewm'),
			systems,
			'ewm/fiori/x.spec.ts',
			settings.EWM_URL,
			settings
		);
		expect(fiori.args.slice(-3)).toEqual([
			'--env',
			'EWM_URL,EWM_USER,EWM_PASSWORD',
			'--url-from-env'
		]);
		expect(fiori.env).toEqual({
			SAP_USERNAME: '',
			SAP_PASSWORD: '',
			EWM_USER: 'E',
			EWM_PASSWORD: 'EP',
			SF_USER: '',
			SF_PASSWORD: '',
			SAP_API_USERNAME: '',
			SAP_API_PASSWORD: ''
		});
		// The Playwright-SAP recorder reads the login as SAP_USERNAME and SAP_PASSWORD.
		const webgui = recorder.recorderInvocation(
			{ recorder: 'webgui', name: 'x' },
			system('ewm'),
			systems,
			'ewm/webgui/x.spec.ts',
			settings.EWM_URL,
			settings
		);
		expect(webgui.env).toMatchObject({ SAP_USERNAME: 'E', SAP_PASSWORD: 'EP', EWM_PASSWORD: '' });
	});
});

/** A systems.json with a second SAP system and a cloud system that signs in through IAS. */
const OTHER_SYSTEMS = JSON.stringify({
	systems: [
		{
			id: 'sap',
			title: 'SAP test system',
			signIn: { method: 'sapLogin' },
			env: { url: 'SAP_URL', user: 'SAP_USERNAME', password: 'SAP_PASSWORD' },
			tests: ['fiori', 'webgui']
		},
		{
			id: 'ewm',
			title: 'Decentral EWM',
			signIn: { method: 'sapLogin' },
			env: { url: 'EWM_URL', user: 'EWM_USER', password: 'EWM_PASSWORD' },
			tests: ['ewm/fiori', 'ewm/webgui']
		},
		{
			id: 'sf',
			title: 'SuccessFactors',
			signIn: { method: 'ias' },
			env: { url: 'SF_URL', user: 'SF_USER', password: 'SF_PASSWORD' },
			tests: ['successfactors']
		}
	]
});

describe('startRecording for systems.json', () => {
	test('records into the folder of the system it is asked for, signed in with its login', async () => {
		const made = await recorderWith(
			`${SAP}EWM_URL=https://ewm.example.com/fiori\nEWM_USER=E\nEWM_PASSWORD=EP\nSF_URL=https://sf.example.com\n`,
			OTHER_SYSTEMS
		);
		mkdirSync(join(made.dir, 'sap-plugin'), { recursive: true });
		writeFileSync(join(made.dir, 'sap-plugin/record.mjs'), FAKE_UI5_RECORDER);
		const result = await made.recorder.startRecording({ folder: 'ewm/fiori', name: 'Putaway' });
		expect(result).toEqual({ ok: true, file: 'ewm/fiori/putaway.spec.ts' });
		await stateWhen(made.recorder, ended);
		expect(JSON.parse(readFileSync(join(made.dir, 'argv.json'), 'utf8'))).toContain(
			'EWM_URL,EWM_USER,EWM_PASSWORD'
		);
		// The login is checked against the system's own address.
		expect(
			JSON.stringify(
				await made.recorder.startRecording({
					folder: 'ewm/webgui',
					name: 'x',
					url: 'https://sap.example.com/fiori'
				})
			)
		).toContain('same host as EWM_URL');
		// A system that does not sign in with SAP's login needs only its address.
		const sf = await made.recorder.startRecording({ folder: 'successfactors', name: 'x' });
		expect(JSON.stringify(sf)).toContain('bun run setup');
	});
});

describe('withPluginImport', () => {
	test('points a recorded spec at sap-plugin, relative to its folder', async () => {
		const { dir, recorder } = await recorderWith(SAP);
		const recorded = `import { test, expect } from '@playwright/test';\n\ntest('test', async ({ page }) => {\n  await page.getByRoleUI5('Button', { text: 'Save' }).click();\n});\n`;
		const spec = join(dir, 'tests', 'fiori', 'create-order.spec.ts');
		expect(recorder.withPluginImport(recorded, spec)).toBe(
			recorded.replace(`'@playwright/test'`, `'../../sap-plugin'`)
		);
	});
});
