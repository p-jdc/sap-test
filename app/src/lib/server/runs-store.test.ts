import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { must } from '../../test/must.js';
import type { RunState, TestStatus } from '#lib/shared/types.js';

// paths.ts reads TEST_APP_DATA_DIR when it is first imported, so each test gets a fresh data
// directory and a fresh copy of the store.
let dataDir = '';
let n = 0;

function freshStore() {
	dataDir = mkdtempSync(join(tmpdir(), 'runs-store-'));
	vi.stubEnv('TEST_APP_DATA_DIR', dataDir);
	vi.resetModules();
	return import('./runs-store.js');
}

/** Writes a run the way runner.ts does. Ids sort by creation order. */
function writeRun(
	results: Record<string, TestStatus>,
	status: RunState['status'] = 'passed'
): string {
	n += 1;
	const id = `20260101-0000${String(n).padStart(2, '0')}-abcd`;
	const dir = join(dataDir, 'runs', id);
	mkdirSync(dir, { recursive: true });
	const meta = {
		id,
		startedAt: `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`,
		status,
		files: [],
		stats: { total: 0, passed: 0, failed: 0, skipped: 0 }
	};
	const tests = Object.entries(results).map(([key, s]) => ({
		testId: key,
		key,
		file: 'a.spec.ts',
		title: key,
		line: 1,
		status: s,
		steps: [],
		attachments: []
	}));
	writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
	writeFileSync(join(dir, 'state.json'), JSON.stringify({ ...meta, tests }));
	return id;
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
	const file = join(dataDir, 'runs', id, 'state.json');
	// Written by writeRun above.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	const state = JSON.parse(readFileSync(file, 'utf8')) as RunState;
	const first = must(state.tests[0]);
	first.steps = [{ stepId: 's1', title: 'Click', category: 'pw:api', startTime: '' }];
	first.error = { message: 'Order 4711 not found', file: 'a.spec.ts', line: 7 };
	first.attachments = [
		{ name: 'trace', contentType: 'application/zip', path: 'results/test-a/trace.zip' }
	];
	writeFileSync(file, JSON.stringify(state));
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

describe('a long history', () => {
	test('finished runs are read from disk once, however often the list and the table are asked for', async () => {
		const store = await freshStore();
		const ids = Array.from({ length: 30 }, () => writeRun({ flow: 'passed' }));
		expect(store.listRuns()).toHaveLength(30);
		expect(store.stability()[0]?.streak).toBe(30);
		for (const id of ids) expect(store.readRunState(id)?.status).toBe('passed');

		// With the files gone, anything still answered comes from memory.
		for (const id of ids) {
			rmSync(join(dataDir, 'runs', id, 'meta.json'));
			rmSync(join(dataDir, 'runs', id, 'state.json'));
		}
		expect(store.listRuns()).toHaveLength(30);
		expect(store.stability()[0]?.streak).toBe(30);
		// The full state, with every step, is kept for the runs opened last only.
		expect(store.readRunState(must(ids.at(-1)))).not.toBeNull();
		expect(store.readRunState(must(ids[0]))).toBeNull();
	});

	test('a run that finishes is read again', async () => {
		const store = await freshStore();
		const id = writeRun({ flow: 'failed' }, 'running');
		store.markLive(id);
		expect(store.listRuns()[0]?.status).toBe('running');
		const dir = join(dataDir, 'runs', id);
		const meta = { ...store.listRuns()[0], status: 'passed' };
		writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
		store.rememberFinished(id);
		expect(store.listRuns()[0]?.status).toBe('passed');
	});
});
