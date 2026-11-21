import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNS_DIR, within } from './paths.js';
import { decide, retentionFromEnv, type Retention } from './retention.js';
import {
	HISTORY_SHOWN,
	RUNS_PER_PAGE,
	type RunMeta,
	type RunState,
	type RunTest,
	type StabilityRow,
	type TestStatus
} from '#lib/shared/types.js';

// A finished run never changes, so what was read from its files is kept. The history can grow to
// thousands of runs: the small parts (meta, test results) are kept for all of them, the full state
// with every step only for the runs opened last.
const metas = new Map<string, RunMeta>();
const results = new Map<string, TestResult[]>();
const finished = new Map<string, RunState>();
const FULL_STATES = 20;

/** What the stability table and the retention rules need from one test of one run. */
type TestResult = {
	key: string;
	file: string;
	title: string;
	status?: TestStatus;
	/** A sign-in, which is no flow. */
	setup?: boolean;
	/** Where the test failed (`file:line`). */
	failedAt?: string;
};

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

/** Marks a run whose report, screenshots, videos and traces were deleted (applyRetention). */
const ARTIFACTS_REMOVED = 'artifacts-removed';
/** Marks a run that has lost the steps and error messages of all its tests, and its log. */
const DETAILS_REMOVED = 'details-removed';
/** Stands in for an error message that was removed; where the test failed is kept. */
const ERROR_REMOVED = 'The error message was removed to save space.';

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

/**
 * One page of the run list, newest first: the newest runs, or the ones after the run `before`.
 * `total` is the number of all runs.
 */
export function runsPage(
	before?: string,
	size = RUNS_PER_PAGE
): { runs: RunMeta[]; total: number } {
	const all = listRuns();
	const start = before === undefined ? 0 : all.findIndex((run) => run.id === before) + 1;
	// An unknown `before` (the run was deleted meanwhile) has no page after it.
	const runs = before !== undefined && start === 0 ? [] : all.slice(start, start + size);
	return { runs, total: all.length };
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

/** A run's test results without steps and log: small enough to read for every run at a start. */
const RESULTS_FILE = 'results.json';

function summarize(tests: RunTest[]): TestResult[] {
	return tests.map(({ key, file, title, status, setup, error }): TestResult => ({
		key,
		file,
		title,
		status,
		setup,
		failedAt: error && `${error.file ?? ''}:${error.line ?? ''}`
	}));
}

/** Stores the results of a run that has finished next to its state. Called by runner.ts. */
export function writeResults(dir: string, tests: RunTest[]) {
	writeFileSync(join(dir, RESULTS_FILE), JSON.stringify(summarize(tests)));
}

/**
 * The results of a finished run's tests, read once per run. A run from before the results file
 * existed is read from its full state once, and gets the file then.
 */
function testResults(id: string): TestResult[] {
	const hit = results.get(id);
	if (hit) return hit;
	const dir = join(RUNS_DIR, id);
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- own file, see readRunFile
	let found = readRunFile(join(dir, RESULTS_FILE)) as TestResult[] | null;
	if (!found) {
		const state = readState(join(dir, 'state.json'));
		found = summarize(state?.tests ?? []);
		if (state) writeFileSync(join(dir, RESULTS_FILE), JSON.stringify(found));
	}
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
			// A sign-in is no flow.
			if (t.setup) continue;
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
		// The page shows the latest results only; a long history would be megabytes.
		row.history = row.history.slice(-HISTORY_SHOWN);
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

/** Removes the steps and error messages of the tests not in `keep`. True when the file changed. */
function removeDetails(dir: string, keep: Set<string>): boolean {
	const file = join(dir, 'state.json');
	const state = readState(file);
	if (!state) return false;
	let changed = false;
	for (const t of state.tests) {
		if (keep.has(t.key) || t.detailsRemoved) continue;
		t.steps = [];
		if (t.error) t.error = { ...t.error, message: ERROR_REMOVED };
		t.detailsRemoved = true;
		changed = true;
	}
	if (changed) writeFileSync(file, JSON.stringify(state));
	return changed;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Applies the retention rules (retention.ts) to the finished runs: deletes reports, screenshots,
 * videos and traces, steps, error messages and logs that the rules no longer keep. What happened in
 * each run stays. Returns the ids of the runs it changed. Does nothing when the rules are off.
 */
export function applyRetention(
	now = Date.now(),
	policy: Retention | null = retentionFromEnv()
): string[] {
	if (!policy) return [];
	const runs = listRuns()
		.filter((run) => run.status !== 'running')
		.toReversed();
	// A run older than every limit keeps nothing and cannot matter to a younger one, so its tests
	// are not read.
	const oldest = now - Math.max(policy.reportDays, policy.stepsDays, policy.failureDays) * DAY;
	const decisions = decide(
		runs.map((run) => ({
			id: run.id,
			startedAt: run.startedAt,
			tests: Date.parse(run.startedAt) < oldest ? [] : testResults(run.id)
		})),
		now,
		policy
	);
	const changed: string[] = [];
	for (const run of runs) {
		const dir = within(RUNS_DIR, run.id);
		const decision = decisions.get(run.id);
		if (!dir || dir === RUNS_DIR || !decision) continue;
		let touched = false;
		if (!decision.artifacts && !existsSync(join(dir, ARTIFACTS_REMOVED))) {
			rmSync(join(dir, 'report'), { recursive: true, force: true });
			rmSync(join(dir, 'results'), { recursive: true, force: true });
			writeFileSync(join(dir, ARTIFACTS_REMOVED), new Date(now).toISOString());
			touched = true;
		}
		if (decision.details !== 'all' && !existsSync(join(dir, DETAILS_REMOVED))) {
			if (removeDetails(dir, decision.details)) touched = true;
			if (!decision.log) rmSync(join(dir, 'output.log'), { force: true });
			// Nothing left to remove later: the run is not read again.
			if (decision.details.size === 0 && !decision.log) {
				writeFileSync(join(dir, DETAILS_REMOVED), new Date(now).toISOString());
				touched = true;
			}
		}
		if (touched) {
			finished.delete(run.id);
			changed.push(run.id);
		}
	}
	return changed;
}
