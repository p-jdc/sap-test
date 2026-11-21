// The MFS PLC emulator (sap-tests/mfs) as seen from the app: started as its own process, the way it will run as
// its own service on the cluster later, and reached only through its HTTP control API. The browser never talks to
// the emulator or its PLC ports; the page goes through the remote functions in mfs.remote.ts.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
	EwmStateSchema,
	MfsEventSchema,
	MfsSetupSchema,
	MfsStateSchema,
	MfsTelegramSchema,
	type MfsEvent,
	type MfsMode,
	type MfsSetup,
	type MfsSnapshot,
	type MfsStatus,
	type MfsTelegram
} from '#lib/shared/mfs.js';
import { lineSplitter } from './lines.js';
import { childEnv } from './node-cli.js';
import { TESTS_ROOT } from './paths.js';

const MFS_DIR = resolve(TESTS_ROOT, 'mfs');
export const SETUP_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const READY = 'MFS_READY ';
const START_TIMEOUT_MS = 15_000;
const KEEP = 400;

type Running = {
	proc: ChildProcess;
	url: string;
	setup: string;
	mode: MfsMode;
	speed: number;
	startedAt: string;
	stopping: boolean;
};

let running: Running | null = null;
let lastError: string | undefined;

// The Mock PLC belongs to the app that started it: it must not keep the PLC ports open after the app is gone.
process.once('exit', () => {
	running?.proc.kill('SIGTERM');
});

/** An emulator started elsewhere (on the cluster): the app watches and controls it, but doesn't start it. */
function externalUrl(): string | undefined {
	return process.env.MFS_EMULATOR_URL?.replace(/\/+$/, '') || undefined;
}

/** The mock setups in sap-tests/mfs/setups. */
export function listSetups(): string[] {
	const dir = resolve(MFS_DIR, 'setups');
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && SETUP_NAME.test(entry.name))
		.filter((entry) => existsSync(resolve(dir, entry.name, 'setup.json')))
		.map((entry) => entry.name)
		.toSorted();
}

export function mfsStatus(): MfsStatus {
	if (externalUrl()) return { running: true, external: true };
	if (!running) return { running: false, external: false, error: lastError };
	const { setup, mode, speed, startedAt } = running;
	return { running: true, external: false, setup, mode, speed, startedAt };
}

/** Bun runs the emulator's TypeScript directly; the app itself runs on Bun, so it is always there. */
function bunBinary(): string {
	return process.versions.bun ? process.execPath : 'bun';
}

export type StartInput = { setup: string; mode: MfsMode; speed: number };

/**
 * Starts the emulator and resolves when its control API answers. In `demo` mode the fake EWM runs inside it and
 * the PLC ports are free ones; in `ewm` mode the PLCs listen on MFS_BASE_PORT (default 47101) for a real EWM.
 */
export async function startEmulator(input: StartInput): Promise<void> {
	if (externalUrl()) throw new Error('The emulator is managed elsewhere (MFS_EMULATOR_URL).');
	if (running) throw new Error('The emulator is already running.');
	if (!listSetups().includes(input.setup)) throw new Error(`There is no setup "${input.setup}".`);
	lastError = undefined;
	const demo = input.mode === 'demo';
	const proc = spawn(bunBinary(), [resolve(MFS_DIR, 'server.mts')], {
		cwd: TESTS_ROOT,
		env: childEnv({
			MFS_SETUP: input.setup,
			MFS_SPEED: String(input.speed),
			MFS_CONTROL_PORT: '0',
			MFS_HOST: demo ? '127.0.0.1' : process.env.MFS_HOST || '127.0.0.1',
			MFS_BASE_PORT: demo ? '0' : process.env.MFS_BASE_PORT || '47101',
			MFS_FAKE_EWM: demo ? '1' : ''
		}),
		stdio: ['ignore', 'pipe', 'pipe']
	});
	const output: string[] = [];
	const url = await new Promise<string>((done, failed) => {
		const timer = setTimeout(() => {
			proc.kill('SIGTERM');
			failed(new Error(`The emulator did not start within ${START_TIMEOUT_MS / 1000} s.`));
		}, START_TIMEOUT_MS);
		const onLine = (line: string) => {
			output.push(line);
			if (output.length > 30) output.shift();
			if (!line.startsWith(READY)) return;
			const ready = z
				.object({ control: z.number().int().positive() })
				.safeParse(JSON.parse(line.slice(READY.length)));
			if (!ready.success) return;
			clearTimeout(timer);
			done(`http://127.0.0.1:${ready.data.control}`);
		};
		const lines = lineSplitter(onLine);
		proc.stdout.setEncoding('utf8').on('data', (chunk: string) => {
			lines.push(chunk);
		});
		proc.stderr.setEncoding('utf8').on('data', (chunk: string) => {
			lines.push(chunk);
		});
		proc.once('error', (error) => {
			clearTimeout(timer);
			failed(new Error(`Could not start the emulator: ${error.message}`));
		});
		proc.once('exit', (code) => {
			clearTimeout(timer);
			failed(
				new Error(`The emulator stopped while starting (exit code ${code}):\n${output.join('\n')}`)
			);
		});
	}).catch((error: unknown) => {
		lastError = error instanceof Error ? error.message : String(error);
		throw error;
	});
	const current: Running = {
		proc,
		url,
		...input,
		startedAt: new Date().toISOString(),
		stopping: false
	};
	running = current;
	proc.once('exit', (code) => {
		if (running !== current) return;
		running = null;
		if (!current.stopping) lastError = `The emulator stopped unexpectedly (exit code ${code}).`;
	});
}

