import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { must } from '../../test/must.js';
import type { RunState, TestStatus } from '#lib/shared/types.js';

// paths.ts reads TEST_APP_DATA_DIR when it is first imported, so each test gets a fresh data
// directory, with its own database, and a fresh copy of the store.
let dataDir = '';
let n = 0;
type Store = typeof import('./runs-store.js');
let current: Store;

async function freshStore(): Promise<Store> {
	dataDir = mkdtempSync(join(tmpdir(), 'runs-store-'));
	vi.stubEnv('TEST_APP_DATA_DIR', dataDir);
	vi.resetModules();
	current = await import('./runs-store.js');
	return current;
}

/** A run with one test per entry of `results`. Ids sort by creation order. */
function runState(results: Record<string, TestStatus>, status: RunState['status']): RunState {
	n += 1;
	const id = `20260101-0000${String(n).padStart(2, '0')}-abcd`;
	return {
		id,
		startedAt: `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`,
		status,
		files: [],
		stats: { total: 0, passed: 0, failed: 0, skipped: 0 },
		tests: Object.entries(results).map(([key, s]) => ({
			testId: key,
			key,
			file: 'a.spec.ts',
			title: key,
			line: 1,
			status: s,
			steps: [],
			attachments: []
		})),
		log: [],
		hasReport: false
	};
}

/** Stores a run the way runner.ts does, with its directory. */
function writeRun(
	results: Record<string, TestStatus>,
	status: RunState['status'] = 'passed'
): string {
	const state = runState(results, status);
	mkdirSync(join(dataDir, 'runs', state.id), { recursive: true });
	current.saveRun(state);
	return state.id;
}

beforeEach(() => {
	n = 0;
	vi.unstubAllEnvs();
});

describe('stability', () => {
	test('counts consecutive passes since the last failure', async () => {
		const store = await freshStore();
		writeRun({ flow: 'passed' });
		writeRun({ flow: 'failed' });
		writeRun({ flow: 'passed' });
		writeRun({ flow: 'passed' });
		const [row] = store.stability();
		expect(row).toMatchObject({ key: 'flow', streak: 2, lastStatus: 'passed' });
		expect(row?.history.map((h) => h.status)).toEqual(['passed', 'failed', 'passed', 'passed']);
	});

	test('a skipped or interrupted test neither extends nor resets the streak', async () => {
		const store = await freshStore();
		writeRun({ flow: 'passed' });
		writeRun({ flow: 'passed' });
		writeRun({ flow: 'interrupted' }, 'interrupted');
		writeRun({ flow: 'skipped' });
		const [row] = store.stability();
		expect(row).toMatchObject({ streak: 2, lastStatus: 'passed' });
		expect(row?.history).toHaveLength(2);
	});

	test('a timeout resets the streak', async () => {
		const store = await freshStore();
		writeRun({ flow: 'passed' });
		writeRun({ flow: 'timedOut' });
		expect(store.stability()[0]).toMatchObject({ streak: 0, lastStatus: 'timedOut' });
	});
});

describe('the reliability table at a long history', () => {
	test('sends the latest 15 results of a test and counts the streak over all of them', async () => {
		const store = await freshStore();
		writeRun({ flow: 'failed' }, 'failed');
		const ids = Array.from({ length: 20 }, () => writeRun({ flow: 'passed' }));
		const [row] = store.stability();
		expect(row).toMatchObject({ streak: 20, lastStatus: 'passed' });
		expect(row?.history.map((h) => h.runId)).toEqual(ids.slice(-15));
	});

	test('a sign-in is no flow', async () => {
		const store = await freshStore();
		const state = runState({ flow: 'passed', 'sign in': 'passed' }, 'passed');
		const signIn = must(state.tests[1]);
		signIn.setup = true;
		store.saveRun(state);
		expect(store.stability().map((r) => r.key)).toEqual(['flow']);
	});
});

