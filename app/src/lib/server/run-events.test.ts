import { describe, expect, test } from 'vitest';
import { must } from '../../test/must.js';
import { TESTS_DIR } from './paths.js';
import { applyEvent, type ReporterEvent } from './run-events.js';
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
