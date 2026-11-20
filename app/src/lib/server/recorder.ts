import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { readTestEnv } from './env-file.js';
import { lineSplitter } from './lines.js';
import { sameOrigin } from './origin.js';
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
 * the settings and are passed as arguments, never back to the UI); plain codegen for Ariba.
 * The browser opens on the machine running this app.
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

	const args = ['codegen', url, '--target', 'playwright-test', '-o', 'tests/' + file];
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
		args.push('--sap-login', env.SAP_USERNAME, env.SAP_PASSWORD);
	}
	mkdirSync(dirname(full), { recursive: true });
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
	const password = env.SAP_PASSWORD;
	const onLine = (line: string) => {
		if (!line) return;
		// Never echo the password back: it is an argument of the spawned process. Masked per whole
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
