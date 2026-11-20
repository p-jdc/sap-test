import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { childEnv, playwrightCommand } from './node-cli.js';
import { LIVE_REPORTER, RUNS_DIR, TESTS_DIR, TESTS_ROOT, within } from './paths.js';
import { readRunState, rememberFinished } from './runs-store.js';
import type { Attachment, RunState, RunStatus, RunTest, TestStatus } from '#lib/shared/types.js';

const PREFIX = '@@pwlive@@';
const LOG_TAIL = 400;
// Strips terminal colour codes from Playwright output; matching ESC is the point.
// oxlint-disable-next-line no-control-regex
const ANSI = /\u001B\[[0-9;?]*[A-Za-z]/g;

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

function specRel(file: string | undefined): string | undefined {
	if (!file) return undefined;
	const rel = relative(TESTS_DIR, file);
	return rel.startsWith('..') ? undefined : rel;
}

type Loc = { file: string; line: number; column: number };
type ReporterError = { message: string; stack?: string; location?: Loc };

/** Line protocol of reporter/live-reporter.ts (one JSON object per `@@pwlive@@` line). */
type ReporterEvent =
	| {
			type: 'begin';
			rootDir: string;
			tests: { id: string; title: string; titlePath: string[]; location?: Loc }[];
	  }
	| { type: 'testBegin'; testId: string; retry: number; startTime: string }
	| {
			type: 'stepBegin';
			testId: string;
			stepId: string;
			parentId?: string;
			title: string;
			category: string;
			location?: Loc;
			startTime: string;
	  }
	| { type: 'stepEnd'; testId: string; stepId: string; duration: number; error?: ReporterError }
	| {
			type: 'testEnd';
			testId: string;
			status: TestStatus;
			expectedStatus: TestStatus;
			duration: number;
			retry: number;
			error?: ReporterError;
			attachments: Attachment[];
	  }
	| { type: 'end'; status: string; duration: number };

function apply(live: Live, ev: ReporterEvent) {
	const { state } = live;
	const test = (id: string) => state.tests.find((t) => t.testId === id);
	switch (ev.type) {
		case 'begin':
			state.tests = ev.tests.map((t): RunTest => {
				const file = specRel(t.location?.file) ?? '';
				return {
					testId: t.id,
					key: `${file}::${t.titlePath.join(' › ')}`,
					file,
					title: t.title,
					line: t.location?.line ?? 0,
					steps: [],
					attachments: []
				};
			});
			state.stats.total = state.tests.length;
			break;
		case 'testBegin': {
			const t = test(ev.testId);
			if (t)
				Object.assign(t, {
					running: true,
					retry: ev.retry,
					steps: [],
					status: undefined,
					error: undefined
				});
			break;
		}
		case 'stepBegin': {
			const t = test(ev.testId);
			t?.steps.push({
				stepId: ev.stepId,
				parentId: ev.parentId,
				title: ev.title,
				category: ev.category,
				file: specRel(ev.location?.file),
				line: ev.location?.line,
				startTime: ev.startTime
			});
			break;
		}
		case 'stepEnd': {
			const s = test(ev.testId)?.steps.find((x) => x.stepId === ev.stepId);
			if (s)
				Object.assign(s, { duration: ev.duration, error: ev.error?.message.replaceAll(ANSI, '') });
			break;
		}
		case 'testEnd': {
			const t = test(ev.testId);
			if (!t) break;
			t.running = false;
			t.status = ev.status;
			t.duration = ev.duration;
			t.error = ev.error
				? {
						message: ev.error.message.replaceAll(ANSI, ''),
						line: ev.error.location?.line,
						file: specRel(ev.error.location?.file)
					}
				: undefined;
			t.attachments = ev.attachments.flatMap((a) => {
				const rel = relative(live.dir, a.path);
				return rel.startsWith('..') ? [] : [{ ...a, path: rel }];
			});
			break;
		}
		case 'end':
			state.status =
				ev.status === 'passed' ? 'passed' : ev.status === 'interrupted' ? 'interrupted' : 'failed';
			break;
	}
}

function recount(state: RunState) {
	const s = { total: state.tests.length, passed: 0, failed: 0, skipped: 0 };
	for (const t of state.tests) {
		if (t.status === 'passed') s.passed++;
		else if (t.status === 'skipped') s.skipped++;
		else if (t.status) s.failed++;
	}
	state.stats = s;
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
export function startRun(
	input: StartRunInput
): { ok: true; id: string } | { ok: false; error: string } {
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
	persist(live);

	const logFile = join(dir, 'output.log');
	const onData = () => {
		let buffer = '';
		return (chunk: Buffer) => {
			buffer += chunk.toString();
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const raw of lines) {
				if (raw.startsWith(PREFIX)) {
					try {
						// The line comes from reporter/live-reporter.ts in this repo, so its shape is trusted.
						// oxlint-disable-next-line typescript/no-unsafe-type-assertion
						apply(live, JSON.parse(raw.slice(PREFIX.length)) as ReporterEvent);
						recount(live.state);
					} catch {
						// a malformed line must not kill the run
					}
				} else {
					const line = raw.replaceAll(ANSI, '').replaceAll('\r', '');
					if (!line.trim()) continue;
					appendFileSync(logFile, line + '\n');
					live.state.log.push(line);
					if (live.state.log.length > LOG_TAIL)
						live.state.log.splice(0, live.state.log.length - LOG_TAIL);
				}
			}
			notify(live);
		};
	};
	proc.stdout.on('data', onData());
	proc.stderr.on('data', onData());
	proc.on('error', (e) => {
		live.state.log.push(`Failed to start: ${e.message}`);
		finish(live, null, 'error');
	});
	proc.on('close', (code) => {
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
