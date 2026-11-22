// Playwright reporter loaded by the Test-App into the sap-tests run (by absolute path).
// It runs inside the Playwright process of sap-tests, which transpiles it: type-only imports and
// no runtime dependencies.
// Every event is one stdout line prefixed with PREFIX; the app parses those and ignores the rest.
import type {
	FullConfig,
	FullResult,
	Location,
	Reporter,
	Suite,
	TestCase,
	TestError,
	TestResult,
	TestStep
} from '@playwright/test/reporter';

const PREFIX = '@@pwlive@@';
const KEEP = new Set(['pw:api', 'expect', 'test.step']);

function emit(type: string, fields: object = {}) {
	process.stdout.write(PREFIX + JSON.stringify({ type, ...fields }) + '\n');
}

function loc(l: Location | undefined) {
	return l ? { file: l.file, line: l.line, column: l.column } : undefined;
}

function err(e: TestError | undefined) {
	return e
		? {
				// JSON, not String(e): a TestError is a plain object and would print as [object Object].
				message: e.message || e.value || JSON.stringify(e),
				stack: e.stack,
				location: loc(e.location)
			}
		: undefined;
}

export default class LiveReporter implements Reporter {
	private stepIds = new WeakMap<TestStep, string>();
	private seq = 0;

	printsToStdio() {
		return false;
	}

	onBegin(config: FullConfig, suite: Suite) {
		emit('begin', {
			rootDir: config.rootDir,
			tests: suite.allTests().map((t) => ({
				id: t.id,
				title: t.title,
				titlePath: t.titlePath().slice(3),
				location: loc(t.location)
			}))
		});
	}

	onTestBegin(test: TestCase, result: TestResult) {
		emit('testBegin', { testId: test.id, retry: result.retry, startTime: result.startTime });
	}

	onStepBegin(test: TestCase, _result: TestResult, step: TestStep) {
		if (!KEEP.has(step.category)) return;
		const id = 's' + ++this.seq;
		this.stepIds.set(step, id);
		let parent = step.parent;
		while (parent && !this.stepIds.has(parent)) parent = parent.parent;
		emit('stepBegin', {
			testId: test.id,
			stepId: id,
			parentId: parent ? this.stepIds.get(parent) : undefined,
			title: step.title,
			category: step.category,
			location: loc(step.location),
			startTime: step.startTime
		});
	}

	onStepEnd(test: TestCase, _result: TestResult, step: TestStep) {
		const id = this.stepIds.get(step);
		if (!id) return;
		emit('stepEnd', {
			testId: test.id,
			stepId: id,
			duration: step.duration,
			error: err(step.error)
		});
	}

	onTestEnd(test: TestCase, result: TestResult) {
		emit('testEnd', {
			testId: test.id,
			status: result.status,
			expectedStatus: test.expectedStatus,
			duration: result.duration,
			retry: result.retry,
			error: err(result.error),
			attachments: result.attachments.flatMap((a) =>
				a.path ? [{ name: a.name, contentType: a.contentType, path: a.path }] : []
			)
		});
	}

	onEnd(result: FullResult) {
		emit('end', { status: result.status, duration: result.duration });
	}
}
