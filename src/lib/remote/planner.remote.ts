import { command, query } from '$app/server';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { recordActivity, requireAdmin } from '#lib/server/auth/access.js';
import {
	activePlanning,
	listPlannings,
	planText,
	plannerOn,
	plannerProblem,
	planningState,
	startPlanning,
	stopPlanning
} from '#lib/server/planner.js';

const sessionId = z.string().regex(/^[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$/);

/** Whether the planner can be started here, the session it is working on, and the earlier ones. */
export const getPlanner = query(() => ({
	on: plannerOn(),
	problem: plannerProblem() ?? null,
	active: activePlanning()?.id ?? null,
	sessions: listPlannings()
}));

/** What the planner did or is doing in one session, with the plan it saved. */
export const getPlanning = query(sessionId, (id) => {
	const state = planningState(id);
	return state && { state, plan: planText(id) };
});

/**
 * Admins only, with sign-in on: the planner clicks through the application with a test user's
 * rights and sends what it sees to the AI provider.
 */
export const startPlanner = command(
	z.object({
		system: z.string().max(100).optional(),
		address: z.string().max(2000).optional(),
		flow: z.string().min(1).max(4000)
	}),
	async (input) => {
		requireAdmin();
		const result = await startPlanning(input);
		if (!result.ok) error(409, result.error);
		// The description with passwords masked, as the session keeps it.
		await recordActivity('Started the planner', result.flow.slice(0, 300));
		await getPlanner().refresh();
		return { id: result.id };
	}
);

export const stopPlanner = command(sessionId, async (id) => {
	requireAdmin();
	const stopped = stopPlanning(id);
	if (stopped) await recordActivity('Stopped the planner', id);
	return { stopped };
});
