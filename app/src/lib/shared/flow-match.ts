import type { RunTest, SpecTest } from './types';

const sameCall = (spec: SpecTest, run: RunTest) => spec.file === run.file && spec.line === run.line;

/**
 * Finds the parsed test and its result in a run for a flow key. Keys match directly for tests with
 * a fixed title. A test with a dynamic title (generated in a loop) has a different key in every
 * run result, so it is matched by the file and line of its `test(...)` call instead; of several
 * generated results, the one still running or not passed is shown first.
 */
export function matchFlow(
	specTests: SpecTest[],
	runTests: RunTest[],
	key: string
): { test?: SpecTest; runTest?: RunTest } {
	const byKey = runTests.find((t) => t.key === key);
	const test =
		specTests.find((t) => t.key === key) ??
		(byKey && specTests.find((t) => t.dynamic && sameCall(t, byKey)));
	if (!test) return {};
	if (byKey || !test.dynamic) return { test, runTest: byKey };
	const generated = runTests.filter((r) => sameCall(test, r));
	return {
		test,
		runTest:
			generated.find((r) => r.running) ??
			generated.find((r) => r.status && r.status !== 'passed' && r.status !== 'skipped') ??
			generated[0]
	};
}
