import { and, asc, count, desc, eq, gte, isNotNull, lt, notInArray, or, sql } from 'drizzle-orm';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { database, type AppDatabase } from './db/database.js';
import { run, runTest } from './db/schema.js';
import { RUNS_DIR, within } from './paths.js';
import { decide, retentionFromEnv, type Retention } from './retention.js';
import {
	HISTORY_SHOWN,
	RUNS_PER_PAGE,
	type RunMeta,
	type RunState,
	type RunTest,
	type StabilityRow
} from '#lib/shared/types.js';

// The run history is kept in the app's database (db/runs-schema.ts): one row per run and one per
// test of a finished run. The log, the Playwright report, screenshots, videos and traces stay files
// in the run's directory, <data dir>/runs/<id>.

/** Stands in for an error message that was removed; where the test failed is kept. */
const ERROR_REMOVED = 'The error message was removed to save space.';

/** The run this process is executing, if any. Set by runner.ts. */
let liveId: string | null = null;

export function markLive(id: string) {
	liveId = id;
}

export function rememberFinished(id: string) {
	if (liveId === id) liveId = null;
}

/**
 * A run stored as "running" that this process is not executing was cut off (the app stopped or
 * crashed mid-run) and will never finish, so it is shown as interrupted.
 */
function settle<T extends RunMeta>(meta: T): T {
	return meta.status === 'running' && meta.id !== liveId
		? { ...meta, status: 'interrupted' }
		: meta;
}

type RunRow = typeof run.$inferSelect;

function toMeta(row: RunRow): RunMeta {
	return settle({
		id: row.id,
		startedAt: row.startedAt.toISOString(),
		...(row.finishedAt ? { finishedAt: row.finishedAt.toISOString(), exitCode: row.exitCode } : {}),
		status: row.status,
		files: row.files,
		...(row.grep === null ? {} : { grep: row.grep }),
		stats: { total: row.total, passed: row.passed, failed: row.failed, skipped: row.skipped }
	});
}

/** Where a test failed (`file:line`), to tell a repeated failure from a new one. */
const failedAt = (t: RunTest) => t.error && `${t.error.file ?? ''}:${t.error.line ?? ''}`;

/** Rows per insert: SQLite limits the values of one statement. */
const CHUNK = 500;

function writeRun(db: AppDatabase, state: RunState, removed: { artifacts?: Date; details?: Date }) {
	const values = {
		startedAt: new Date(state.startedAt),
		finishedAt: state.finishedAt ? new Date(state.finishedAt) : null,
		status: state.status,
		files: state.files,
		grep: state.grep ?? null,
		...state.stats,
		exitCode: state.exitCode ?? null
	};
	db.transaction((tx) => {
		tx.insert(run)
			.values({
				id: state.id,
				...values,
				artifactsRemovedAt: removed.artifacts ?? null,
				detailsRemovedAt: removed.details ?? null
			})
			.onConflictDoUpdate({ target: run.id, set: values })
			.run();
		tx.delete(runTest).where(eq(runTest.runId, state.id)).run();
		const rows = state.tests.map((t, position) => ({
			runId: state.id,
			position,
			key: t.key,
			file: t.file,
			title: t.title,
			status: t.status ?? null,
			setup: t.setup === true,
			failedAt: failedAt(t) ?? null,
			detailsRemoved: t.detailsRemoved === true,
			result: t
		}));
		for (let i = 0; i < rows.length; i += CHUNK)
			tx.insert(runTest)
				.values(rows.slice(i, i + CHUNK))
				.run();
	});
}

/** The files a run was kept in before the database. Their shape was written by this app. */
const OLD_FILES = [
	'state.json',
	'meta.json',
	'results.json',
	'artifacts-removed',
	'details-removed'
];

/** A file of an old run, or null when it is missing or cut off (the app stopped while writing). */
function readOldFile(dir: string, name: string): unknown {
	try {
		return JSON.parse(readFileSync(join(dir, name), 'utf8'));
	} catch {
		return null;
	}
}

/** What results.json kept of each test: enough for the list and the reliability table. */
type OldResult = Pick<RunTest, 'key' | 'file' | 'title' | 'status' | 'setup'> & {
	failedAt?: string;
};

/**
 * An old run from its state.json; when that is missing or cut off, from meta.json with the tests
 * from results.json (without steps).
 */
function readOldRun(dir: string): RunState | null {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- written by this app
	const state = readOldFile(dir, 'state.json') as RunState | null;
	if (state) return state;
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- written by this app
	const meta = readOldFile(dir, 'meta.json') as Omit<RunState, 'tests'> | null;
	if (!meta) return null;
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- written by this app
	const results = (readOldFile(dir, 'results.json') as OldResult[] | null) ?? [];
	const tests = results.map((r): RunTest => {
		const [file, line] = r.failedAt?.split(':') ?? [];
		const test: RunTest = {
			testId: r.key,
			key: r.key,
			file: r.file,
			title: r.title,
			line: 0,
			steps: [],
			attachments: []
		};
		if (r.status) test.status = r.status;
		if (r.setup) test.setup = true;
		if (r.failedAt) test.error = { message: '', file, line: Number(line) || undefined };
		return test;
	});
	return { ...meta, tests };
}

