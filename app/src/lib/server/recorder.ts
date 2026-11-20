import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { readTestEnv } from './env-file.js';
import { childEnv, playwrightCommand } from './node-cli.js';
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

/**
 * Guide §4.4: `codegen <url> --sap-login <user> <password>` for Fiori/WebGUI (credentials come from
 * sap-tests/.env and are passed as arguments, never through the UI); plain codegen for Ariba.
 * The browser opens on the machine running this app.
 */
export function startRecording(
	input: RecordInput
): { ok: true; file: string } | { ok: false; error: string } {
	if (state.status === 'recording') return { ok: false, error: 'A recording is already running.' };
	const env = readTestEnv();
	const slug = input.name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');
	if (!slug) return { ok: false, error: 'Give the flow a name.' };
	const file = `${input.surface}/${slug}.spec.ts`;
	const full = within(TESTS_DIR, file);
	if (!full) return { ok: false, error: 'Invalid file name.' };
	if (existsSync(full)) return { ok: false, error: `${file} already exists.` };
	mkdirSync(dirname(full), { recursive: true });

	const url = input.url || (input.surface === 'ariba' ? env.ARIBA_URL : env.SAP_URL);
	if (!url)
		return {
			ok: false,
			error: `No URL given and ${input.surface === 'ariba' ? 'ARIBA_URL' : 'SAP_URL'} is not set in sap-tests/.env.`
		};

	const args = ['codegen', url, '--target', 'playwright-test', '-o', 'tests/' + file];
	if (input.surface !== 'ariba') {
		if (!env.SAP_USERNAME || !env.SAP_PASSWORD) {
			return { ok: false, error: 'SAP_USERNAME / SAP_PASSWORD missing in sap-tests/.env.' };
		}
		args.push('--sap-login', env.SAP_USERNAME, env.SAP_PASSWORD);
	}
	if (input.saveStorage) {
		mkdirSync(`${TESTS_ROOT}/.auth`, { recursive: true });
		args.push('--save-storage', `.auth/${input.surface}.json`);
	}

	state = {
		status: 'recording',
		file,
		log: [`Recording ${file} – browser opens on the app host.`],
		startedAt: new Date().toISOString()
	};
	const command = playwrightCommand(args);
	proc = spawn(command.cmd, command.args, {
		cwd: TESTS_ROOT,
		env: childEnv(),
		stdio: ['ignore', 'pipe', 'pipe']
	});
	const push = (chunk: Buffer) => {
		// never echo the password back: it is an argument of the spawned process
		const text = chunk.toString().replaceAll(env.SAP_PASSWORD ?? '\u0000', '***');
		state.log.push(...text.split('\n').filter(Boolean));
		state.log = state.log.slice(-200);
	};
	proc.stdout?.on('data', push);
	proc.stderr?.on('data', push);
	proc.on('error', (e) => {
		state = { ...state, status: 'error', log: [...state.log, e.message] };
	});
	proc.on('close', (code) => {
		proc = null;
		const saved = existsSync(full);
		state = {
			...state,
			status: saved ? 'saved' : 'error',
			log: [
				...state.log,
				saved ? `Saved ${file}` : `codegen exited with code ${code} and wrote no file.`
			]
		};
	});
	return { ok: true, file };
}

export function stopRecording() {
	proc?.kill('SIGTERM');
}
