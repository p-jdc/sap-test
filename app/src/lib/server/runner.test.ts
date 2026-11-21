/**
 * The runner starts Playwright, turns its output into the run state and keeps one run at a time.
 * These tests put a stand-in for Playwright's CLI into a temporary test project: a script that
 * prints what the live reporter would print. The real CLI is covered by the app's e2e test.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { must } from '../../test/must.js';
import type { RunState } from '#lib/shared/types.js';
import { copySystems } from '../../test/systems.js';

// Runs on the Node that would run Playwright. FAKE_RUN picks what the "run" does; the arguments
// are written to argv.json in the test project.
const FAKE_CLI = String.raw`
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));
const emit = (event) => process.stdout.write('@@pwlive@@' + JSON.stringify(event) + '\n');
const test = {
	id: 't1',
	title: 'creates an order',
	titlePath: ['creates an order'],
	location: { file: join(process.cwd(), 'tests/a.spec.ts'), line: 3, column: 1 }
};
const mode = process.env.FAKE_RUN;
if (mode === 'pass' || mode === 'hang' || mode === 'secret') {
	emit({ type: 'begin', rootDir: process.cwd(), tests: [test] });
	emit({ type: 'testBegin', testId: 't1', retry: 0, startTime: new Date().toISOString() });
}
if (mode === 'pass') {
	console.log('\u001B[32mhello ä\u001B[0m');
	process.stdout.write('@@pwlive@@{not json\n');
	emit({
		type: 'testEnd',
		testId: 't1',
		status: 'passed',
		expectedStatus: 'passed',
		duration: 5,
		retry: 0,
		attachments: []
	});
	emit({ type: 'end', status: 'passed', duration: 5 });
	process.stdout.write('last line without newline');
}
if (mode === 'sign-in-failed') {
	// The sign-in setup project fails, so Playwright never runs the test that depends on it.
	const signIn = {
		id: 'setup1',
		title: 'sign in to SAP',
		titlePath: ['sign in to SAP'],
		location: { file: join(process.cwd(), 'setup/sign-in.setup.ts'), line: 5, column: 1 }
	};
	emit({ type: 'begin', rootDir: process.cwd(), tests: [signIn, test] });
	emit({ type: 'testBegin', testId: 'setup1', retry: 0, startTime: new Date().toISOString() });
	emit({
		type: 'testEnd',
		testId: 'setup1',
		status: 'failed',
		expectedStatus: 'passed',
		duration: 5,
		retry: 0,
		error: { message: 'Still on the login page' },
		attachments: []
	});
	emit({ type: 'end', status: 'failed', duration: 5 });
}
if (mode === 'secret') {
	// What Playwright reports for fill(password): the value in the step title and in errors.
	emit({
		type: 'stepBegin',
		testId: 't1',
		stepId: 's1',
		title: 'Fill "pw-from-env"',
		category: 'pw:api',
		startTime: new Date().toISOString()
	});
	emit({ type: 'stepEnd', testId: 't1', stepId: 's1', duration: 1 });
	console.log('typed pw-from-env');
	emit({
		type: 'testEnd',
		testId: 't1',
		status: 'failed',
		expectedStatus: 'passed',
		duration: 5,
		retry: 0,
		error: { message: 'Expected "pw-from-env" to be gone', stack: 'at pw-from-env' },
		attachments: []
	});
	emit({ type: 'end', status: 'failed', duration: 5 });
}
if (mode === 'hang') {
	process.on('SIGINT', () => {
		emit({ type: 'end', status: 'interrupted', duration: 1 });
		process.exit(130);
	});
	setInterval(() => {}, 1000);
}
`;

let testsRoot = '';

/** A fresh runner on a fresh test project and data directory. */
async function freshRunner(
	run: 'pass' | 'hang' | 'secret' | 'sign-in-failed' | 'none',
	installed = true
) {
	// The real path: the stand-in reports files under its working directory, and on macOS the
	// temporary folder is reached through a link.
	testsRoot = realpathSync(mkdtempSync(join(tmpdir(), 'runner-tests-')));
	if (installed) {
		const pkg = join(testsRoot, 'node_modules/@playwright/test');
		mkdirSync(pkg, { recursive: true });
		writeFileSync(join(pkg, 'cli.js'), FAKE_CLI);
	}
	copySystems(testsRoot);
	vi.stubEnv('SAP_TESTS_DIR', testsRoot);
	vi.stubEnv('TEST_APP_DATA_DIR', mkdtempSync(join(tmpdir(), 'runner-data-')));
	vi.stubEnv('FAKE_RUN', run);
	vi.resetModules();
	const [runner, store, paths] = await Promise.all([
		import('./runner.js'),
		import('./runs-store.js'),
		import('./paths.js')
	]);
	return { ...runner, ...store, RUNS_DIR: paths.RUNS_DIR };
}

type Runner = Awaited<ReturnType<typeof freshRunner>>;

async function started(runner: Runner, input: Parameters<Runner['startRun']>[0] = {}) {
	const result = await runner.startRun(input);
	if (!result.ok) throw new Error(result.error);
	return result.id;
}

/** Follows a run the way the UI does and returns its last snapshot. */
async function finished(runner: Runner, id: string): Promise<RunState> {
	let last: RunState | undefined;
	for await (const snapshot of runner.watchRun(id)) last = snapshot;
	return must(last);
}

/** Resolves once the run's first test has started. */
async function testRunning(runner: Runner, id: string) {
	for await (const snapshot of runner.watchRun(id)) {
		if (snapshot.tests[0]?.running) return;
	}
}

