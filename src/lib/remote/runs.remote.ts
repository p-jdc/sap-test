import { command, query } from '$app/server';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { recordActivity } from '#lib/server/auth/access.js';
import { activeHealing } from '#lib/server/healer.js';
import { planningBlock } from '#lib/server/healing-run.js';
import {
	activeRunId,
	getLiveState,
	startRun,
	stopRun,
	testSteps,
	watchRun
} from '#lib/server/runner.js';
import { PILOT_STREAK, readRunState, runsPage, stability } from '#lib/server/runs-store.js';

const runId = z.string().regex(/^[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$/);

/** The newest runs (one page), the number of all runs and the run in progress. */
export const getRuns = query(() => ({ ...runsPage(), active: activeRunId() }));

/** The page of runs after the run `before`, for "show older results". */
export const getOlderRuns = query(runId, (before) => runsPage(before).runs);

export const getRun = query(runId, (id) => getLiveState(id) ?? readRunState(id));

/**
 * A running run as a stream of snapshots, each reduced to what the asking page shows: see LiveView.
 * The steps a snapshot leaves out come from getRunTestSteps.
 */
export const watchRunLive = query.live(
	z.object({ id: runId, file: z.string().max(500).optional(), log: z.boolean().optional() }),
	({ id, ...view }) => watchRun(id, view)
);

/**
 * The steps of one test. `retry` is not used on the server: a test that runs again gets new
 * steps under the same id, and the new number makes the page ask again.
 */
export const getRunTestSteps = query(
	z.object({
		id: runId,
		testId: z.string().min(1).max(200),
		retry: z.number().int().min(0).max(100)
	}),
	({ id, testId }) => testSteps(id, testId)
);

export const getStability = query(() => ({ rows: stability(), target: PILOT_STREAK }));

export const startTestRun = command(
	z.object({
		files: z.array(z.string().max(500)).max(200).optional(),
		grep: z.string().max(200).optional(),
		headed: z.boolean().optional()
	}),
	async (input) => {
		// The healer runs the test it repairs itself; a run beside it would share the browser's
		// session and the test results folder.
		const result = await startRun(input, () => {
			const healing = activeHealing();
			return healing
				? `The healer is working on "${healing.title}". Wait or stop it first.`
				: planningBlock();
		});
		if (!result.ok) error(409, result.error);
		await recordActivity(
			'Started a run',
			input.files?.length ? input.files.join(', ').slice(0, 300) : 'all tests'
		);
		await getRuns().refresh();
		return { id: result.id };
	}
);

export const stopTestRun = command(runId, (id) => ({ stopped: stopRun(id) }));
