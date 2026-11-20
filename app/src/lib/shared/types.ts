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

export type StepKind =
	'navigate' | 'login' | 'action' | 'assert' | 'wait' | 'helper' | 'group' | 'other';

export type Severity = 'error' | 'warning' | 'info';

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
	/** Oldest → newest, skipped runs excluded. */
	history: { runId: string; status: TestStatus }[];
	streak: number;
	lastStatus?: TestStatus;
}

export interface EnvStatus {
	testsDir: string;
	envFile: boolean;
	vars: { name: string; set: boolean }[];
	playwrightVersion?: string;
	playwrightSap: boolean;
}