export function stopEmulator(): boolean {
	if (!running) return false;
	running.stopping = true;
	running.proc.kill('SIGTERM');
	return true;
}

function baseUrl(): string {
	const url = externalUrl() ?? running?.url;
	if (!url) throw new Error('The emulator is not running.');
	return url;
}

async function call<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
	const response = await fetch(baseUrl() + path, init);
	const body: unknown = await response.json();
	if (!response.ok) {
		const message = z.object({ error: z.string() }).safeParse(body);
		throw new Error(
			message.success ? message.data.error : `The emulator answered ${response.status}.`
		);
	}
	return schema.parse(body);
}

/** Sends an action to the emulator (or, under /ewm, to its fake EWM). Throws with the emulator's message. */
export async function mfsAction(path: string, body: unknown): Promise<void> {
	await call(path, z.unknown(), {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
}

/** The number of the newest entry, for asking only for newer ones. */
const since = (list: { n: number }[]) => list.at(-1)?.n ?? 0;

const sleep = (ms: number) =>
	new Promise<void>((done) => {
		setTimeout(done, ms);
	});

/**
 * Live view for the MFS page: emulator state, the fake EWM's view in demo mode, and the newest telegrams and
 * events. Polls the emulator twice a second and yields only when something changed.
 */
export async function* watchMfs(): AsyncGenerator<MfsSnapshot> {
	let instance: string | undefined;
	let setup: MfsSetup | undefined;
	let telegrams: MfsTelegram[] = [];
	let events: MfsEvent[] = [];
	let last = '';
	for (;;) {
		const status = mfsStatus();
		const key = status.running ? (status.startedAt ?? 'external') : undefined;
		if (key !== instance) {
			instance = key;
			setup = undefined;
			telegrams = [];
			events = [];
		}
		let snapshot: MfsSnapshot = { status, telegrams, events };
		if (status.running) {
			try {
				// Sequential on purpose: one emulator, a handful of small requests per poll.
				// oxlint-disable-next-line no-await-in-loop
				setup ??= await call('/setup', MfsSetupSchema);
				// oxlint-disable-next-line no-await-in-loop
				const [state, newTelegrams, newEvents, ewm] = await Promise.all([
					call('/state', MfsStateSchema),
					call(`/log?since=${since(telegrams)}`, z.array(MfsTelegramSchema)),
					call(`/events?since=${since(events)}`, z.array(MfsEventSchema)),
					status.mode === 'demo' ? call('/ewm/state', EwmStateSchema) : undefined
				]);
				telegrams = [...telegrams, ...newTelegrams].slice(-KEEP);
				events = [...events, ...newEvents].slice(-KEEP);
				snapshot = { status, setup, state, ewm, telegrams, events };
			} catch (error) {
				snapshot = {
					status: { ...status, error: error instanceof Error ? error.message : String(error) },
					setup,
					telegrams,
					events
				};
			}
		}
		const text = JSON.stringify(snapshot);
		if (text !== last) {
			last = text;
			yield snapshot;
		}
		// oxlint-disable-next-line no-await-in-loop
		await sleep(500);
	}
}
