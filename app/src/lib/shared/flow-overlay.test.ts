import { describe, expect, test } from 'vitest';
import { overlaySteps } from './flow-overlay.js';
import type { FlowStep, RunTest } from './types.js';

const step = (id: string, line: number, kind: FlowStep['kind'] = 'action'): FlowStep => ({
	id,
	line,
	endLine: line,
	kind,
	action: 'x',
	code: '',
	issues: []
});

const steps = [step('a', 3), step('b', 4, 'helper'), step('c', 5), step('d', 6, 'assert')];

function runTest(partial: Partial<RunTest>): RunTest {
	return {
		testId: 't',
		key: 'k',
		file: 'f.spec.ts',
		title: 't',
		line: 2,
		steps: [],
		attachments: [],
		...partial
	};
}

describe('overlaySteps', () => {
	test('maps reporter steps by line and helper steps to the next helper call', () => {
		const o = overlaySteps(
			steps,
			runTest({
				status: 'passed',
				steps: [
					{ stepId: '1', title: 'Launch', category: 'pw:api', startTime: '' },
					{
						stepId: '2',
						title: 'fill',
						category: 'pw:api',
						file: 'f.spec.ts',
						line: 3,
						startTime: '',
						duration: 10
					},
					{
						stepId: '3',
						title: 'fill okCode',
						category: 'pw:api',
						line: 9,
						startTime: '',
						duration: 5
					},
					{ stepId: '4', title: 'press', category: 'pw:api', line: 10, startTime: '', duration: 7 },
					{
						stepId: '5',
						title: 'click',
						category: 'pw:api',
						file: 'f.spec.ts',
						line: 5,
						startTime: '',
						duration: 3
					},
					{
						stepId: '6',
						title: 'expect',
						category: 'expect',
						file: 'f.spec.ts',
						line: 6,
						startTime: '',
						duration: 1
					}
				]
			})
		);
		expect(o.a).toMatchObject({ status: 'passed', duration: 10 });
		expect(o.b).toMatchObject({ status: 'passed', duration: 12, calls: ['fill okCode', 'press'] });
		expect(o.d.status).toBe('passed');
	});

	test('marks the failing line and later steps as not reached', () => {
		const o = overlaySteps(
			steps,
			runTest({
				status: 'failed',
				error: { message: 'boom', file: 'f.spec.ts', line: 5 },
				steps: [
					{
						stepId: '2',
						title: 'fill',
						category: 'pw:api',
						file: 'f.spec.ts',
						line: 3,
						startTime: '',
						duration: 10
					},
					{
						stepId: '5',
						title: 'click',
						category: 'pw:api',
						file: 'f.spec.ts',
						line: 5,
						startTime: '',
						duration: 3,
						error: 'boom'
					}
				]
			})
		);
		expect(o.a.status).toBe('passed');
		// no call recorded before the failure: left pending rather than guessed
		expect(o.b.status).toBe('pending');
		expect(o.c).toMatchObject({ status: 'failed', error: 'boom' });
		expect(o.d.status).toBe('skipped');
	});

	test('shows a step as running while its call is open', () => {
		const o = overlaySteps(
			steps,
			runTest({
				running: true,
				steps: [
					{
						stepId: '2',
						title: 'fill',
						category: 'pw:api',
						file: 'f.spec.ts',
						line: 3,
						startTime: ''
					}
				]
			})
		);
		expect(o.a.status).toBe('running');
		expect(o.c.status).toBe('pending');
	});
});
