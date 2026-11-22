import { describe, expect, test } from 'vitest';
import { must } from '../../test/must.js';
import { decide, DEFAULT_RETENTION, retentionFromEnv, type RetentionRun } from './retention.js';
import type { TestStatus } from '#lib/shared/types.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-06-30T12:00:00.000Z');

/** A run of the test `flow`, `age` days ago, failing at `line` when one is given. */
function run(
	age: number,
	status: TestStatus,
	line?: number,
	other: Record<string, TestStatus> = {}
): RetentionRun {
	return {
		id: `run-${age}`,
		startedAt: new Date(NOW - age * DAY).toISOString(),
		tests: [
			{ key: 'flow', status, failedAt: line === undefined ? undefined : `a.spec.ts:${line}` },
			...Object.entries(other).map(([key, s]) => ({ key, status: s }))
		]
	};
}

/** What is kept of each run, oldest first: A artifacts, L log, D details of all or of `flow`. */
function kept(runs: RetentionRun[]): string[] {
	const decisions = decide(runs, NOW);
	return runs.map((r) => {
		const d = must(decisions.get(r.id));
		const details = d.details === 'all' ? 'D' : d.details.has('flow') ? 'd' : '';
		return `${d.artifacts ? 'A' : ''}${d.log ? 'L' : ''}${details}` || '-';
	});
}

describe('decide', () => {
	test('the newest run is kept in full, whatever its age', () => {
		expect(kept([run(400, 'passed'), run(300, 'passed')])).toEqual(['-', 'ALD']);
	});

	test('a passed run keeps its report for 14 days and its steps and log for 30', () => {
		expect(
			kept([
				run(31, 'passed'),
				run(30, 'passed'),
				run(15, 'passed'),
				run(14, 'passed'),
				run(0, 'passed')
			])
		).toEqual(['-', 'LD', 'LD', 'ALD', 'ALD']);
	});

	test('a failure stays in full while the test has not passed again', () => {
		expect(kept([run(80, 'failed', 5), run(79, 'skipped'), run(0, 'interrupted')])).toEqual([
			'ALd',
			'-',
			'ALD'
		]);
	});

	test('a fixed failure stays for 14 days after the pass, then goes', () => {
		expect(kept([run(60, 'failed', 5), run(14, 'passed'), run(0, 'passed')])[0]).toBe('ALd');
		expect(kept([run(60, 'failed', 5), run(15, 'passed'), run(0, 'passed')])[0]).toBe('-');
	});

	test('no failure is kept longer than 90 days', () => {
		expect(kept([run(91, 'failed', 5), run(90, 'failed', 7), run(0, 'failed', 9)])).toEqual([
			'-',
			'ALd',
			'ALD'
		]);
	});

	test('of a series of failures at the same place, the first and the latest stay', () => {
		// Fixed today: the first and the latest of the series stay for the days after the fix.
		expect(
			kept([
				run(50, 'failed', 5),
				run(49, 'failed', 5),
				run(48, 'failed', 5),
				run(47, 'failed', 5),
				run(0, 'passed')
			])
		).toEqual(['ALd', '-', '-', 'ALd', 'ALD']);
		expect(
			kept([run(50, 'failed', 5), run(49, 'failed', 5), run(48, 'failed', 5), run(47, 'failed', 5)])
		).toEqual(['ALd', '-', '-', 'ALD']);
	});

	test('a failure at another place starts a new series', () => {
		expect(
			kept([
				run(50, 'failed', 5),
				run(49, 'failed', 5),
				run(48, 'failed', 9),
				run(47, 'failed', 9),
				run(46, 'failed', 9),
				run(0, 'failed', 9)
			])
		).toEqual(['ALd', 'ALd', 'ALd', '-', '-', 'ALD']);
	});

	test('a pass in between ends a series', () => {
		expect(
			kept([run(50, 'failed', 5), run(49, 'passed'), run(48, 'failed', 5), run(0, 'failed', 5)])
		).toEqual(['-', '-', 'ALd', 'ALD']);
	});

	test('one needed failure keeps the whole run, but the details of that test only', () => {
		const runs = [run(50, 'passed', undefined, { broken: 'failed' }), run(0, 'passed')];
		const decision = must(decide(runs, NOW).get('run-50'));
		expect(decision).toMatchObject({ artifacts: true, log: true });
		expect(decision.details).toEqual(new Set(['broken']));
	});

	test('the limits can be changed', () => {
		const runs = [run(3, 'passed'), run(0, 'passed')];
		const strict = { reportDays: 1, stepsDays: 2, failureDays: 5 };
		expect(decide(runs, NOW, strict).get('run-3')).toEqual({
			artifacts: false,
			log: false,
			details: new Set()
		});
	});
});

describe('retentionFromEnv', () => {
	test('uses 14, 30 and 90 days unless told otherwise', () => {
		expect(retentionFromEnv({})).toEqual(DEFAULT_RETENTION);
		expect(DEFAULT_RETENTION).toEqual({ reportDays: 14, stepsDays: 30, failureDays: 90 });
		expect(
			retentionFromEnv({
				TEST_APP_KEEP_REPORT_DAYS: '7',
				TEST_APP_KEEP_STEPS_DAYS: 'soon',
				TEST_APP_KEEP_FAILURE_DAYS: '-1'
			})
		).toEqual({ reportDays: 7, stepsDays: 30, failureDays: 90 });
	});

	test('can be switched off, also with the setting of the earlier count-based rule', () => {
		expect(retentionFromEnv({ TEST_APP_RETENTION: 'off' })).toBeNull();
		expect(retentionFromEnv({ TEST_APP_KEEP_ARTIFACTS: 'all' })).toBeNull();
		expect(retentionFromEnv({ TEST_APP_KEEP_ARTIFACTS: '50' })).not.toBeNull();
	});
});
