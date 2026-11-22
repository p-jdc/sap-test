import { command, query } from '$app/server';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { recordActivity, requireAdmin } from '#lib/server/auth/access.js';
import {
	activeHealing,
	discardRepair,
	healerProblem,
	healingState,
	startHealing,
	stopHealing
} from '#lib/server/healer.js';

const target = z.object({
	id: z.string().regex(/^[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$/),
	testId: z.string().regex(/^[\w-]{1,200}$/)
});

/** Whether the healer can be started here, and the test it is working on. */
export const getHealer = query(() => ({
	problem: healerProblem() ?? null,
	active: activeHealing()
}));

/** What the healer did or is doing for one test of a run. */
export const getHealing = query(target, ({ id, testId }) => healingState(id, testId));

/**
 * Admins only, with sign-in on: the healer changes test code and runs it with the test users'
 * passwords, and sends what it sees to the AI provider.
 */
export const startHealer = command(target, async ({ id, testId }) => {
	requireAdmin();
	const result = await startHealing(id, testId);
	if (!result.ok) error(409, result.error);
	await recordActivity('Started the healer', `${id} ${testId}`);
	await Promise.all([getHealer().refresh(), getHealing({ id, testId }).refresh()]);
});

export const stopHealer = command(target, ({ id, testId }) => ({
	stopped: stopHealing(id, testId)
}));

export const discardHealerRepair = command(target, async ({ id, testId }) => {
	requireAdmin();
	const result = discardRepair(id, testId);
	if (!result.ok) error(409, result.error);
	await recordActivity('Discarded a repair of the healer', `${id} ${testId}`);
	await getHealing({ id, testId }).refresh();
});
