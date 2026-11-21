// The MFS PLC emulator (sap-tests/mfs) as seen from the app: started as its own process, the way it will run as
// its own service on the cluster later, and reached only through its HTTP control API. The browser never talks to
// the emulator or its PLC ports; the page goes through the remote functions in mfs.remote.ts.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
	EwmStateSchema,
	MfsEventSchema,
	MfsScenarioInfoSchema,
	MfsScenarioRunSchema,
	MfsSetupSchema,
	MfsStateSchema,
	MfsTelegramSchema,
	type MfsEvent,
	type MfsMode,
	type MfsScenarioInfo,
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
const SETUP_HINT = 'Run "bun run setup" in the repo root, then start the Mock PLC again.';

type Running = {
	proc: ChildProcess;
	url: string;
	/** Made up for this start and handed to the emulator: only this app can use its control API. */
	token: string;
	setup: string;
	mode: MfsMode;
	speed: number;
	startedAt: string;
	stopping: boolean;
};

let running: Running | null = null;
let starting = false;
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

/**
 * The scenario files in sap-tests/mfs/scenarios, for choosing one before the Mock PLC runs. Only the fields shown
 * here are read; the Mock PLC checks the whole file when it runs one (and sap-tests' tests check every file).
 */
export function listScenarios(): MfsScenarioInfo[] {
	const dir = resolve(MFS_DIR, 'scenarios');
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((file) => file.endsWith('.json') && SETUP_NAME.test(file.slice(0, -'.json'.length)))
		.flatMap((file) => {
			const parsed = MfsScenarioInfoSchema.omit({ name: true }).safeParse(
				JSON.parse(readFileSync(resolve(dir, file), 'utf8'))
			);
			return parsed.success ? [{ name: file.slice(0, -'.json'.length), ...parsed.data }] : [];
		})
		.toSorted((a, b) => a.title.localeCompare(b.title));
}

export function mfsStatus(): MfsStatus {
	if (externalUrl()) return { running: true, external: true };
	if (!running) return { running: false, external: false, error: lastError };
	const { setup, mode, speed, startedAt } = running;
	return { running: true, external: false, setup, mode, speed, startedAt };
}

/**
 * The packages the Mock PLC's source files import: bare specifiers, without `node:` built-ins and relative paths.
 * Read from the files themselves, so the check below follows the code when its dependencies change.
 */
export function importedPackages(sourceDir: string): string[] {
	const names = new Set<string>();
	for (const file of readdirSync(sourceDir).filter((name) => /\.m?ts$/.test(name))) {
		const source = readFileSync(resolve(sourceDir, file), 'utf8');
		for (const [, specifier = ''] of source.matchAll(/\b(?:from|import)\s+'([^'.][^']*)'/g)) {
			if (specifier.startsWith('node:')) continue;
			const parts = specifier.split('/');
			names.add(specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier));
		}
	}
	return [...names].toSorted();
}

/** Those of `packages` that are not installed in `root`/node_modules. */
export function missingPackages(root: string, packages: string[]): string[] {
	return packages.filter(
		(name) => !existsSync(resolve(root, 'node_modules', name, 'package.json'))
	);
}

/** Bun runs the emulator's TypeScript directly; the app itself runs on Bun, so it is always there. */
function bunBinary(): string {
	return process.versions.bun ? process.execPath : 'bun';
}

export type StartInput = { setup: string; mode: MfsMode; speed: number; scenario?: string };

/**
 * Starts the emulator and resolves when its control API answers. In `demo` mode the fake EWM runs inside it and
 * the PLC ports are free ones; in `ewm` mode the PLCs listen on MFS_BASE_PORT (default 47101) for a real EWM.
 */
export async function startEmulator(input: StartInput): Promise<void> {
	// Starting takes a moment, and `running` is only set once the emulator answers. Without this,
	// two requests in that moment would each start one, and the first could never be stopped.
	if (starting) throw new Error('The emulator is already starting.');
	starting = true;
	try {
		await launch(input);
	} finally {
		starting = false;
	}
}

async function launch(input: StartInput): Promise<void> {
	if (externalUrl()) throw new Error('The emulator is managed elsewhere (MFS_EMULATOR_URL).');
	if (running) throw new Error('The emulator is already running.');
	if (!listSetups().includes(input.setup)) throw new Error(`There is no setup "${input.setup}".`);
	// Checked before starting: a missing package otherwise surfaces as Bun's resolver error.
	const missing = missingPackages(TESTS_ROOT, importedPackages(MFS_DIR));
	if (missing.length > 0)
		throw new Error(
			`The Mock PLC needs ${missing.join(', ')} in ${TESTS_ROOT}, which ${missing.length === 1 ? 'is' : 'are'} not installed. ${SETUP_HINT}`
		);
	lastError = undefined;
	const demo = input.mode === 'demo';
	const token = randomBytes(24).toString('hex');
	const proc = spawn(bunBinary(), [resolve(MFS_DIR, 'server.mts')], {
		cwd: TESTS_ROOT,
		env: childEnv({
			MFS_SETUP: input.setup,
			MFS_SPEED: String(input.speed),
			MFS_CONTROL_PORT: '0',
			MFS_CONTROL_HOST: '127.0.0.1',
			MFS_CONTROL_TOKEN: token,
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
			const text = output.join('\n');
			const hint = /Cannot find (package|module)/.test(text) ? `\n${SETUP_HINT}` : '';
			failed(new Error(`The emulator stopped while starting (exit code ${code}):\n${text}${hint}`));
		});
	}).catch((error: unknown) => {
		lastError = error instanceof Error ? error.message : String(error);
		throw error;
	});
	const current: Running = {
		proc,
		url,
		token,
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
	if (input.scenario) {
		try {
			await mfsAction('/scenario/start', { name: input.scenario });
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`The Mock PLC is running, but the scenario did not start: ${reason}`, {
				cause: error
			});
		}
	}
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
	// The token of the emulator this app started, or the one set for an emulator run elsewhere.
	const token = externalUrl() ? process.env.MFS_EMULATOR_TOKEN : running?.token;
	const headers = new Headers(init?.headers);
	if (token) headers.set('authorization', `Bearer ${token}`);
	const response = await fetch(baseUrl() + path, { ...init, headers });
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
	let scenarios: MfsScenarioInfo[] | undefined;
	let telegrams: MfsTelegram[] = [];
	let events: MfsEvent[] = [];
	let last = '';
	for (;;) {
		const status = mfsStatus();
		const key = status.running ? (status.startedAt ?? 'external') : undefined;
		if (key !== instance) {
			instance = key;
			setup = undefined;
			scenarios = undefined;
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
				scenarios ??= await call('/scenarios', z.array(MfsScenarioInfoSchema));
				// oxlint-disable-next-line no-await-in-loop
				const [state, run, newTelegrams, newEvents, ewm] = await Promise.all([
					call('/state', MfsStateSchema),
					call('/scenario', MfsScenarioRunSchema.nullable()),
					call(`/log?since=${since(telegrams)}`, z.array(MfsTelegramSchema)),
					call(`/events?since=${since(events)}`, z.array(MfsEventSchema)),
					status.mode === 'demo' ? call('/ewm/state', EwmStateSchema) : undefined
				]);
				telegrams = [...telegrams, ...newTelegrams].slice(-KEEP);
				events = [...events, ...newEvents].slice(-KEEP);
				snapshot = { status, setup, state, ewm, scenarios, run, telegrams, events };
			} catch (error) {
				snapshot = {
					status: { ...status, error: error instanceof Error ? error.message : String(error) },
					setup,
					scenarios,
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
