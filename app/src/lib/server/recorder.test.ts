import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { RecorderState } from './recorder.js';
import { copySystems } from '../../test/systems.js';

async function recorderWith(envFile: string) {
	const dir = mkdtempSync(join(tmpdir(), 'recorder-'));
	writeFileSync(join(dir, '.env'), envFile);
	copySystems(dir);
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

type Recorder = Awaited<ReturnType<typeof recorderWith>>['recorder'];

async function installedRecorder(mode: 'save' | 'empty' | 'hang') {
	const made = await recorderWith(SAP);
	const pkg = join(made.dir, 'recorder/node_modules/@playwright/test');
	mkdirSync(pkg, { recursive: true });
	writeFileSync(join(pkg, 'cli.js'), FAKE_RECORDER);
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
		const result = await recorder.startRecording({ surface: 'fiori', name: 'x' });
		expect(JSON.stringify(result)).toContain('bun run setup');
		expect(recorder.recorderState().status).toBe('idle');
	});

	test('records into the surface folder and points the saved spec at the plugin', async () => {
		const { dir, recorder } = await installedRecorder('save');
		const result = await recorder.startRecording({
			surface: 'fiori',
			name: ' Create Order! ',
			saveStorage: true
		});
		expect(result).toEqual({ ok: true, file: 'fiori/create-order.spec.ts' });
		expect(recorder.recorderState().status).toBe('recording');

		const state = await stateWhen(recorder, ended);
		expect(state.status).toBe('saved');
		expect(state.log.at(-1)).toBe('Saved fiori/create-order.spec.ts');
		expect(readFileSync(join(dir, 'tests/fiori/create-order.spec.ts'), 'utf8')).toBe(
			"import { test } from '../../sap-plugin';\n"
		);
		expect(JSON.parse(readFileSync(join(dir, 'argv.json'), 'utf8'))).toEqual([
			'codegen',
			'https://sap.example.com/fiori',
			'--target',
			'playwright-test',
			'-o',
			'tests/fiori/create-order.spec.ts',
			'--sap-login',
			'U',
			'P',
			'--save-storage',
			'.auth/fiori.json'
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
		await recorder.startRecording({ surface: 'fiori', name: 'x' });
		const state = await stateWhen(recorder, ended);
		expect(state.status).toBe('error');
		expect(state.log.at(-1)).toBe('codegen exited with code 0 and wrote no file.');
	});

	test('refuses a second recording and an existing file; stopping ends the recording', async () => {
		const { dir, recorder } = await installedRecorder('hang');
		mkdirSync(join(dir, 'tests/fiori'), { recursive: true });
		writeFileSync(join(dir, 'tests/fiori/taken.spec.ts'), '');
		expect(await recorder.startRecording({ surface: 'fiori', name: 'taken' })).toEqual({
			ok: false,
			error: 'fiori/taken.spec.ts already exists.'
		});

		await recorder.startRecording({ surface: 'fiori', name: 'x' });
		expect(await recorder.startRecording({ surface: 'fiori', name: 'y' })).toEqual({
			ok: false,
			error: 'A recording is already running.'
		});
		// Stop only once the stand-in runs (and so listens for the signal).
		await stateWhen(recorder, (state) => state.log.includes('logging in with ***'));
		recorder.stopRecording();
		expect((await stateWhen(recorder, ended)).status).toBe('error');
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
