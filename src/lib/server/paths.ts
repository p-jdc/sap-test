import nodePath, { resolve } from 'node:path';

/** The SAP test project (stock Playwright with sap-plugin) this app drives. Override with SAP_TESTS_DIR. */
export const TESTS_ROOT = resolve(process.env.SAP_TESTS_DIR || resolve(process.cwd(), 'sap-tests'));
/** The project's one install, which sap-tests shares with this app: next to the test project. */
export const PACKAGES_DIR = resolve(TESTS_ROOT, '..', 'node_modules');
export const TESTS_DIR = resolve(TESTS_ROOT, 'tests');
export const HELPERS_DIR = resolve(TESTS_ROOT, 'helpers');
/** The sign-in setup projects (sap-tests/setup/*.setup.ts), which run before the tests that need them. */
export const SETUP_DIR = resolve(TESTS_ROOT, 'setup');

/** Run history, reports and artifacts. Override with TEST_APP_DATA_DIR. */
export const DATA_DIR = resolve(process.env.TEST_APP_DATA_DIR || resolve(process.cwd(), '.data'));
export const RUNS_DIR = resolve(DATA_DIR, 'runs');

export const LIVE_REPORTER = resolve(process.cwd(), 'reporter/live-reporter.ts');

type PathApi = Pick<typeof nodePath, 'resolve' | 'relative' | 'isAbsolute' | 'sep'>;

/**
 * Resolves `rel` under `root`, or null when it would escape it (path traversal). `path` is the
 * platform's path module; tests pass the Windows one.
 */
export function within(root: string, rel: string, path: PathApi = nodePath): string | null {
	const full = path.resolve(root, rel);
	const inside = path.relative(root, full);
	// On Windows a path on another drive has no relative form and comes back absolute.
	const escapes = inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside);
	return escapes ? null : full;
}

/**
 * A relative path with `/` on every platform. Spec files, test keys and artifact paths are kept
 * this way: they are compared with each other, split by folder and used in URLs.
 */
export function toPosix(path: string, separator: string = nodePath.sep): string {
	return separator === '/' ? path : path.replaceAll(separator, '/');
}
