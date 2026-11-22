// Used by line-numbers.spec.ts: prints the line Playwright gives each test and each step of the
// spec, the numbers the app's flow view and `file:line` runs rely on.
export default class StepLinesReporter {
	onTestBegin(test) {
		console.log(`test ${test.location.line}`);
	}

	onStepEnd(_test, _result, step) {
		if (step.location && (step.category === 'pw:api' || step.category === 'expect'))
			console.log(`step ${step.location.line} ${step.title}`);
	}
}