describe('runsPage', () => {
	test('returns the newest runs first, then the ones after a given run', async () => {
		const store = await freshStore();
		const ids = Array.from({ length: 5 }, () => writeRun({ flow: 'passed' })).toReversed();
		const first = store.runsPage(undefined, 2);
		expect(first.total).toBe(5);
		expect(first.runs.map((r) => r.id)).toEqual(ids.slice(0, 2));
		expect(store.runsPage(ids[1], 2).runs.map((r) => r.id)).toEqual(ids.slice(2, 4));
		expect(store.runsPage(ids[3], 2).runs.map((r) => r.id)).toEqual(ids.slice(4));
		expect(store.runsPage(ids[4], 2).runs).toEqual([]);
		expect(store.runsPage('20250101-000000-gone', 2).runs).toEqual([]);
		expect(store.runsPage().runs).toHaveLength(5);
	});
});

describe('runs cut off by an app restart', () => {
	test('a stored "running" run that is not live shows as interrupted', async () => {
		const store = await freshStore();
		const id = writeRun({}, 'running');
		expect(store.listRuns()[0]?.status).toBe('interrupted');
		expect(store.readRunState(id)?.status).toBe('interrupted');
	});

	test('the live run stays running until it is finished', async () => {
		const store = await freshStore();
		const id = writeRun({}, 'running');
		store.markLive(id);
		expect(store.listRuns()[0]?.status).toBe('running');
		expect(store.readRunState(id)?.status).toBe('running');
		store.rememberFinished(id);
		expect(store.readRunState(id)?.status).toBe('interrupted');
	});
});

describe('readRunState', () => {
	test('rejects ids that leave the runs directory', async () => {
		const store = await freshStore();
		writeRun({ flow: 'passed' });
		expect(store.readRunState('../runs')).toBeNull();
		expect(store.readRunState('nope')).toBeNull();
	});
});

describe('pruneRuns', () => {
	test('does nothing unless a limit is set', async () => {
		const store = await freshStore();
		writeRun({ flow: 'passed' });
		writeRun({ flow: 'passed' });
		expect(store.pruneRuns()).toEqual([]);
		expect(store.pruneRuns(0)).toEqual([]);
		expect(store.listRuns()).toHaveLength(2);
	});

	test('removes the oldest runs beyond the limit, never the live one', async () => {
		const store = await freshStore();
		const live = writeRun({}, 'running');
		const old = writeRun({ flow: 'passed' });
		const kept = [writeRun({ flow: 'passed' }), writeRun({ flow: 'passed' })];
		store.markLive(live);
		expect(store.pruneRuns(2)).toEqual([old]);
		expect(existsSync(join(dataDir, 'runs', old))).toBe(false);
		expect(
			store
				.listRuns()
				.map((r) => r.id)
				.toSorted()
		).toEqual([live, ...kept].toSorted());
	});

	test('reads the limit from TEST_APP_KEEP_RUNS', async () => {
		const store = await freshStore();
		writeRun({ flow: 'passed' });
		writeRun({ flow: 'passed' });
		vi.stubEnv('TEST_APP_KEEP_RUNS', '1');
		expect(store.pruneRuns()).toHaveLength(1);
	});
});

/** Gives a run the files Playwright leaves behind. */
function withArtifacts(id: string) {
	const dir = join(dataDir, 'runs', id);
	mkdirSync(join(dir, 'report'), { recursive: true });
	mkdirSync(join(dir, 'results/test-a'), { recursive: true });
	writeFileSync(join(dir, 'report/index.html'), '<html></html>');
	writeFileSync(join(dir, 'results/test-a/trace.zip'), 'zip');
	writeFileSync(join(dir, 'output.log'), 'line one\n');
	return dir;
}

const DAY = 24 * 60 * 60 * 1000;
// writeRun dates its runs 2026-01-01, a second apart.
const DAYS_LATER = (days: number) => Date.parse('2026-01-01T00:00:00.000Z') + days * DAY;

