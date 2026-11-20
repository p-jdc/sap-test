import { command, query } from '$app/server';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { activeRunId, getLiveState, startRun, stopRun, watchRun } from '#lib/server/runner.js';
import { listRuns, PILOT_STREAK, readRunState, stability } from '#lib/server/runs-store.js';

const runId = z.string().regex(/^[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$/);

export const getRuns = query(() => ({ runs: listRuns(), active: activeRunId() }));

export const getRun = query(runId, (id) => getLiveState(id) ?? readRunState(id));

export const watchRunLive = query.live(runId, (id) => watchRun(id));

export const getStability = query(() => ({ rows: stability(), target: PILOT_STREAK }));

export const startTestRun = command(
	z.object({
		files: z.array(z.string().max(500)).max(200).optional(),
		grep: z.string().max(200).optional()
	}),
	async (input) => {
		const result = await startRun(input);
		if (!result.ok) error(409, result.error);
		await getRuns().refresh();
		return { id: result.id };
	}
);

export const stopTestRun = command(runId, (id) => ({ stopped: stopRun(id) }));
