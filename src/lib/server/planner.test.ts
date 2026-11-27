import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { PlannerState } from '#lib/shared/types.js';

// paths.ts reads TEST_APP_DATA_DIR when it is first imported.
type Planner = typeof import('./planner.js');
let planner: Planner;
let data = '';

beforeEach(async () => {
	data = mkdtempSync(join(tmpdir(), 'planner-data-'));
	vi.stubEnv('TEST_APP_DATA_DIR', data);
	vi.stubEnv('TEST_APP_PLANNER', '');
	vi.resetModules();
	planner = await import('./planner.js');
});

function saved(id: string, state: Partial<PlannerState>) {
	const full: PlannerState = {
		id,
		flow: 'check out',
		target: 'https://example.org',
		status: 'finished',
		startedAt: '2026-01-01T00:00:00.000Z',
		activity: ['Opens the browser'],
		...state
	};
	mkdirSync(join(data, 'planner', id), { recursive: true });
	writeFileSync(join(data, 'planner', id, 'state.json'), JSON.stringify(full));
}

describe('startPlanning', () => {
	test('is off unless TEST_APP_PLANNER is on', async () => {
		const result = await planner.startPlanning({ address: 'https://example.org', flow: 'x' });
		expect(result).toHaveProperty('ok', false);
		expect(result).toHaveProperty('error', expect.stringMatching(/^The planner is off/));
		expect(planner.activePlanning()).toBeNull();
	});

	test("is refused while the record of the healer's unread repairs stands", async () => {
		vi.stubEnv('TEST_APP_PLANNER', 'on');
		// One that cannot be read blocks all test code, the planner's seed test included.
		writeFileSync(join(data, 'healer-unreviewed.json'), '{');
		expect(planner.plannerProblem()).toMatch(/cannot be read, so no test code runs/);
		const result = await planner.startPlanning({ address: 'https://example.org', flow: 'x' });
		expect(result).toHaveProperty('error', expect.stringMatching(/so no test code runs/));
		expect(planner.activePlanning()).toBeNull();
	});
});

describe('the sessions', () => {
	test('are listed newest first, without their activity', () => {
		saved('20260101-000001-aaaa', {});
		saved('20260102-000001-bbbb', { plan: 'sap-tests/specs/x.plan.md' });
		mkdirSync(join(data, 'planner', 'not-a-session'));
		const list = planner.listPlannings();
		expect(list.map((s) => s.id)).toEqual(['20260102-000001-bbbb', '20260101-000001-aaaa']);
		expect(list[0]).toMatchObject({ plan: 'sap-tests/specs/x.plan.md', activity: [] });
		expect(planner.planningState('20260101-000001-aaaa')?.activity).toEqual(['Opens the browser']);
	});

	test('one the app stopped in is shown as stopped', () => {
		saved('20260101-000001-aaaa', { status: 'running' });
		expect(planner.planningState('20260101-000001-aaaa')).toMatchObject({
			status: 'stopped',
			error: 'The app stopped.'
		});
	});

	test('an id that is not one, or a broken file, is no session', () => {
		expect(planner.planningState('../../etc')).toBeNull();
		mkdirSync(join(data, 'planner', '20260101-000001-aaaa'), { recursive: true });
		writeFileSync(join(data, 'planner', '20260101-000001-aaaa', 'state.json'), '{');
		expect(planner.planningState('20260101-000001-aaaa')).toBeNull();
		expect(planner.listPlannings()).toEqual([]);
	});

	test('show a plan only from the plans folder', () => {
		// Files of this repository: one in the plans folder, two outside it.
		saved('20260101-000001-aaaa', { plan: 'sap-tests/specs/README.md' });
		expect(planner.planText('20260101-000001-aaaa')).toContain('# Specs');
		saved('20260102-000001-bbbb', { plan: 'sap-tests/CLAUDE.md' });
		expect(planner.planText('20260102-000001-bbbb')).toBeNull();
		saved('20260103-000001-cccc', { plan: 'sap-tests/specs/../CLAUDE.md' });
		expect(planner.planText('20260103-000001-cccc')).toBeNull();
	});
});

describe('the lock while the planner works', () => {
	test('keeps a run from starting, and names the planner', async () => {
		const lock = await import('./healing-run.js');
		expect(lock.planningBlock()).toBeUndefined();
		lock.setPlanning('check out');
		expect(lock.planningBlock()).toMatch(/^The planner is exploring/);
		// A run asks its `busy` callback after its last await, and answers with what it says.
		const { startRun } = await import('./runner.js');
		expect(await startRun({}, lock.planningBlock)).toEqual({
			ok: false,
			error: lock.planningBlock()
		});
		lock.setPlanning(null);
		expect(lock.planningBlock()).toBeUndefined();
	});
});
