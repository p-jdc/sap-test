import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { RecorderState } from './recorder.js';

async function recorderWith(envFile: string) {
	const dir = mkdtempSync(join(tmpdir(), 'recorder-'));
	writeFileSync(join(dir, '.env'), envFile);
	vi.stubEnv('SAP_TESTS_DIR', dir);
	vi.resetModules();
	return { dir, recorder: await import('./recorder.js') };
}

const SAP = `SAP_URL=https://sap.example.com/fiori\nSAP_USERNAME=U\nSAP_PASSWORD=P\n`;

beforeEach(() => {
	vi.unstubAllEnvs();
	for (const name of ['SAP_URL', 'SAP_USERNAME', 'SAP_PASSWORD', 'ARIBA_URL']) vi.stubEnv(name, '');
});

// Every case here is refused before the recorder would start a browser.
describe('startRecording refuses', () => {
	test('a start URL on another host when it would log in with the .env credentials', async () => {
		const { dir, recorder } = await recorderWith(SAP);
		const result = await recorder.startRecording({
			surface: 'fiori',
			name: 'Create order',
			url: 'https://evil.example.net/login'
		});
		expect(result.ok).toBe(false);
		expect(JSON.stringify(result)).toContain('same host as SAP_URL');
		expect(recorder.recorderState().status).toBe('idle');
		expect(existsSync(join(dir, 'tests'))).toBe(false);
	});

	test('a name without letters or digits', async () => {
		const { recorder } = await recorderWith(SAP);
		expect(await recorder.startRecording({ surface: 'fiori', name: ' ../ ' })).toEqual({
			ok: false,
			error: 'Give the flow a name.'
		});
	});

	test('another host for WebGUI even when asked to skip the login', async () => {
		const { recorder } = await recorderWith(SAP);
		const result = await recorder.startRecording({
			surface: 'webgui',
			name: 'x',
			url: 'https://evil.example.net/login',
			noLogin: true
		});
		expect(JSON.stringify(result)).toContain('same host as SAP_URL');
	});

	test('missing credentials and a missing URL', async () => {
		const { recorder } = await recorderWith(`SAP_URL=https://sap.example.com\n`);
		const webgui = await recorder.startRecording({ surface: 'webgui', name: 'x' });
		expect(JSON.stringify(webgui)).toContain('SAP_USERNAME / SAP_PASSWORD missing');
		const ariba = await recorder.startRecording({ surface: 'ariba', name: 'x' });
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

async function installedRecorder(mode: 'save' | 'empty' | 'hang') {
	const made = await recorderWith(SAP);
	const pkg = join(made.dir, 'recorder/node_modules/@playwright/test');
	mkdirSync(pkg, { recursive: true });
	writeFileSync(join(pkg, 'cli.js'), FAKE_RECORDER);
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
		const result = await recorder.startRecording({ surface: 'webgui', name: 'x' });
		expect(JSON.stringify(result)).toContain('bun run setup');
		const fiori = await recorder.startRecording({ surface: 'fiori', name: 'x' });
		expect(JSON.stringify(fiori)).toContain('The UI5 recorder is missing');
		expect(recorder.recorderState().status).toBe('idle');
	});

	test('records into the surface folder and points the saved spec at the plugin', async () => {
		const { dir, recorder } = await installedRecorder('save');
		const result = await recorder.startRecording({
			surface: 'webgui',
			name: ' Create Order! ',
			saveStorage: true
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
			'--sap-login',
			'U',
			'P',
			'--save-storage',
			'.auth/webgui.json'
		]);
		expect(existsSync(join(dir, '.auth'))).toBe(true);
	});

	test('keeps the password out of the log, also in output without a final newline', async () => {
		const { recorder } = await installedRecorder('save');
		await recorder.startRecording({ surface: 'webgui', name: 'x' });
		const state = await stateWhen(recorder, ended);
		expect(state.log).toContain('logging in with ***');
		expect(state.log).toContain('a warning without newline');
	});

	test('a recording that wrote no file ends as an error', async () => {
		const { recorder } = await installedRecorder('empty');
		await recorder.startRecording({ surface: 'webgui', name: 'x' });
		const state = await stateWhen(recorder, ended);
		expect(state.status).toBe('error');
		expect(state.log.at(-1)).toBe('The recorder exited with code 0 and wrote no file.');
	});

	test('refuses a second recording and an existing file; stopping ends the recording', async () => {
		const { dir, recorder } = await installedRecorder('hang');
		mkdirSync(join(dir, 'tests/webgui'), { recursive: true });
		writeFileSync(join(dir, 'tests/webgui/taken.spec.ts'), '');
		expect(await recorder.startRecording({ surface: 'webgui', name: 'taken' })).toEqual({
			ok: false,
			error: 'webgui/taken.spec.ts already exists.'
		});

		await recorder.startRecording({ surface: 'webgui', name: 'x' });
		expect(await recorder.startRecording({ surface: 'webgui', name: 'y' })).toEqual({
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
		const result = await recorder.startRecording({ surface: 'fiori', name: 'Create order' });
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
			'--url-from-env'
		]);
	});

	test('a Fiori page without login: any host, no password, saved where no sign-in is needed', async () => {
		const { dir, recorder } = await installedRecorder('save');
		vi.stubEnv('SAP_PASSWORD', 'from-the-app-environment');
		const result = await recorder.startRecording({
			surface: 'fiori',
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
			'Cart demo'
		]);
	});
});

describe('recorderInvocation', () => {
	const env = { SAP_URL: 'https://sap.example.com/fiori', SAP_USERNAME: 'U', SAP_PASSWORD: 'P' };

	test('Fiori records with the UI5 recorder and keeps the password out of the arguments', async () => {
		const { dir, recorder } = await recorderWith(SAP);
		const invocation = recorder.recorderInvocation(
			{ surface: 'fiori', name: ' Create order ', saveStorage: true },
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
			'--save-storage',
			'.auth/fiori.json',
			'--url-from-env'
		]);
		expect(invocation.env).toEqual({ SAP_USERNAME: 'U', SAP_PASSWORD: 'P' });
		expect(invocation.needs.path).toBe(join(dir, 'sap-plugin', 'record.mjs'));
	});

	test('a start page other than SAP_URL is written into the spec as it is', async () => {
		const { recorder } = await recorderWith(SAP);
		const { args } = recorder.recorderInvocation(
			{ surface: 'fiori', name: 'x' },
			'fiori/x.spec.ts',
			'https://sap.example.com/fiori#Shell-home',
			env
		);
		expect(args).not.toContain('--url-from-env');
	});

	test('without login the recorder gets no login flag and no credentials', async () => {
		const { recorder } = await recorderWith(SAP);
		const invocation = recorder.recorderInvocation(
			{ surface: 'fiori', name: 'cart', noLogin: true },
			'fiori/cart.spec.ts',
			'https://ui5.example.com/cart/index.html',
			env
		);
		expect(invocation.args).not.toContain('--login');
		expect(invocation.args).not.toContain('P');
		expect(invocation.env).toEqual({ SAP_USERNAME: '', SAP_PASSWORD: '' });
	});

	test('WebGUI and Ariba still record with the Playwright-SAP recorder', async () => {
		const { dir, recorder } = await recorderWith(SAP);
		const fork = join(dir, 'recorder', 'node_modules', '@playwright', 'test');
		const webgui = recorder.recorderInvocation(
			{ surface: 'webgui', name: 'x' },
			'webgui/x.spec.ts',
			env.SAP_URL,
			env
		);
		expect(webgui.args).toEqual([
			join(fork, 'cli.js'),
			'codegen',
			env.SAP_URL,
			'--target',
			'playwright-test',
			'-o',
			'tests/webgui/x.spec.ts',
			'--sap-login',
			'U',
			'P'
		]);
		expect(webgui.needs.path).toBe(fork);
		const ariba = recorder.recorderInvocation(
			{ surface: 'ariba', name: 'x' },
			'ariba/x.spec.ts',
			'https://ariba.example.com',
			env
		);
		expect(ariba.args).not.toContain('--sap-login');
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
