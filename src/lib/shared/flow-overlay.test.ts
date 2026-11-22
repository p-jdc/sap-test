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

// A `test.step` group spans the lines of the steps inside it.
const grouped: FlowStep[] = [
	{ ...step('g', 3, 'group'), endLine: 6 },
	step('g1', 4),
	step('g2', 5),
	step('after', 7, 'assert')
];
const call = (stepId: string, line: number, extra: Partial<RunTest['steps'][number]> = {}) => ({
	stepId,
	title: stepId,
	category: 'pw:api',
	file: 'f.spec.ts',
	line,
	startTime: '',
	duration: 5,
	...extra
});

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
		expect(o.d?.status).toBe('passed');
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
		expect(o.a?.status).toBe('passed');
		// no call recorded before the failure: left pending rather than guessed
		expect(o.b?.status).toBe('pending');
		expect(o.c).toMatchObject({ status: 'failed', error: 'boom' });
		expect(o.d?.status).toBe('skipped');
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
		expect(o.a?.status).toBe('running');
		expect(o.c?.status).toBe('pending');
	});

	test('maps calls inside a test.step group to the inner steps, not the group', () => {
		const o = overlaySteps(
			grouped,
			runTest({
				status: 'passed',
				steps: [
					call('1', 3, { duration: 12 }),
					call('2', 4, { parentId: '1' }),
					call('3', 5, { parentId: '1' }),
					call('4', 7)
				]
			})
		);
		expect(Object.values(o).map((x) => x.status)).toEqual(['passed', 'passed', 'passed', 'passed']);
		expect(o.g?.calls).toEqual(['1']);
		expect(o.g1?.calls).toEqual(['2']);
		expect(o.g2?.calls).toEqual(['3']);
	});

	test('a failure inside a group marks the inner step and skips what follows', () => {
		const o = overlaySteps(
			grouped,
			runTest({
				status: 'failed',
				error: { message: 'boom', line: 4, file: 'f.spec.ts' },
				steps: [call('1', 3, { error: 'boom' }), call('2', 4, { parentId: '1', error: 'boom' })]
			})
		);
		expect(Object.values(o).map((x) => x.status)).toEqual([
			'failed',
			'failed',
			'skipped',
			'skipped'
		]);
	});
});
