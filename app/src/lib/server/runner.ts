import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runSettings } from './env-file.js';
import { lineSplitter } from './lines.js';
import { childEnv, playwrightCommand } from './node-cli.js';
import { LIVE_REPORTER, RUNS_DIR, TESTS_DIR, TESTS_ROOT, within } from './paths.js';
import { redactor } from './redact.js';
import { ANSI, applyEvent, PREFIX, recount, type ReporterEvent } from './run-events.js';
import { markLive, pruneRuns, readRunState, rememberFinished } from './runs-store.js';
import type { RunState, RunStatus } from '#lib/shared/types.js';

const LOG_TAIL = 400;

type Live = { state: RunState; proc: ChildProcess; updates: EventTarget; dir: string };
let active: Live | null = null;

export function activeRunId(): string | null {
	return active?.state.status === 'running' ? active.state.id : null;
}

const pad = (n: number) => String(n).padStart(2, '0');

function newId() {
	const d = new Date();
	return (
		`${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
		`${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-` +
		Math.random().toString(36).slice(2, 6)
	);
}

function persist(live: Live) {
	const { log, ...rest } = live.state;
	void log;
	writeFileSync(join(live.dir, 'state.json'), JSON.stringify(rest));
	const { tests, hasReport, ...meta } = rest;
	void tests;
	void hasReport;
	writeFileSync(join(live.dir, 'meta.json'), JSON.stringify(meta));
}

export type StartRunInput = { files?: string[]; grep?: string };

/** Starts `playwright test` in sap-tests with the live, list and html reporters. One run at a time. */
export async function startRun(
	input: StartRunInput
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
	// Settings saved in the app live in the system credential store; the tests get them as
	// environment variables. Read before the check below: nothing after it yields, so two requests
	// cannot both start a run.
	const settings = await runSettings();
	// Playwright writes typed values into step titles (`Fill "…"`) and errors; a password must not
	// reach the run state, the log or the UI that way.
	const redact = redactor(settings.secrets);
	if (activeRunId()) return { ok: false, error: `Run ${activeRunId()} is still running.` };
	if (!existsSync(resolve(TESTS_ROOT, 'node_modules/@playwright/test'))) {
		return {
			ok: false,
			error: `Playwright is not installed in ${TESTS_ROOT}. Run "bun run setup" in the repo root.`
		};
	}
	const files = (input.files ?? []).filter((f) => {
		const [path = ''] = f.split(':');
		return within(TESTS_DIR, path) !== null;
	});
	const id = newId();
	const dir = join(RUNS_DIR, id);
	mkdirSync(dir, { recursive: true });

	const args = [
		'test',
		...files.map((f) => 'tests/' + f),
		...(input.grep ? ['--grep', input.grep] : []),
		`--reporter=${LIVE_REPORTER},list,html`,
		'--output',
		join(dir, 'results')
	];
	const command = playwrightCommand(args);
	const proc = spawn(command.cmd, command.args, {
		cwd: TESTS_ROOT,
		env: childEnv({
			...settings.env,
			PLAYWRIGHT_HTML_OUTPUT_DIR: join(dir, 'report'),
			PLAYWRIGHT_HTML_OPEN: 'never',
			FORCE_COLOR: '0'
		}),
		stdio: ['ignore', 'pipe', 'pipe']
	});

	const live: Live = {
		dir,
		proc,
		updates: new EventTarget(),
		state: {
			id,
			startedAt: new Date().toISOString(),
			status: 'running',
			files,
			grep: input.grep,
			stats: { total: 0, passed: 0, failed: 0, skipped: 0 },
			tests: [],
			log: [`$ playwright ${args.join(' ')}`],
			hasReport: false
		}
	};
	active = live;
	markLive(id);
	persist(live);

	const logFile = join(dir, 'output.log');
	const onLine = (raw: string) => {
		if (raw.startsWith(PREFIX)) {
			try {
				// The line comes from reporter/live-reporter.ts in this repo, so its shape is trusted.
				// oxlint-disable-next-line typescript/no-unsafe-type-assertion
				const event = JSON.parse(raw.slice(PREFIX.length)) as ReporterEvent;
				applyEvent(live.state, dir, redact(event));
			} catch {
				// a malformed line must not kill the run
			}
			return;
		}
		const line = redact(raw.replaceAll(ANSI, '').replaceAll('\r', ''));
		if (!line.trim()) return;
		appendFileSync(logFile, line + '\n');
		live.state.log.push(line);
		if (live.state.log.length > LOG_TAIL)
			live.state.log.splice(0, live.state.log.length - LOG_TAIL);
	};
	// setEncoding decodes across chunk boundaries, so a multi-byte character (ä, ›) split between
	// two chunks stays intact.
	const outputs = [proc.stdout, proc.stderr].map((stream) => {
		const lines = lineSplitter(onLine);
		stream.setEncoding('utf8');
		stream.on('data', (chunk: string) => {
			lines.push(chunk);
			notify(live);
		});
		return lines;
	});
	// A run must not outlive the app: without this, Playwright and its browser keep going after a
	// shutdown and nothing records the result.
	const killWithApp = () => {
		proc.kill('SIGINT');
	};
	process.once('exit', killWithApp);
	proc.on('error', (e) => {
		live.state.log.push(`Failed to start: ${e.message}`);
		finish(live, null, 'error');
	});
	proc.on('close', (code) => {
		process.off('exit', killWithApp);
		// Output that ended without a newline is still a line.
		for (const lines of outputs) lines.flush();
		finish(live, code);
	});
	return { ok: true, id };
}

function finish(live: Live, code: number | null, forced?: RunStatus) {
	if (live.state.finishedAt) return;
	const { state } = live;
	state.finishedAt = new Date().toISOString();
	state.exitCode = code;
	if (forced) state.status = forced;
	else if (state.tests.length === 0) {
		// Exit 0 with no tests means the filter matched nothing or Playwright never started properly.
		state.status = 'error';
		state.log.push('No tests were run.');
	} else if (state.status === 'running') state.status = code === 0 ? 'passed' : 'failed';
	for (const t of state.tests) {
		if (t.running) {
			t.running = false;
			t.status = 'interrupted';
		}
	}
	recount(state);
	state.hasReport = existsSync(join(live.dir, 'report/index.html'));
	persist(live);
	rememberFinished(state.id);
	pruneRuns();
	notify(live);
}

export function stopRun(id: string): boolean {
	if (!active || active.state.id !== id || active.state.status !== 'running') return false;
	active.proc.kill('SIGINT');
	return true;
}

export function getLiveState(id: string): RunState | null {
	return active && active.state.id === id ? active.state : null;
}

function notify(live: Live) {
	live.updates.dispatchEvent(new Event('update'));
}

const sleep = (ms: number) =>
	new Promise<void>((done) => {
		setTimeout(done, ms);
	});

/** Snapshot stream for query.live: yields on change (throttled), ends when the run finishes. */
export async function* watchRun(id: string): AsyncGenerator<RunState> {
	const live = active && active.state.id === id ? active : null;
	if (!live || live.state.status !== 'running') {
		const done = readRunState(id);
		if (done) yield done;
		return;
	}
	let dirty = true;
	let wake: (() => void) | undefined;
	const onUpdate = () => {
		dirty = true;
		wake?.();
	};
	const nextUpdate = () =>
		new Promise<void>((done) => {
			wake = done;
		});
	// A call, so TypeScript does not keep the narrowing from above across the yields.
	const running = () => live.state.status === 'running';
	live.updates.addEventListener('update', onUpdate);
	try {
		for (;;) {
			// Sequential on purpose: one snapshot per change, throttled.
			// oxlint-disable-next-line no-await-in-loop
			if (!dirty) await nextUpdate();
			dirty = false;
			yield structuredClone(live.state);
			if (!running()) return;
			// oxlint-disable-next-line no-await-in-loop
			await sleep(200);
		}
	} finally {
		live.updates.removeEventListener('update', onUpdate);
	}
}
