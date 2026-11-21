import { describe, expect, test } from 'vitest';
import { must } from '../../test/must.js';
import { SETUP_DIR, TESTS_DIR, TESTS_ROOT } from './paths.js';
import { applyEvent, liveSnapshot, type ReporterEvent } from './run-events.js';
import type { RunState, TestStatus } from '#lib/shared/types.js';

const DIR = '/data/runs/r1';
const spec = `${TESTS_DIR}/fiori/a.spec.ts`;

function started(ids: string[]): RunState {
	const state: RunState = {
		id: 'r1',
		startedAt: '',
		status: 'running',
		files: [],
		stats: { total: 0, passed: 0, failed: 0, skipped: 0 },
		tests: [],
		log: [],
		hasReport: false
	};
	applyEvent(state, DIR, {
		type: 'begin',
		rootDir: TESTS_DIR,
		tests: ids.map((id) => ({
			id,
			title: id,
			titlePath: ['group', id],
			location: { file: spec, line: 3, column: 1 }
		}))
	});
	return state;
}

const end = (
	testId: string,
	status: TestStatus,
	extra: Partial<Extract<ReporterEvent, { type: 'testEnd' }>> = {}
): ReporterEvent => ({
	type: 'testEnd',
	testId,
	status,
	expectedStatus: 'passed',
	duration: 5,
	retry: 0,
	attachments: [],
	...extra
});

const at = (file: string) => ({ file, line: 1, column: 1 });

describe('applyEvent', () => {
	test('begin lists the tests with spec-relative file and key', () => {
		const state = started(['a']);
		expect(state.tests[0]).toMatchObject({
			key: 'fiori/a.spec.ts::group › a',
			file: 'fiori/a.spec.ts',
			line: 3
		});
		expect(state.stats.total).toBe(1);
	});

	test('marks the sign-ins of sap-tests/setup, and nothing else, as setup', () => {
		const state = started([]);
		applyEvent(state, DIR, {
			type: 'begin',
			rootDir: TESTS_DIR,
			tests: [
				{
					id: 's',
					title: 'sign in',
					titlePath: ['sign in'],
					location: at(`${SETUP_DIR}/sap.setup.ts`)
				},
				{
					id: 'h',
					title: 'helper',
					titlePath: ['helper'],
					location: at(`${TESTS_ROOT}/helpers/x.ts`)
				},
				{ id: 't', title: 'flow', titlePath: ['flow'], location: at(spec) }
			]
		});
		expect(state.tests.map((t) => [t.testId, t.setup])).toEqual([
			['s', true],
			['h', undefined],
			['t', undefined]
		]);
	});

	test('counts passed, failed and skipped; an interrupted test is none of them', () => {
		const state = started(['a', 'b', 'c', 'd', 'e']);
		applyEvent(state, DIR, end('a', 'passed'));
		applyEvent(state, DIR, end('b', 'failed'));
		applyEvent(state, DIR, end('c', 'timedOut'));
		applyEvent(state, DIR, end('d', 'skipped'));
		applyEvent(state, DIR, end('e', 'interrupted'));
		expect(state.stats).toEqual({ total: 5, passed: 1, failed: 2, skipped: 1 });
	});

	test('a test.fail() test that fails counts as passed and keeps its error', () => {
		const state = started(['a']);
		applyEvent(
			state,
			DIR,
			end('a', 'failed', { expectedStatus: 'failed', error: { message: 'boom' } })
		);
		expect(state.tests[0]).toMatchObject({
			status: 'passed',
			expectedFailure: true,
			error: { message: 'boom' }
		});
		expect(state.stats).toMatchObject({ passed: 1, failed: 0 });
	});

	test('a test.fail() test that passes counts as failed', () => {
		const state = started(['a']);
		applyEvent(state, DIR, end('a', 'passed', { expectedStatus: 'failed' }));
		const t = must(state.tests[0]);
		expect(t.status).toBe('failed');
		expect(t.error?.message).toContain('Expected to fail');
		expect(state.stats).toMatchObject({ passed: 0, failed: 1 });
	});

	test('a retry starts the test over', () => {
		const state = started(['a']);
		applyEvent(state, DIR, end('a', 'failed', { error: { message: 'boom' } }));
		applyEvent(state, DIR, { type: 'testBegin', testId: 'a', retry: 1, startTime: '' });
		expect(state.tests[0]).toMatchObject({ running: true, retry: 1, steps: [] });
		expect(state.tests[0]?.status).toBeUndefined();
		expect(state.stats.failed).toBe(0);
	});

	test('keeps only attachments inside the run directory, as relative paths', () => {
		const state = started(['a']);
		applyEvent(
			state,
			DIR,
			end('a', 'failed', {
				attachments: [
					{ name: 'trace', contentType: 'application/zip', path: `${DIR}/results/a/trace.zip` },
					{ name: 'other', contentType: 'text/plain', path: '/etc/passwd' }
				]
			})
		);
		expect(state.tests[0]?.attachments).toEqual([
			{ name: 'trace', contentType: 'application/zip', path: 'results/a/trace.zip' }
		]);
	});

	test('strips colour codes from step errors and maps the end status', () => {
		const state = started(['a']);
		applyEvent(state, DIR, {
			type: 'stepBegin',
			testId: 'a',
			stepId: 's1',
			title: 'click',
			category: 'pw:api',
			location: { file: spec, line: 4, column: 1 },
			startTime: ''
		});
		applyEvent(state, DIR, {
			type: 'stepEnd',
			testId: 'a',
			stepId: 's1',
			duration: 7,
			error: { message: '\u001B[31mTimeout\u001B[39m' }
		});
		expect(state.tests[0]?.steps[0]).toMatchObject({
			file: 'fiori/a.spec.ts',
			line: 4,
			duration: 7,
			error: 'Timeout'
		});
		applyEvent(state, DIR, { type: 'end', status: 'interrupted', duration: 1 });
		expect(state.status).toBe('interrupted');
	});
});

