import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { readTestEnv } from './env-file.js';
import { lineSplitter } from './lines.js';
import { sameOrigin } from './origin.js';
import {
	childEnv,
	playwrightNode,
	RECORDER_PACKAGE,
	recorderCommand,
	UI5_RECORDER,
	ui5RecorderCommand
} from './node-cli.js';
import { TESTS_DIR, TESTS_ROOT, within } from './paths.js';

export type RecorderState = {
	status: 'idle' | 'recording' | 'saved' | 'error';
	file?: string;
	log: string[];
	startedAt?: string;
};

let state: RecorderState = { status: 'idle', log: [] };
let proc: ChildProcess | null = null;

export function recorderState(): RecorderState {
	return state;
}

export type RecordInput = {
	surface: 'fiori' | 'webgui' | 'ariba';
	name: string;
	url?: string;
	saveStorage?: boolean;
};

const RECORDED_IMPORT = /from\s+['"]@playwright\/test['"]/;

/**
 * The recorder writes `from '@playwright/test'`, but the SAP methods it uses (page.getByRoleUI5,
 * locateSID, …) exist only on the `test` of sap-tests/sap-plugin. Returns the spec with that import
 * pointed at the plugin, relative to the spec's own folder.
 */
export function withPluginImport(source: string, specFile: string): string {
	const plugin = relative(dirname(specFile), resolve(TESTS_ROOT, 'sap-plugin')).replaceAll(
		'\\',
		'/'
	);
	return source.replace(RECORDED_IMPORT, `from '${plugin}'`);
}

export type Invocation = {
	cmd: string;
	args: string[];
	/** Extra environment for the recorder process. */
	env: Record<string, string>;
	/** What must exist for this recorder to start, and how to get it. */
	needs: { path: string; hint: string };
};

/**
 * The recorder process for one recording. `file` is the spec relative to tests/, `url` the start
 * page, `env` the settings.
 *
 * Fiori records with the UI5 recorder of sap-plugin (stock Playwright): UI5 itself describes each
 * control, so the locators need no positions. It gets the credentials through its environment and
 * writes a spec that starts with page.SAPLogin. WebGUI and Ariba still record with the
 * Playwright-SAP fork in sap-tests/recorder (guide §4.4: `codegen <url> --sap-login <user>
 * <password>`; plain codegen for Ariba), because the UI5 recorder's WebGUI support has not been
 * tried on a real system.
 */
export function recorderInvocation(
	input: Pick<RecordInput, 'surface' | 'name' | 'saveStorage'>,
	file: string,
	url: string,
	env: Record<string, string>
): Invocation {
	const storage = input.saveStorage ? ['--save-storage', `.auth/${input.surface}.json`] : [];
	if (input.surface === 'fiori') {
		const flags = ['--name', input.name.trim(), '--login', ...storage];
		if (url === env.SAP_URL) flags.push('--url-from-env');
		return {
			...ui5RecorderCommand([url, 'tests/' + file, ...flags]),
			env: { SAP_USERNAME: env.SAP_USERNAME ?? '', SAP_PASSWORD: env.SAP_PASSWORD ?? '' },
			needs: {
				path: UI5_RECORDER,
				hint: `The UI5 recorder is missing in ${TESTS_ROOT}/sap-plugin.`
			}
		};
	}
	const login =
		input.surface === 'webgui'
			? ['--sap-login', env.SAP_USERNAME ?? '', env.SAP_PASSWORD ?? '']
			: [];
	return {
		...recorderCommand([
			'codegen',
			url,
			'--target',
			'playwright-test',
			'-o',
			'tests/' + file,
			...login,
			...storage
		]),
		env: {},
		needs: {
			path: RECORDER_PACKAGE,
			hint: `The recorder is not installed in ${TESTS_ROOT}/recorder. Run "bun run setup" in the repo root.`
		}
	};
}

/**
 * Starts a recording. Credentials come from the settings and never go back to the UI. The browser
 * opens on the machine running this app.
 */
export async function startRecording(
	input: RecordInput
): Promise<{ ok: true; file: string } | { ok: false; error: string }> {
	const env = await readTestEnv();
	// Checked after the await: nothing below yields, so two requests cannot both start a recording.
	if (state.status === 'recording') return { ok: false, error: 'A recording is already running.' };
	const slug = input.name
		.trim()
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, '-')
		.replaceAll(/^-|-$/g, '');
	if (!slug) return { ok: false, error: 'Give the flow a name.' };
	const file = `${input.surface}/${slug}.spec.ts`;
	const full = within(TESTS_DIR, file);
	if (!full) return { ok: false, error: 'Invalid file name.' };
	if (existsSync(full)) return { ok: false, error: `${file} already exists.` };

	const url = input.url || (input.surface === 'ariba' ? env.ARIBA_URL : env.SAP_URL);
	if (!url)
		return {
			ok: false,
			error: `No URL given and ${input.surface === 'ariba' ? 'ARIBA_URL' : 'SAP_URL'} is not set (Settings page or sap-tests/.env).`
		};

	if (input.surface !== 'ariba') {
		if (!env.SAP_USERNAME || !env.SAP_PASSWORD) {
			return {
				ok: false,
				error: 'SAP_USERNAME / SAP_PASSWORD missing (Settings page or sap-tests/.env).'
			};
		}
		// The recorder types the credentials into the page it opens, so that page must be the
		// configured system and not any URL a caller sends.
		if (!env.SAP_URL || !sameOrigin(url, env.SAP_URL)) {
			return {
				ok: false,
				error:
					'The recorder logs in with the stored SAP credentials, so the start URL must be on the same host as SAP_URL.'
			};
		}
	}
	const invocation = recorderInvocation(input, file, url, env);
	// Checked last, so a wrong name, URL or missing credentials are reported first.
	if (!existsSync(invocation.needs.path)) return { ok: false, error: invocation.needs.hint };
	mkdirSync(dirname(full), { recursive: true });
	if (input.saveStorage) mkdirSync(`${TESTS_ROOT}/.auth`, { recursive: true });

	// The fork's recorder is the one part that still needs the tested Node; say so where a hang
	// would show.
	const nodeWarning = input.surface === 'fiori' ? null : playwrightNode().warning;
	state = {
		status: 'recording',
		file,
		log: [
			`Recording ${file} – browser opens on the app host.`,
			...(nodeWarning ? [`Warning: ${nodeWarning}`] : [])
		],
		startedAt: new Date().toISOString()
	};
	proc = spawn(invocation.cmd, invocation.args, {
		cwd: TESTS_ROOT,
		env: childEnv(invocation.env),
		stdio: ['ignore', 'pipe', 'pipe']
	});
	const password = env.SAP_PASSWORD;
	const onLine = (line: string) => {
		if (!line) return;
		// Never echo the password back: the recorder process holds it (the fork as an argument, the
		// UI5 recorder in its environment). Masked per whole
		// line, so a password split between two output chunks is still caught.
		state.log.push(password ? line.replaceAll(password, '***') : line);
		state.log = state.log.slice(-200);
	};
	const outputs = [proc.stdout, proc.stderr].flatMap((stream) => {
		if (!stream) return [];
		const lines = lineSplitter(onLine);
		stream.setEncoding('utf8');
		stream.on('data', (chunk: string) => {
			lines.push(chunk);
		});
		return [lines];
	});
	proc.on('error', (e) => {
		state = { ...state, status: 'error', log: [...state.log, e.message] };
	});
	proc.on('close', (code) => {
		proc = null;
		for (const lines of outputs) lines.flush();
		const saved = existsSync(full);
		if (saved) writeFileSync(full, withPluginImport(readFileSync(full, 'utf8'), full));
		state = {
			...state,
			status: saved ? 'saved' : 'error',
			log: [
				...state.log,
				saved ? `Saved ${file}` : `The recorder exited with code ${code} and wrote no file.`
			]
		};
	});
	return { ok: true, file };
}

export function stopRecording() {
	proc?.kill('SIGTERM');
}
