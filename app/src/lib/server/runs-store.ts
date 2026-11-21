import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNS_DIR, within } from './paths.js';
import type { RunMeta, RunState, StabilityRow, TestStatus } from '#lib/shared/types.js';

// A finished run never changes, so what was read from its files is kept. The history can grow to
// thousands of runs: the small parts (meta, test results) are kept for all of them, the full state
// with every step only for the runs opened last.
const metas = new Map<string, RunMeta>();
const results = new Map<string, TestResult[]>();
const finished = new Map<string, RunState>();
const FULL_STATES = 20;

/** What the stability table needs from one test of one run. */
type TestResult = { key: string; file: string; title: string; status?: TestStatus };

function forget(id: string) {
	metas.delete(id);
	results.delete(id);
	finished.delete(id);
}

function remember(state: RunState) {
	finished.delete(state.id);
	finished.set(state.id, state);
	// A Map keeps insertion order, so its first key is the state used longest ago.
	const [oldest] = finished.keys();
	if (finished.size > FULL_STATES && oldest !== undefined) finished.delete(oldest);
}

/** Marks a run whose report, screenshots, videos and traces were deleted (trimArtifacts). */
const ARTIFACTS_REMOVED = 'artifacts-removed';

/** The run this process is executing, if any. Set by runner.ts. */
let liveId: string | null = null;

export function markLive(id: string) {
	liveId = id;
}

export function rememberFinished(id: string) {
	if (liveId === id) liveId = null;
	forget(id);
}

/**
 * A run stored as "running" that this process is not executing was cut off (the app stopped or
 * crashed mid-run) and will never finish, so it is shown as interrupted.
 */
function settle<T extends RunMeta>(run: T): T {
	return run.status === 'running' && run.id !== liveId ? { ...run, status: 'interrupted' } : run;
}

/** meta.json / state.json are written by runner.ts in this app, so their shape is trusted. */
function readRunFile(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return null;
	}
}

function readMeta(path: string): RunMeta | null {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- own file, see readRunFile
	return readRunFile(path) as RunMeta | null;
}

function readState(path: string): RunState | null {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- own file, see readRunFile
	return readRunFile(path) as RunState | null;
}

export function listRuns(): RunMeta[] {
	if (!existsSync(RUNS_DIR)) return [];
	return readdirSync(RUNS_DIR)
		.map((id) => {
			const hit = metas.get(id);
			if (hit) return hit;
			const stored = readMeta(join(RUNS_DIR, id, 'meta.json'));
			const meta = stored && settle(stored);
			if (meta && meta.status !== 'running') metas.set(id, meta);
			return meta;
		})
		.filter((m): m is RunMeta => m !== null)
		.toSorted((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function readRunState(id: string): RunState | null {
	const dir = within(RUNS_DIR, id);
	if (!dir) return null;
	const hit = finished.get(id);
	if (hit) {
		remember(hit);
		return hit;
	}
	const state = readState(join(dir, 'state.json'));
	if (!state) return null;
	if (existsSync(join(dir, ARTIFACTS_REMOVED))) {
		// The files the attachments point at are gone.
		state.artifactsRemoved = true;
		for (const t of state.tests) t.attachments = [];
	}
	const log = existsSync(join(dir, 'output.log'))
		? readFileSync(join(dir, 'output.log'), 'utf8').split('\n').slice(-400)
		: [];
	const full = settle({ ...state, log, hasReport: existsSync(join(dir, 'report/index.html')) });
	if (full.status !== 'running') remember(full);
	return full;
}

/** The results of a finished run's tests, read once per run and without its steps and log. */
function testResults(id: string): TestResult[] {
	const hit = results.get(id);
	if (hit) return hit;
	const state = readState(join(RUNS_DIR, id, 'state.json'));
	// A sign-in is no flow.
	const found = (state?.tests ?? [])
		.filter((t) => !t.setup)
		.map(({ key, file, title, status }) => ({ key, file, title, status }));
	results.set(id, found);
	return found;
}

/** Pilot exit criterion (guide §4.8): ten consecutive passes per flow. */
export const PILOT_STREAK = 10;

export function stability(): StabilityRow[] {
	const rows = new Map<string, StabilityRow>();
	for (const meta of listRuns().toReversed()) {
		if (meta.status === 'running') continue;
		for (const t of testResults(meta.id)) {
			// A test that was skipped or cut off by stopping the run says nothing about the flow.
			if (!t.status || t.status === 'skipped' || t.status === 'interrupted') continue;
			const row = rows.get(t.key) ?? {
				key: t.key,
				file: t.file,
				title: t.title,
				history: [],
				streak: 0
			};
			row.history.push({ runId: meta.id, status: t.status });
			rows.set(t.key, row);
		}
	}
	for (const row of rows.values()) {
		row.lastStatus = row.history.at(-1)?.status;
		const lastNonPass = row.history.findLastIndex((h) => h.status !== 'passed');
		row.streak = row.history.length - 1 - lastNonPass;
	}
	return [...rows.values()].toSorted((a, b) => a.key.localeCompare(b.key));
}

/**
 * Deletes the oldest finished runs beyond TEST_APP_KEEP_RUNS. Off unless that is set to a positive
 * number: run history is the evidence for the pilot criterion, so nothing is deleted by default.
 */
export function pruneRuns(keep = Number(process.env.TEST_APP_KEEP_RUNS)): string[] {
	if (!Number.isInteger(keep) || keep < 1) return [];
	const removed: string[] = [];
	for (const run of listRuns().slice(keep)) {
		const dir = within(RUNS_DIR, run.id);
		if (!dir || dir === RUNS_DIR || run.id === liveId) continue;
		rmSync(dir, { recursive: true, force: true });
		forget(run.id);
		removed.push(run.id);
	}
	return removed;
}

/** Runs whose artifacts are kept when TEST_APP_KEEP_ARTIFACTS is not set. */
const KEEP_ARTIFACTS = 50;

/** TEST_APP_KEEP_ARTIFACTS: a positive number, or `all` to never delete artifacts. */
function artifactLimit(value = process.env.TEST_APP_KEEP_ARTIFACTS): number {
	if (value === undefined || value === '') return KEEP_ARTIFACTS;
	const keep = Number(value);
	return Number.isInteger(keep) && keep > 0 ? keep : Infinity;
}

/**
 * Deletes the report, screenshots, videos and traces of all but the newest runs. They are most of
 * a run's size, and what the history is evidence for (which test passed when) stays: the results,
 * the steps and the log are kept.
 */
export function trimArtifacts(keep = artifactLimit()): string[] {
	const trimmed: string[] = [];
	for (const run of listRuns().slice(keep)) {
		const dir = within(RUNS_DIR, run.id);
		if (!dir || dir === RUNS_DIR || run.status === 'running') continue;
		if (existsSync(join(dir, ARTIFACTS_REMOVED))) continue;
		rmSync(join(dir, 'report'), { recursive: true, force: true });
		rmSync(join(dir, 'results'), { recursive: true, force: true });
		writeFileSync(join(dir, ARTIFACTS_REMOVED), new Date().toISOString());
		finished.delete(run.id);
		trimmed.push(run.id);
	}
	return trimmed;
}
