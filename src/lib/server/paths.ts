import { existsSync, readdirSync } from 'node:fs';
import nodePath, { isAbsolute, resolve } from 'node:path';

/** The repository root. The app runs from here (`bun run dev`, `bun run start`). */
const APP_ROOT = process.cwd();

/** The SAP test project (stock Playwright with sap-plugin) this app drives. Override with SAP_TESTS_DIR. */
export const TESTS_ROOT = resolve(process.env.SAP_TESTS_DIR || resolve(APP_ROOT, 'sap-tests'));

/** A test project inside this repository shares its install; one elsewhere brings its own. */
const TESTS_SHARE_INSTALL = within(APP_ROOT, TESTS_ROOT) !== null;

/**
 * The install the test project's code resolves its packages from: the Playwright the runs start,
 * the recorders and the packages of the Mock PLC and the IDoc receiver. For the test project in
 * this repository that is the repository's one install; for one elsewhere (SAP_TESTS_DIR), its own
 * node_modules, as Node would find it from its files. TEST_APP_PACKAGES_DIR overrides it for the
 * app's own tests, which run stand-ins. The recorders are told this folder, so what the app checks
 * is what runs.
 */
export const PACKAGES_DIR = resolve(
	process.env.TEST_APP_PACKAGES_DIR ||
		(TESTS_SHARE_INSTALL ? resolve(APP_ROOT, 'node_modules') : resolve(TESTS_ROOT, 'node_modules'))
);
export const TESTS_DIR = resolve(TESTS_ROOT, 'tests');
export const HELPERS_DIR = resolve(TESTS_ROOT, 'helpers');
/** The sign-in setup projects (sap-tests/setup/*.setup.ts), which run before the tests that need them. */
export const SETUP_DIR = resolve(TESTS_ROOT, 'setup');

/** Run history, reports and artifacts. Override with TEST_APP_DATA_DIR. */
export const DATA_DIR = resolve(process.env.TEST_APP_DATA_DIR || resolve(process.cwd(), '.data'));
export const RUNS_DIR = resolve(DATA_DIR, 'runs');

export const LIVE_REPORTER = resolve(process.cwd(), 'reporter/live-reporter.ts');

/** Settings files Bun loads from the working directory; the two templates are checked in. */
export const SETTINGS_FILE = /^\.env(?:\.(?!example$|test$)[\w.-]+)?$/;

/** The settings files in the app's old folder, which Bun loaded while the app ran from there. */
function oldSettingsFiles(): string[] {
	const old = resolve(APP_ROOT, 'app');
	if (!existsSync(old)) return [];
	return readdirSync(old)
		.filter((name) => SETTINGS_FILE.test(name))
		.map((name) => resolve(old, name));
}

/**
 * Left over from before the app moved to the root: data or settings the app would not find (it
 * would start with an empty database, or without its settings), or an old install of the test
 * project that would load a second copy of Playwright. `bun run setup` moves or deletes them.
 * Also a relative TEST_APP_DATA_DIR or SAP_TESTS_DIR that was meant for app/: relative paths are
 * taken from the repository root now. Undefined when there is nothing.
 */
export function oldLayoutProblem(): string | undefined {
	const dataDir = process.env.TEST_APP_DATA_DIR;
	const oldData = dataDir ? (isAbsolute(dataDir) ? undefined : `app/${dataDir}`) : 'app/.data';
	const leftovers = [
		...(oldData ? [resolve(APP_ROOT, oldData)] : []),
		...oldSettingsFiles(),
		...(TESTS_SHARE_INSTALL
			? [resolve(TESTS_ROOT, 'node_modules'), resolve(TESTS_ROOT, 'recorder/node_modules')]
			: [])
	].filter((path) => existsSync(path));
	const problems = [];
	if (leftovers.length > 0)
		problems.push(
			`Left over from before the app moved to the repository root: ${leftovers.join(', ')}. Run "bun run setup" in the repository root, which moves the data and settings and deletes the old installs. A relative TEST_APP_DATA_DIR is now taken from the repository root: move the folder there or change the setting.`
		);
	if (process.env.SAP_TESTS_DIR && !existsSync(TESTS_ROOT))
		problems.push(
			`SAP_TESTS_DIR points to ${TESTS_ROOT}, which does not exist. Relative paths are taken from the repository root since the app moved there.`
		);
	return problems.length > 0 ? problems.join(' ') : undefined;
}

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