/** Gives the first test of a stored run a step, an error and an attachment. */
function withDetails(id: string) {
	const state = must(current.readRunState(id));
	const first = must(state.tests[0]);
	first.steps = [{ stepId: 's1', title: 'Click', category: 'pw:api', startTime: '' }];
	first.error = { message: 'Order 4711 not found', file: 'a.spec.ts', line: 7 };
	first.attachments = [
		{ name: 'trace', contentType: 'application/zip', path: 'results/test-a/trace.zip' }
	];
	current.saveRun(state);
}

describe('applyRetention', () => {
	test('an old run loses its files, steps, error messages and log, and keeps what happened', async () => {
		const store = await freshStore();
		const old = writeRun({ flow: 'failed', other: 'passed' }, 'failed');
		const fixed = writeRun({ flow: 'passed' });
		const newest = writeRun({ flow: 'passed' });
		const oldDir = withArtifacts(old);
		const newestDir = withArtifacts(newest);
		withArtifacts(fixed);
		withDetails(old);
		// Opened before, as a user would have.
		expect(store.readRunState(old)).toMatchObject({ hasReport: true });

		// 40 days on: the failure was fixed long ago.
		expect(store.applyRetention(DAYS_LATER(40))).toEqual([old, fixed]);
		expect(existsSync(join(oldDir, 'report'))).toBe(false);
		expect(existsSync(join(oldDir, 'results'))).toBe(false);
		expect(existsSync(join(oldDir, 'output.log'))).toBe(false);
		expect(existsSync(join(newestDir, 'results/test-a/trace.zip'))).toBe(true);

		const state = must(store.readRunState(old));
		expect(state).toMatchObject({ status: 'failed', hasReport: false, artifactsRemoved: true });
		expect(state.log).toEqual([]);
		expect(state.tests[0]).toMatchObject({
			status: 'failed',
			steps: [],
			attachments: [],
			detailsRemoved: true,
			error: { message: 'The error message was removed to save space.', line: 7 }
		});
		expect(JSON.stringify(state)).not.toContain('4711');
		// Nor is it left readable in the database file or its write-ahead log.
		const raw = ['app.sqlite', 'app.sqlite-wal']
			.map((f) => join(dataDir, f))
			.filter((f) => existsSync(f))
			.map((f) => readFileSync(f, 'latin1'))
			.join('');
		expect(raw).not.toContain('Order 4711');
		expect(store.readRunState(newest)?.artifactsRemoved).toBeUndefined();
		expect(
			store
				.stability()
				.find((r) => r.key === 'flow')
				?.history.map((h) => h.status)
		).toEqual(['failed', 'passed', 'passed']);
		// A second pass has nothing left to do.
		expect(store.applyRetention(DAYS_LATER(40))).toEqual([]);
	});

	test('a failure that is still open stays in full; the passed tests beside it lose their steps', async () => {
		const store = await freshStore();
		const open = writeRun({ flow: 'failed', other: 'passed' }, 'failed');
		writeRun({ unrelated: 'passed' });
		const dir = withArtifacts(open);
		withDetails(open);

		expect(store.applyRetention(DAYS_LATER(40))).toEqual([open]);
		expect(existsSync(join(dir, 'results/test-a/trace.zip'))).toBe(true);
		expect(existsSync(join(dir, 'output.log'))).toBe(true);
		const state = must(store.readRunState(open));
		expect(state.tests.map((t) => [t.key, t.steps.length, t.detailsRemoved])).toEqual([
			['flow', 1, undefined],
			['other', 0, true]
		]);
		expect(must(state.tests[0]).error?.message).toBe('Order 4711 not found');

		// After 90 days it goes, open or not.
		expect(store.applyRetention(DAYS_LATER(91))).toEqual([open]);
		expect(existsSync(join(dir, 'results'))).toBe(false);
		expect(must(store.readRunState(open)).tests[0]).toMatchObject({
			steps: [],
			detailsRemoved: true
		});
	});

	test("the healer's test runs go with the run's files, its report with the log", async () => {
		const store = await freshStore();
		const old = writeRun({ flow: 'failed' }, 'failed');
		writeRun({ flow: 'passed' });
		const dir = withArtifacts(old);
		const healer = join(dir, 'healer');
		mkdirSync(join(healer, 't1-results/a-chromium'), { recursive: true });
		mkdirSync(join(healer, 't1-browser'), { recursive: true });
		writeFileSync(join(healer, 't1-results/a-chromium/trace.zip'), 'zip');
		writeFileSync(join(healer, 't1.json'), '{}');

		// 20 days on: the failure was fixed; the files go, the steps and the log stay.
		store.applyRetention(DAYS_LATER(20));
		expect(existsSync(join(dir, 'results'))).toBe(false);
		expect(existsSync(join(healer, 't1-results'))).toBe(false);
		expect(existsSync(join(healer, 't1-browser'))).toBe(false);
		expect(existsSync(join(dir, 'output.log'))).toBe(true);
		expect(existsSync(join(healer, 't1.json'))).toBe(true);
		// Results written after the run's own files went are removed on the next pass.
		mkdirSync(join(healer, 't2-results'), { recursive: true });
		store.applyRetention(DAYS_LATER(21));
		expect(existsSync(join(healer, 't2-results'))).toBe(false);

		store.applyRetention(DAYS_LATER(40));
		expect(existsSync(join(dir, 'output.log'))).toBe(false);
		expect(existsSync(healer)).toBe(false);
	});

	test('the run the healer works on is left alone until its session ends', async () => {
		const store = await freshStore();
		const { setHealingRun } = await import('./healing-run.js');
		const old = writeRun({ flow: 'failed' }, 'failed');
		writeRun({ flow: 'passed' });
		const dir = withArtifacts(old);
		setHealingRun(old);
		expect(store.applyRetention(DAYS_LATER(40))).toEqual([]);
		expect(existsSync(join(dir, 'output.log'))).toBe(true);
		setHealingRun(null);
		expect(store.applyRetention(DAYS_LATER(40))).toEqual([old]);
		expect(existsSync(join(dir, 'output.log'))).toBe(false);
	});

	test('the run of a repair nobody has read stays, also when runs are pruned', async () => {
		const tests = mkdtempSync(join(tmpdir(), 'runs-store-tests-'));
		mkdirSync(join(tests, 'tests'));
		writeFileSync(join(tests, 'tests/a.spec.ts'), 'what the healer wrote');
		vi.stubEnv('SAP_TESTS_DIR', tests);
		const store = await freshStore();
		const old = writeRun({ flow: 'failed' }, 'failed');
		writeRun({ flow: 'passed' });
		const dir = withArtifacts(old);
		const record = join(dataDir, 'healer-unreviewed.json');
		writeFileSync(
			record,
			JSON.stringify({
				runId: old,
				testId: 't1',
				title: 'flow',
				files: { [join(tests, 'tests/a.spec.ts')]: { before: null } }
			})
		);
		expect(store.applyRetention(DAYS_LATER(40))).toEqual([]);
		expect(store.pruneRuns(1)).toEqual([]);
		expect(existsSync(join(dir, 'output.log'))).toBe(true);
		rmSync(record);
		expect(store.applyRetention(DAYS_LATER(40))).toEqual([old]);
		expect(store.pruneRuns(1)).toEqual([old]);
	});

	test('recent runs are left alone, and so is everything when the rules are off', async () => {
		const store = await freshStore();
		const old = writeRun({ flow: 'passed' });
		writeRun({ flow: 'passed' });
		const dir = withArtifacts(old);
		expect(store.applyRetention(DAYS_LATER(10))).toEqual([]);
		expect(store.applyRetention(DAYS_LATER(400), null)).toEqual([]);
		vi.stubEnv('TEST_APP_RETENTION', 'off');
		expect(store.applyRetention(DAYS_LATER(400))).toEqual([]);
		expect(existsSync(join(dir, 'report/index.html'))).toBe(true);

		vi.stubEnv('TEST_APP_RETENTION', '');
		vi.stubEnv('TEST_APP_KEEP_REPORT_DAYS', '5');
		expect(store.applyRetention(DAYS_LATER(10))).toEqual([old]);
		expect(existsSync(join(dir, 'report'))).toBe(false);
		expect(existsSync(join(dir, 'output.log'))).toBe(true);
	});

	test('never touches the run that is still running', async () => {
		const store = await freshStore();
		const live = writeRun({ flow: 'failed' }, 'running');
		writeRun({ flow: 'passed' });
		const dir = withArtifacts(live);
		store.markLive(live);
		expect(store.applyRetention(DAYS_LATER(400))).toEqual([]);
		expect(existsSync(join(dir, 'report/index.html'))).toBe(true);
	});
});