/**
 * Moves the runs kept in files (state.json and meta.json, before the database) into it, once at
 * the first use. The files are deleted afterwards: the retention rules delete steps and error
 * messages in the database only, so a copy left in a file would outlive them.
 */
function importOldRuns(db: AppDatabase) {
	if (!existsSync(RUNS_DIR)) return;
	const known = new Set(
		db
			.select({ id: run.id })
			.from(run)
			.all()
			.map((r) => r.id)
	);
	let imported = 0;
	for (const id of readdirSync(RUNS_DIR)) {
		const dir = within(RUNS_DIR, id);
		if (!dir || dir === RUNS_DIR || known.has(id)) continue;
		try {
			const state = readOldRun(dir);
			if (!state) continue;
			const when = (marker: string) =>
				existsSync(join(dir, marker))
					? new Date(readFileSync(join(dir, marker), 'utf8').trim() || Date.now())
					: undefined;
			writeRun(db, state, {
				artifacts: when('artifacts-removed'),
				details: when('details-removed')
			});
			for (const name of OLD_FILES) rmSync(join(dir, name), { force: true });
			imported += 1;
		} catch (e) {
			console.error(`Could not move run ${id} into the database:`, e);
		}
	}
	if (imported > 0) console.log(`Moved ${imported} runs from files into the database.`);
}

let ready = false;

function history(): AppDatabase {
	const opened = database();
	if (!ready) {
		ready = true;
		importOldRuns(opened);
	}
	return opened;
}

/** Stores a run: at its start, and with its tests when it has finished. Called by runner.ts. */
export function saveRun(state: RunState) {
	writeRun(history(), state, {});
}

const newestFirst = [desc(run.startedAt), desc(run.id)];

export function listRuns(): RunMeta[] {
	return history()
		.select()
		.from(run)
		.orderBy(...newestFirst)
		.all()
		.map((r) => toMeta(r));
}

/**
 * One page of the run list, newest first: the newest runs, or the ones after the run `before`.
 * `total` is the number of all runs.
 */
export function runsPage(
	before?: string,
	size = RUNS_PER_PAGE
): { runs: RunMeta[]; total: number } {
	const d = history();
	const total = d.select({ n: count() }).from(run).get()?.n ?? 0;
	let after;
	if (before !== undefined) {
		const anchor = d.select({ startedAt: run.startedAt }).from(run).where(eq(run.id, before)).get();
		// An unknown `before` (the run was deleted meanwhile) has no page after it.
		if (!anchor) return { runs: [], total };
		after = or(
			lt(run.startedAt, anchor.startedAt),
			and(eq(run.startedAt, anchor.startedAt), lt(run.id, before))
		);
	}
	const runs = d
		.select()
		.from(run)
		.where(after)
		.orderBy(...newestFirst)
		.limit(size)
		.all()
		.map((r) => toMeta(r));
	return { runs, total };
}

export function readRunState(id: string): RunState | null {
	const dir = within(RUNS_DIR, id);
	if (!dir || dir === RUNS_DIR) return null;
	const d = history();
	const row = d.select().from(run).where(eq(run.id, id)).get();
	if (!row) return null;
	const tests = d
		.select({ result: runTest.result })
		.from(runTest)
		.where(eq(runTest.runId, id))
		.orderBy(asc(runTest.position))
		.all()
		.map((t) => t.result);
	if (row.artifactsRemovedAt) {
		// The files the attachments point at are gone.
		for (const t of tests) t.attachments = [];
	}
	const log = existsSync(join(dir, 'output.log'))
		? readFileSync(join(dir, 'output.log'), 'utf8').split('\n').slice(-400)
		: [];
	return {
		...toMeta(row),
		tests,
		log,
		hasReport: existsSync(join(dir, 'report/index.html')),
		...(row.artifactsRemovedAt ? { artifactsRemoved: true } : {})
	};
}

/** Pilot exit criterion (guide §4.8): ten consecutive passes per flow. */
export const PILOT_STREAK = 10;

