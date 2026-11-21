export type Surface = 'fiori' | 'webgui' | 'ariba' | 'api' | 'demo' | 'other';

export type LocatorKind =
	| 'ui5'
	| 'ui5-xpath'
	| 'sid'
	| 'sid-path'
	| 'role'
	| 'label'
	| 'text'
	| 'testid'
	| 'placeholder'
	| 'css'
	| 'xpath'
	| 'other';

type StepKind = 'navigate' | 'login' | 'action' | 'assert' | 'wait' | 'helper' | 'group' | 'other';

type Severity = 'error' | 'warning' | 'info';

export interface Issue {
	rule: string;
	severity: Severity;
	message: string;
	line: number;
}

export interface LocatorInfo {
	kind: LocatorKind;
	/** Locator call as readable text, e.g. `getByRoleUI5('Button', { text: 'Save' })` or `button('Save')`. */
	display: string;
	/** Set when the locator comes from a helpers/ function. */
	helper?: string;
}

export interface FlowStep {
	id: string;
	line: number;
	endLine: number;
	kind: StepKind;
	/** click, fill, toBeVisible, goto, SAPLogin, runTransaction … */
	action: string;
	locator?: LocatorInfo;
	value?: string;
	code: string;
	/** `beforeEach` steps are shared by every test in their scope. */
	hook?: boolean;
	issues: Issue[];
}

export interface SpecTest {
	/** Stable key across runs: `<file>::<title path>` */
	key: string;
	file: string;
	title: string;
	titlePath: string[];
	line: number;
	surface: Surface;
	steps: FlowStep[];
	issues: Issue[];
	/**
	 * The title is computed when the test runs (a loop or a template the parser cannot resolve), so
	 * `key` does not match a run's key; such a test is matched to runs by file and line.
	 */
	dynamic?: boolean;
}

export interface SpecFile {
	file: string;
	surface: Surface;
	tests: SpecTest[];
	issues: Issue[];
	parseError?: string;
}

export type TestStatus = 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
export type StepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

export interface Attachment {
	name: string;
	contentType: string;
	/** Path relative to the run directory, served from /runs/<id>/files/<path>. */
	path: string;
}

export interface RunStep {
	stepId: string;
	parentId?: string;
	title: string;
	category: string;
	line?: number;
	/** Spec-relative file of the step's location, if inside sap-tests. */
	file?: string;
	startTime: string;
	duration?: number;
	error?: string;
}

export interface RunTest {
	testId: string;
	key: string;
	file: string;
	title: string;
	line: number;
	status?: TestStatus;
	running?: boolean;
	duration?: number;
	retry?: number;
	/** A `test.fail()` test that failed as declared; its status is `passed`. */
	expectedFailure?: boolean;
	/**
	 * A sign-in from sap-tests/setup that saves the session the tests start with. Playwright runs
	 * it as a test, but it is no flow of a spec file.
	 */
	setup?: boolean;
	error?: { message: string; line?: number; file?: string };
	steps: RunStep[];
	/**
	 * Set in a live snapshot for a test whose steps were left out to keep the snapshot small
	 * (LiveView); `steps` is then empty although the test has steps.
	 */
	stepsOmitted?: boolean;
	/** The steps and the error message of this test were deleted to save space (retention rules). */
	detailsRemoved?: boolean;
	attachments: Attachment[];
}

/**
 * What a page watching a running run needs besides the test list. A snapshot goes out to every
 * open page several times a second, so it carries the steps of the tests that are running and of
 * the tests in `file`, and the log only when asked for.
 */
export interface LiveView {
	/** Spec file whose tests keep their steps after they finished (the flow page shows one of them). */
	file?: string;
	log?: boolean;
}

export type RunStatus = 'running' | 'passed' | 'failed' | 'interrupted' | 'error';

export interface RunMeta {
	id: string;
	startedAt: string;
	finishedAt?: string;
	status: RunStatus;
	files: string[];
	grep?: string;
	stats: { total: number; passed: number; failed: number; skipped: number };
	exitCode?: number | null;
}

export interface RunState extends RunMeta {
	tests: RunTest[];
	log: string[];
	hasReport: boolean;
	/** The report, screenshots, videos and traces of this run were deleted to save space. */
	artifactsRemoved?: boolean;
}

export interface StabilityRow {
	key: string;
	file: string;
	title: string;
	/** Oldest → newest; runs where the test was skipped or interrupted are excluded. */
	history: { runId: string; status: TestStatus }[];
	streak: number;
	lastStatus?: TestStatus;
}

/**
 * The settings of the test project: SAP and Ariba access, the system the OData tests call, and an
 * optional browser path.
 */
export const SETTING_NAMES = [
	'SAP_URL',
	'SAP_USERNAME',
	'SAP_PASSWORD',
	'ARIBA_URL',
	'ARIBA_USER',
	'ARIBA_PASS',
	'SAP_API_URL',
	'SAP_API_USERNAME',
	'SAP_API_PASSWORD',
	'SAP_CLIENT',
	'CHROMIUM_PATH'
] as const;
export type SettingName = (typeof SETTING_NAMES)[number];

/** Stored exactly as typed and never trimmed. */
export const SECRET_SETTINGS: readonly SettingName[] = [
	'SAP_PASSWORD',
	'ARIBA_PASS',
	'SAP_API_PASSWORD'
];

/** Where a setting's value comes from: the system credential store, sap-tests/.env, or the app's environment. */
export type SettingSource = 'keychain' | 'file' | 'process';

export interface EnvStatus {
	testsDir: string;
	envFile: boolean;
	/** Whether the system credential store can be used on this machine. */
	keychain: boolean;
	/**
	 * `withheld`: a credential set in .env or the environment that is not used, because the URL
	 * saved in the app points at another host than the URL set there.
	 */
	vars: { name: SettingName; set: boolean; source?: SettingSource; withheld?: SettingSource }[];
	/** Stock Playwright in sap-tests, which runs the tests. */
	playwrightVersion?: string;
	/** Whether sap-tests/sap-plugin (the SAP locators for stock Playwright) is there. */
	sapPlugin: boolean;
	/** The Playwright-SAP fork in sap-tests/recorder, used for recording only. */
	recorderVersion?: string;
	/** The Node that runs Playwright; `warning` is set when it is not the supported major. */
	node: { path: string; version: string | null; warning: string | null };
}