describe('a run that finishes', () => {
	test('is stored running at its start and with its result at its end', async () => {
		const store = await freshStore();
		const state = runState({ flow: 'failed' }, 'running');
		const tests = state.tests;
		store.saveRun({ ...state, tests: [] });
		store.markLive(state.id);
		expect(store.listRuns()[0]?.status).toBe('running');
		store.saveRun({ ...state, tests, status: 'failed', finishedAt: '2026-01-01T00:01:00.000Z' });
		store.rememberFinished(state.id);
		expect(store.listRuns()[0]).toMatchObject({ status: 'failed', exitCode: null });
		expect(store.readRunState(state.id)?.tests.map((t) => t.status)).toEqual(['failed']);
	});
});

/** Writes a run the way this app kept them before the database. */
function writeOldRun(results: Record<string, TestStatus>, status: RunState['status'] = 'passed') {
	const { log, hasReport, ...state } = runState(results, status);
	void log;
	void hasReport;
	const { tests, ...meta } = state;
	void tests;
	const dir = join(dataDir, 'runs', state.id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
	writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
	writeFileSync(join(dir, 'results.json'), '[]');
	writeFileSync(join(dir, 'output.log'), 'line one\n');
	return { id: state.id, dir };
}

describe('runs kept in files before the database', () => {
	test('move into it once at the first use, and their files go', async () => {
		dataDir = mkdtempSync(join(tmpdir(), 'runs-store-'));
		const passed = writeOldRun({ flow: 'passed' });
		const failed = writeOldRun({ flow: 'failed' }, 'failed');
		writeFileSync(join(failed.dir, 'artifacts-removed'), '2026-02-01T00:00:00.000Z');
		// The app stopped while writing this state.json: meta.json and results.json still tell.
		const cut = writeOldRun({ flow: 'passed' });
		writeFileSync(join(cut.dir, 'state.json'), '{"id":');
		writeFileSync(
			join(cut.dir, 'results.json'),
			JSON.stringify([{ key: 'flow', file: 'a.spec.ts', title: 'flow', status: 'passed' }])
		);
		// A run that was cut off before its state was written has nothing to move.
		mkdirSync(join(dataDir, 'runs', '20260101-000099-none'));
		vi.stubEnv('TEST_APP_DATA_DIR', dataDir);
		vi.resetModules();
		const store = await import('./runs-store.js');

		expect(store.listRuns().map((r) => r.id)).toEqual([cut.id, failed.id, passed.id]);
		expect(store.stability()[0]?.history.map((h) => h.status)).toEqual([
			'passed',
			'failed',
			'passed'
		]);
		expect(store.readRunState(failed.id)).toMatchObject({
			status: 'failed',
			artifactsRemoved: true,
			log: ['line one', '']
		});
		for (const name of ['state.json', 'meta.json', 'results.json', 'artifacts-removed'])
			expect(existsSync(join(failed.dir, name))).toBe(false);
		// The log stays a file.
		expect(readFileSync(join(failed.dir, 'output.log'), 'utf8')).toBe('line one\n');

		// Moved once: a restart finds them in the database.
		vi.resetModules();
		const restarted = await import('./runs-store.js');
		expect(restarted.listRuns()).toHaveLength(3);
	});
});
