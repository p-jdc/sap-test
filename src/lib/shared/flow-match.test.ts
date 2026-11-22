import { describe, expect, test } from 'vitest';
import { matchFlow } from './flow-match.js';
import type { RunTest, SpecTest } from './types.js';

const spec = (key: string, line: number, dynamic?: boolean): SpecTest => ({
	key,
	file: 'a.spec.ts',
	title: key,
	titlePath: [key],
	line,
	surface: 'demo',
	steps: [],
	issues: [],
	dynamic
});

const result = (key: string, line: number, partial: Partial<RunTest> = {}): RunTest => ({
	testId: key,
	key,
	file: 'a.spec.ts',
	title: key,
	line,
	status: 'passed',
	steps: [],
	attachments: [],
	...partial
});

const specs = [spec('fixed', 3), spec('order ${c.name}', 9, true)];

describe('matchFlow', () => {
	test('matches a fixed title by key', () => {
		const runs = [result('fixed', 3), result('order A', 9)];
		expect(matchFlow(specs, runs, 'fixed')).toEqual({ test: specs[0], runTest: runs[0] });
	});

	test('a fixed test that was not in the run has no result', () => {
		expect(matchFlow(specs, [result('order A', 9)], 'fixed')).toEqual({
			test: specs[0],
			runTest: undefined
		});
	});

	test('a run key of a generated test finds the dynamic spec test by file and line', () => {
		const runs = [result('order A', 9), result('order B', 9)];
		expect(matchFlow(specs, runs, 'order B')).toEqual({ test: specs[1], runTest: runs[1] });
	});

	test('the spec key of a dynamic test shows the running or failed result first', () => {
		const passed = result('order A', 9);
		const failed = result('order B', 9, { status: 'failed' });
		const running = result('order C', 9, { status: undefined, running: true });
		const key = 'order ${c.name}';
		expect(matchFlow(specs, [passed, failed], key).runTest).toBe(failed);
		expect(matchFlow(specs, [passed, failed, running], key).runTest).toBe(running);
		expect(matchFlow(specs, [passed], key).runTest).toBe(passed);
		expect(matchFlow(specs, [result('fixed', 3)], key).runTest).toBeUndefined();
	});

	test('an unknown key matches nothing', () => {
		expect(matchFlow(specs, [result('fixed', 3)], 'gone')).toEqual({});
	});
});
