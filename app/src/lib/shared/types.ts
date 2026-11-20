export type Surface = 'fiori' | 'webgui' | 'ariba' | 'demo' | 'other';

export type LocatorKind =
	| 'ui5'
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
	error?: { message: string; line?: number; file?: string };
	steps: RunStep[];
	attachments: Attachment[];
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

/** The settings of the test project: SAP and Ariba access, and an optional browser path. */
export const SETTING_NAMES = [
	'SAP_URL',
	'SAP_USERNAME',
	'SAP_PASSWORD',
	'ARIBA_URL',
	'ARIBA_USER',
	'ARIBA_PASS',
	'CHROMIUM_PATH'
] as const;
export type SettingName = (typeof SETTING_NAMES)[number];

/** Where a setting's value comes from: the system credential store, sap-tests/.env, or the app's environment. */
export type SettingSource = 'keychain' | 'file' | 'process';

export interface EnvStatus {
	testsDir: string;
	envFile: boolean;
	/** Whether the system credential store can be used on this machine. */
	keychain: boolean;
	vars: { name: SettingName; set: boolean; source?: SettingSource }[];
	playwrightVersion?: string;
	playwrightSap: boolean;
}
