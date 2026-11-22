/**
 * What a test drives, as far as the rule check needs it: SAP's UI technologies, OData services,
 * the demo tests, anything else. Which system a test signs in to is `SpecFile.system`.
 */
export type Surface = 'fiori' | 'webgui' | 'api' | 'demo' | 'other';

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
	/** The id of the system in sap-tests/systems.json whose sign-in its tests start with. */
	system?: string;
	/** That system's title. */
	systemTitle?: string;
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

/** How many of a test's latest results the reliability table shows and the server sends. */
export const HISTORY_SHOWN = 15;

/** How many runs the run list loads at a time. */
export const RUNS_PER_PAGE = 100;

export interface StabilityRow {
	key: string;
	file: string;
	title: string;
	/**
	 * The latest HISTORY_SHOWN results, oldest → newest; runs where the test was skipped or
	 * interrupted are excluded. `streak` counts over the whole history.
	 */
	history: { runId: string; status: TestStatus }[];
	streak: number;
	lastStatus?: TestStatus;
}

/**
 * The name of a setting of the test project, an environment variable: the address, user and
 * password of each system in sap-tests/systems.json, the system the OData tests call, and an
 * optional browser path. The server knows the list (lib/server/systems.ts).
 */
export type SettingName = string;

/** A system the tests sign in to, as sap-tests/systems.json describes it. */
export interface SignInSystemInfo {
	id: string;
	title: string;
	description?: string;
	/** Not needed to get started: the Home page shows it as optional. */
	optional?: boolean;
	method: 'sapLogin' | 'ias' | 'form';
	/** The settings that hold its address, user and password. */
	env: { url: SettingName; user: SettingName; password: SettingName };
	/** The folders a recording for this system can be saved in, each with its recorder. */
	record: RecordTarget[];
}

/**
 * How a test is recorded: `ui5` with the UI5 recorder of sap-plugin (Fiori), `webgui` with the
 * Playwright-SAP recorder signed in to SAP, `web` with stock Playwright's codegen where the person
 * signs in.
 */
export type Recorder = 'ui5' | 'webgui' | 'web';

export interface RecordTarget {
	/** Under sap-tests/tests. */
	folder: string;
	recorder: Recorder;
	/** `ui5` only: where a recording without sign-in goes (a folder the system excludes). */
	noLoginFolder?: string;
}

/** Where a setting's value comes from: the system credential store, sap-tests/.env, or the app's environment. */
export type SettingSource = 'keychain' | 'file' | 'process';

export interface EnvStatus {
	testsDir: string;
	envFile: boolean;
	/** Whether the system credential store can be used on this machine. */
	keychain: boolean;
	/**
	 * `withheld`: a credential that is set but not used, because its system's URL now points at
	 * another host: one from .env or the environment when the URL saved in the app differs from the
	 * URL set there, one saved in the app (`keychain`) when the URL changed outside the app.
	 */
	vars: { name: SettingName; set: boolean; source?: SettingSource; withheld?: SettingSource }[];
	/** The systems of sap-tests/systems.json, in its order. */
	systems: SignInSystemInfo[];
	/** What is wrong with sap-tests/systems.json; `systems` is then empty. */
	systemsError?: string;
	/** Stock Playwright in sap-tests, which runs the tests. */
	playwrightVersion?: string;
	/** Whether sap-tests/sap-plugin (the SAP locators for stock Playwright) is there. */
	sapPlugin: boolean;
	/** The Playwright-SAP fork in sap-tests/recorder, used to record WebGUI only. */
	recorderVersion?: string;
	/** The Node that runs Playwright; `warning` is set when it is not the supported major. */
	node: { path: string; version: string | null; warning: string | null };
}