const argv = (): unknown => JSON.parse(readFileSync(join(testsRoot, 'argv.json'), 'utf8'));

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('startRun', () => {
	test('says how to install Playwright when the test project has none', async () => {
		const runner = await freshRunner('pass', false);
		const result = await runner.startRun({});
		expect(result.ok).toBe(false);
		expect(JSON.stringify(result)).toContain('bun run setup');
		expect(runner.activeRunId()).toBeNull();
	});

	test('a run that passes ends as passed, with its output and a stored state', async () => {
		const runner = await freshRunner('pass');
		const id = await started(runner);
		const state = await finished(runner, id);

		expect(state).toMatchObject({
			status: 'passed',
			exitCode: 0,
			stats: { total: 1, passed: 1, failed: 0, skipped: 0 },
			hasReport: false
		});
		expect(state.tests[0]).toMatchObject({
			key: 'a.spec.ts::creates an order',
			line: 3,
			status: 'passed',
			running: false
		});
		// Colour codes are gone, a broken event line is dropped, an unterminated last line is kept.
		expect(state.log).toContain('hello ä');
		expect(state.log).toContain('last line without newline');
		expect(state.log.join('\n')).not.toContain('@@pwlive@@');
		expect(readFileSync(join(runner.RUNS_DIR, id, 'output.log'), 'utf8')).toContain('hello ä');

		expect(runner.activeRunId()).toBeNull();
		expect(runner.readRunState(id)).toMatchObject({ id, status: 'passed' });
		expect(runner.listRuns().map((r) => r.id)).toEqual([id]);
	});

	test('passes spec files inside the test folder and the title filter to Playwright', async () => {
		const runner = await freshRunner('pass');
		const id = await started(runner, {
			files: ['fiori/a.spec.ts:12', '../../outside.spec.ts'],
			grep: 'order'
		});
		const state = await finished(runner, id);

		expect(state.files).toEqual(['fiori/a.spec.ts:12']);
		const args = argv();
		expect(args).toEqual(
			expect.arrayContaining(['test', 'tests/fiori/a.spec.ts:12', '--grep', 'order'])
		);
		expect(JSON.stringify(args)).not.toContain('outside');
	});

	test('passwords never reach the run state, the log or the stored files', async () => {
		const runner = await freshRunner('secret');
		// The test project reads its passwords from .env; the runner masks them wherever they are set.
		writeFileSync(join(testsRoot, '.env'), 'SAP_PASSWORD=pw-from-env\n');
		const id = await started(runner);
		const state = await finished(runner, id);

		const result = must(state.tests[0]);
		expect(must(result.steps[0]).title).toBe('Fill "***"');
		expect(result.error?.message).toBe('Expected "***" to be gone');
		expect(state.log).toContain('typed ***');
		const stored = ['state.json', 'meta.json', 'output.log'].map((f) =>
			readFileSync(join(runner.RUNS_DIR, id, f), 'utf8')
		);
		expect([JSON.stringify(state), ...stored].join('\n')).not.toContain('pw-from-env');
	});

	test('a page watching with a view gets small snapshots and the steps on request', async () => {
		const runner = await freshRunner('hang');
		const id = await started(runner);
		await testRunning(runner, id);
		// While the test runs, its steps are part of every snapshot.
		const first = await runner.watchRun(id, {}).next();
		expect(first.value).toMatchObject({ status: 'running', log: [] });

		expect(runner.stopRun(id)).toBe(true);
		const state = await finished(runner, id);
		expect(runner.testSteps(id, 't1')).toEqual(must(state.tests[0]).steps);
		expect(runner.testSteps(id, 'unknown')).toEqual([]);
		expect(runner.testSteps('20260101-000000-none', 't1')).toEqual([]);
	});

	test('a failed sign-in marks the tests that needed it as skipped and is no flow', async () => {
		const runner = await freshRunner('sign-in-failed');
		const state = await finished(runner, await started(runner));

		expect(state.status).toBe('failed');
		expect(state.tests.map((t) => [t.title, t.setup, t.status])).toEqual([
			['sign in to SAP', true, 'failed'],
			['creates an order', undefined, 'skipped']
		]);
		expect(state.stats).toMatchObject({ total: 2, failed: 1, skipped: 1 });
		// Reliability counts flows only.
		expect(runner.stability()).toEqual([]);
	});

	test('a run in which no test ran is an error, not a pass', async () => {
		const runner = await freshRunner('none');
		const state = await finished(runner, await started(runner));
		expect(state.status).toBe('error');
		expect(state.log).toContain('No tests were run.');
	});

	test('only one run at a time; stopping it marks the run and its test as interrupted', async () => {
		const runner = await freshRunner('hang');
		const id = await started(runner);
		expect(runner.activeRunId()).toBe(id);
		expect(await runner.startRun({})).toEqual({ ok: false, error: `Run ${id} is still running.` });
		expect(runner.stopRun('some-other-run')).toBe(false);

		// Stop only once the stand-in has started its test (and so listens for the signal).
		await testRunning(runner, id);
		expect(runner.stopRun(id)).toBe(true);
		const state = await finished(runner, id);

		expect(state.status).toBe('interrupted');
		expect(state.tests[0]).toMatchObject({ status: 'interrupted', running: false });
		expect(state.stats).toMatchObject({ total: 1, passed: 0, failed: 0 });
		expect(runner.stopRun(id)).toBe(false);
		expect(runner.activeRunId()).toBeNull();
	});
});
