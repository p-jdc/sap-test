import { relative } from 'node:path';
import { TESTS_DIR, toPosix } from './paths.js';
import type { Attachment, RunState, RunTest, TestStatus } from '#lib/shared/types.js';

/** Marks a reporter event line in the Playwright process's stdout. */
export const PREFIX = '@@pwlive@@';

// Strips terminal colour codes from Playwright output; matching ESC is the point.
// oxlint-disable-next-line no-control-regex
export const ANSI = /\u001B\[[0-9;?]*[A-Za-z]/g;

function specRel(file: string | undefined): string | undefined {
	if (!file) return undefined;
	const rel = relative(TESTS_DIR, file);
	return rel.startsWith('..') ? undefined : toPosix(rel);
}

type Loc = { file: string; line: number; column: number };
type ReporterError = { message: string; stack?: string; location?: Loc };

/** Line protocol of reporter/live-reporter.ts (one JSON object per `@@pwlive@@` line). */
export type ReporterEvent =
	| {
			type: 'begin';
			rootDir: string;
			tests: { id: string; title: string; titlePath: string[]; location?: Loc }[];
	  }
	| { type: 'testBegin'; testId: string; retry: number; startTime: string }
	| {
			type: 'stepBegin';
			testId: string;
			stepId: string;
			parentId?: string;
			title: string;
			category: string;
			location?: Loc;
			startTime: string;
	  }
	| { type: 'stepEnd'; testId: string; stepId: string; duration: number; error?: ReporterError }
	| {
			type: 'testEnd';
			testId: string;
			status: TestStatus;
			expectedStatus: TestStatus;
			duration: number;
			retry: number;
			error?: ReporterError;
			attachments: Attachment[];
	  }
	| { type: 'end'; status: string; duration: number };

/** Applies one reporter event to the run state. `dir` is the run directory attachments live in. */
export function applyEvent(state: RunState, dir: string, ev: ReporterEvent) {
	const test = (id: string) => state.tests.find((t) => t.testId === id);
	switch (ev.type) {
		case 'begin':
			state.tests = ev.tests.map((t): RunTest => {
				const file = specRel(t.location?.file) ?? '';
				return {
					testId: t.id,
					key: `${file}::${t.titlePath.join(' › ')}`,
					file,
					title: t.title,
					line: t.location?.line ?? 0,
					steps: [],
					attachments: []
				};
			});
			break;
		case 'testBegin': {
			const t = test(ev.testId);
			if (t)
				Object.assign(t, {
					running: true,
					retry: ev.retry,
					steps: [],
					status: undefined,
					error: undefined,
					expectedFailure: undefined
				});
			break;
		}
		case 'stepBegin': {
			const t = test(ev.testId);
			t?.steps.push({
				stepId: ev.stepId,
				parentId: ev.parentId,
				title: ev.title,
				category: ev.category,
				file: specRel(ev.location?.file),
				line: ev.location?.line,
				startTime: ev.startTime
			});
			break;
		}
		case 'stepEnd': {
			const s = test(ev.testId)?.steps.find((x) => x.stepId === ev.stepId);
			if (s)
				Object.assign(s, { duration: ev.duration, error: ev.error?.message.replaceAll(ANSI, '') });
			break;
		}
		case 'testEnd': {
			const t = test(ev.testId);
			if (!t) break;
			t.running = false;
			t.duration = ev.duration;
			t.error = ev.error
				? {
						message: ev.error.message.replaceAll(ANSI, ''),
						line: ev.error.location?.line,
						file: specRel(ev.error.location?.file)
					}
				: undefined;
			// A `test.fail()` test is fine when it fails and wrong when it passes, like Playwright counts it.
			if (ev.expectedStatus === 'failed' && ev.status === 'failed') {
				t.status = 'passed';
				t.expectedFailure = true;
			} else if (ev.expectedStatus === 'failed' && ev.status === 'passed') {
				t.status = 'failed';
				t.error ??= { message: 'Expected to fail (test.fail), but passed.' };
			} else {
				t.status = ev.status;
			}
			t.attachments = ev.attachments.flatMap((a) => {
				const rel = relative(dir, a.path);
				return rel.startsWith('..') ? [] : [{ ...a, path: toPosix(rel) }];
			});
			break;
		}
		case 'end':
			state.status =
				ev.status === 'passed' ? 'passed' : ev.status === 'interrupted' ? 'interrupted' : 'failed';
			break;
	}
	recount(state);
}

export function recount(state: RunState) {
	const s = { total: state.tests.length, passed: 0, failed: 0, skipped: 0 };
	for (const t of state.tests) {
		if (t.status === 'passed') s.passed++;
		else if (t.status === 'skipped') s.skipped++;
		else if (t.status && t.status !== 'interrupted') s.failed++;
	}
	state.stats = s;
}