const step = (testId: string, stepId: string): ReporterEvent => ({
	type: 'stepBegin',
	testId,
	stepId,
	title: 'Click',
	category: 'pw:api',
	startTime: ''
});

const shape = (state: RunState) =>
	state.tests.map((t) => [t.testId, t.steps.length, t.stepsOmitted ?? false]);

/** Test a finished with one step, test b running with one step, test c not started. */
function midRun(): RunState {
	const state = started(['a', 'b', 'c']);
	state.log = ['line 1', 'line 2'];
	for (const id of ['a', 'b']) {
		applyEvent(state, DIR, { type: 'testBegin', testId: id, retry: 0, startTime: '' });
		applyEvent(state, DIR, step(id, 's-' + id));
	}
	applyEvent(state, DIR, end('a', 'passed'));
	return state;
}

describe('liveSnapshot', () => {
	test('leaves out the steps of finished tests and the log', () => {
		const snapshot = liveSnapshot(midRun(), {});
		expect(shape(snapshot)).toEqual([
			['a', 0, true],
			['b', 1, false],
			['c', 0, false]
		]);
		expect(snapshot.log).toEqual([]);
		// Everything else about a finished test stays.
		expect(snapshot.tests[0]).toMatchObject({ status: 'passed', running: false });
		expect(snapshot.stats).toMatchObject({ total: 3, passed: 1 });
	});

	test('keeps the steps of the tests in the watched file, and the log when asked for', () => {
		const snapshot = liveSnapshot(midRun(), { file: 'fiori/a.spec.ts', log: true });
		expect(shape(snapshot)).toEqual([
			['a', 1, false],
			['b', 1, false],
			['c', 0, false]
		]);
		expect(snapshot.log).toEqual(['line 1', 'line 2']);
		expect(shape(liveSnapshot(midRun(), { file: 'fiori/other.spec.ts' }))[0]).toEqual([
			'a',
			0,
			true
		]);
	});

	test('is a copy: later events do not change it, and it does not change the state', () => {
		const state = midRun();
		const snapshot = liveSnapshot(state, { log: true });
		applyEvent(state, DIR, step('b', 's-late'));
		state.log.push('line 3');
		expect(must(snapshot.tests[1]).steps).toHaveLength(1);
		expect(snapshot.log).toHaveLength(2);
		expect(must(state.tests[0]).steps).toHaveLength(1);
		expect(must(state.tests[0]).stepsOmitted).toBeUndefined();
	});
});