export function stability(): StabilityRow[] {
	const results = history()
		.select({
			runId: runTest.runId,
			key: runTest.key,
			file: runTest.file,
			title: runTest.title,
			status: runTest.status
		})
		.from(runTest)
		.innerJoin(run, eq(run.id, runTest.runId))
		.where(
			and(
				// A sign-in is no flow.
				eq(runTest.setup, false),
				// A test that was skipped or cut off by stopping the run says nothing about the flow.
				isNotNull(runTest.status),
				notInArray(runTest.status, ['skipped', 'interrupted'])
			)
		)
		.orderBy(asc(run.startedAt), asc(run.id))
		.all();
	const rows = new Map<string, StabilityRow>();
	for (const t of results) {
		if (!t.status) continue;
		const row = rows.get(t.key) ?? {
			key: t.key,
			file: t.file,
			title: t.title,
			history: [],
			streak: 0
		};
		row.history.push({ runId: t.runId, status: t.status });
		rows.set(t.key, row);
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
 * Clears the write-ahead log once rows were deleted or details removed: it still holds the earlier
 * versions of the changed pages. The pages in the database file itself are overwritten as they are
 * freed (secure_delete, db/database.ts).
 */
function dropDeleted() {
	history().run(sql`PRAGMA wal_checkpoint(TRUNCATE)`);
}

/** Deletes a run's directory and its rows. */
function deleteRun(id: string): boolean {
	const dir = within(RUNS_DIR, id);
	if (!dir || dir === RUNS_DIR || id === liveId) return false;
	rmSync(dir, { recursive: true, force: true });
	history().delete(run).where(eq(run.id, id)).run();
	return true;
}

/**
 * Deletes the oldest finished runs beyond TEST_APP_KEEP_RUNS. Off unless that is set to a positive
 * number: run history is the evidence for the pilot criterion, so nothing is deleted by default.
 */
export function pruneRuns(keep = Number(process.env.TEST_APP_KEEP_RUNS)): string[] {
	if (!Number.isInteger(keep) || keep < 1) return [];
	const removed = listRuns()
		.slice(keep)
		.map((r) => r.id)
		.filter((id) => deleteRun(id));
	if (removed.length > 0) dropDeleted();
	return removed;
}

/** Removes the steps and error messages of the run's tests not in `keep`. True when one changed. */
function removeDetails(id: string, keep: Set<string>): boolean {
	const d = history();
	const tests = d
		.select({ position: runTest.position, key: runTest.key, result: runTest.result })
		.from(runTest)
		.where(and(eq(runTest.runId, id), eq(runTest.detailsRemoved, false)))
		.all()
		.filter((t) => !keep.has(t.key));
	d.transaction((tx) => {
		for (const t of tests) {
			const result: RunTest = {
				...t.result,
				steps: [],
				...(t.result.error ? { error: { ...t.result.error, message: ERROR_REMOVED } } : {}),
				detailsRemoved: true
			};
			tx.update(runTest)
				.set({ result, detailsRemoved: true })
				.where(and(eq(runTest.runId, id), eq(runTest.position, t.position)))
				.run();
		}
	});
	return tests.length > 0;
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
	const d = history();
	const runs = d
		.select()
		.from(run)
		.orderBy(asc(run.startedAt), asc(run.id))
		.all()
		.filter((r) => toMeta(r).status !== 'running');
	// A run older than every limit keeps nothing and cannot matter to a younger one, so its tests
	// are not read.
	const oldest = new Date(
		now - Math.max(policy.reportDays, policy.stepsDays, policy.failureDays) * DAY
	);
	const tests = new Map<string, { key: string; status?: RunTest['status']; failedAt?: string }[]>();
	for (const t of d
		.select({
			runId: runTest.runId,
			key: runTest.key,
			status: runTest.status,
			failedAt: runTest.failedAt
		})
		.from(runTest)
		.innerJoin(run, eq(run.id, runTest.runId))
		.where(gte(run.startedAt, oldest))
		.orderBy(asc(runTest.position))
		.all()) {
		const list = tests.get(t.runId) ?? [];
		list.push({
			key: t.key,
			...(t.status ? { status: t.status } : {}),
			...(t.failedAt ? { failedAt: t.failedAt } : {})
		});
		tests.set(t.runId, list);
	}
	const decisions = decide(
		runs.map((r) => ({
			id: r.id,
			startedAt: r.startedAt.toISOString(),
			tests: tests.get(r.id) ?? []
		})),
		now,
		policy
	);
	const changed: string[] = [];
	for (const r of runs) {
		const dir = within(RUNS_DIR, r.id);
		const decision = decisions.get(r.id);
		if (!dir || dir === RUNS_DIR || !decision) continue;
		let touched = false;
		const set: Partial<RunRow> = {};
		if (!decision.artifacts && !r.artifactsRemovedAt) {
			rmSync(join(dir, 'report'), { recursive: true, force: true });
			rmSync(join(dir, 'results'), { recursive: true, force: true });
			set.artifactsRemovedAt = new Date(now);
			touched = true;
		}
		if (decision.details !== 'all' && !r.detailsRemovedAt) {
			if (removeDetails(r.id, decision.details)) touched = true;
			if (!decision.log) rmSync(join(dir, 'output.log'), { force: true });
			// Nothing left to remove later: the run is not read again.
			if (decision.details.size === 0 && !decision.log) {
				set.detailsRemovedAt = new Date(now);
				touched = true;
			}
		}
		if (Object.keys(set).length > 0) d.update(run).set(set).where(eq(run.id, r.id)).run();
		if (touched) changed.push(r.id);
	}
	if (changed.length > 0) dropDeleted();
	return changed;
}
