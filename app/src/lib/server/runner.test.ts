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
if (mode === 'pass' || mode === 'hang') {
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
async function freshRunner(run: 'pass' | 'hang' | 'none', installed = true) {
	// The real path: the stand-in reports files under its working directory, and on macOS the
	// temporary folder is reached through a link.
	testsRoot = realpathSync(mkdtempSync(join(tmpdir(), 'runner-tests-')));
	if (installed) {
		const pkg = join(testsRoot, 'node_modules/@playwright/test');
		mkdirSync(pkg, { recursive: true });
		writeFileSync(join(pkg, 'cli.js'), FAKE_CLI);
	}
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
