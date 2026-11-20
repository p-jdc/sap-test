import { mkdirSync, mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
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
