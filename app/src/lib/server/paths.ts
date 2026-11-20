import { resolve } from 'node:path';

/** The Playwright-SAP project this app drives. Override with SAP_TESTS_DIR. */
export const TESTS_ROOT = resolve(
	process.env.SAP_TESTS_DIR || resolve(process.cwd(), '../sap-tests')
);
export const TESTS_DIR = resolve(TESTS_ROOT, 'tests');
export const HELPERS_DIR = resolve(TESTS_ROOT, 'helpers');

/** Run history, reports and artifacts. Override with TEST_APP_DATA_DIR. */
export const DATA_DIR = resolve(process.env.TEST_APP_DATA_DIR || resolve(process.cwd(), '.data'));
export const RUNS_DIR = resolve(DATA_DIR, 'runs');

export const LIVE_REPORTER = resolve(process.cwd(), 'reporter/live-reporter.cjs');

/** Resolves `rel` under `root`, or null when it would escape it (path traversal). */
export function within(root: string, rel: string): string | null {
	const full = resolve(root, rel);
	return full === root || full.startsWith(root + '/') ? full : null;
}
