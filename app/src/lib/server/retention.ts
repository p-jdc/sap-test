import type { TestStatus } from '#lib/shared/types.js';

/**
 * How long the parts of a run are kept. What happened (which test passed or failed, when, how long
 * it took) is kept for good: it is small and it is the evidence for the pilot criterion. The rest
 * goes by outcome and by what came after:
 *
 * - The newest run is kept in full, whatever its age.
 * - Report, screenshots, videos and traces stay for `reportDays`.
 * - Steps and the log stay for `stepsDays`.
 * - A failure stays in full while the test has not passed again, then for `reportDays` more, and
 *   never longer than `failureDays`: these files show SAP data.
 * - Of a series of failures at the same place, only the first and the latest stay in full.
 */
export type Retention = { reportDays: number; stepsDays: number; failureDays: number };

export const DEFAULT_RETENTION: Retention = { reportDays: 14, stepsDays: 30, failureDays: 90 };

function days(value: string | undefined, fallback: number): number {
	const n = Number(value);
	return value !== undefined && value !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * The rules from the environment, or null when nothing may be deleted: `TEST_APP_RETENTION=off`,
 * or `TEST_APP_KEEP_ARTIFACTS=all` from the count-based rule these rules replaced.
 */
export function retentionFromEnv(env: NodeJS.ProcessEnv = process.env): Retention | null {
	if (env.TEST_APP_RETENTION === 'off' || env.TEST_APP_KEEP_ARTIFACTS === 'all') return null;
	return {
		reportDays: days(env.TEST_APP_KEEP_REPORT_DAYS, DEFAULT_RETENTION.reportDays),
		stepsDays: days(env.TEST_APP_KEEP_STEPS_DAYS, DEFAULT_RETENTION.stepsDays),
		failureDays: days(env.TEST_APP_KEEP_FAILURE_DAYS, DEFAULT_RETENTION.failureDays)
	};
}

/** One test of one run, as far as the rules need it. */
type RetentionTest = {
	key: string;
	status?: TestStatus;
	/** Where it failed (`file:line`), to tell a repeated failure from a new one. */
	failedAt?: string;
};

export type RetentionRun = { id: string; startedAt: string; tests: RetentionTest[] };

export type Decision = {
	/** Keep the report, screenshots, videos and traces. */
	artifacts: boolean;
	/** Keep the log. */
	log: boolean;
	/** Keep steps and error messages: of every test, or of the tests with these keys only. */
	details: 'all' | Set<string>;
};

const DAY = 24 * 60 * 60 * 1000;

/** A skipped or interrupted test says nothing about the flow, like in the reliability table. */
function outcome(status: TestStatus | undefined): 'passed' | 'failed' | null {
	if (!status || status === 'skipped' || status === 'interrupted') return null;
	return status === 'passed' ? 'passed' : 'failed';
}

type Entry = { run: string; time: number; failed: boolean; failedAt: string };

/** The failures that are still evidence someone needs, as `<run id>\n<test key>`. */
function neededFailures(runs: RetentionRun[], now: number, policy: Retention): Set<string> {
	const histories = new Map<string, Entry[]>();
	for (const run of runs) {
		const time = Date.parse(run.startedAt);
		for (const t of run.tests) {
			const result = outcome(t.status);
			if (!result) continue;
			const history = histories.get(t.key) ?? [];
			history.push({ run: run.id, time, failed: result === 'failed', failedAt: t.failedAt ?? '' });
			histories.set(t.key, history);
		}
	}
	const needed = new Set<string>();
	for (const [key, history] of histories) {
		history.forEach((entry, i) => {
			if (!entry.failed || now - entry.time > policy.failureDays * DAY) return;
			const fixed = history.slice(i + 1).find((later) => !later.failed);
			if (fixed && now - fixed.time > policy.reportDays * DAY) return;
			// In the middle of a series: the same failure directly before and directly after.
			const same = (other: Entry | undefined) =>
				other?.failed === true && other.failedAt === entry.failedAt;
			if (same(history[i - 1]) && same(history[i + 1])) return;
			needed.add(`${entry.run}\n${key}`);
		});
	}
	return needed;
}

/**
 * What to keep of each finished run. `runs` are in the order they ran, oldest first. Decisions
 * only ever get stricter as time passes and runs are added, apart from one case that cannot be
 * undone anyway: a failure in the middle of a series stays trimmed when the series ends.
 */
export function decide(
	runs: RetentionRun[],
	now: number,
	policy: Retention = DEFAULT_RETENTION
): Map<string, Decision> {
	const needed = neededFailures(runs, now, policy);
	const newest = runs.at(-1)?.id;
	return new Map(
		runs.map((run) => {
			if (run.id === newest) return [run.id, { artifacts: true, log: true, details: 'all' }];
			const age = now - Date.parse(run.startedAt);
			const failures = new Set(
				run.tests.filter((t) => needed.has(`${run.id}\n${t.key}`)).map((t) => t.key)
			);
			const recent = age <= policy.stepsDays * DAY;
			return [
				run.id,
				{
					artifacts: failures.size > 0 || age <= policy.reportDays * DAY,
					log: failures.size > 0 || recent,
					details: recent ? 'all' : failures
				}
			];
		})
	);
}
