import { command, query } from '$app/server';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { recordActivity, requireAdmin } from '#lib/server/auth/access.js';
import {
	activeHealing,
	discardRepair,
	healerOn,
	healerProblem,
	healingState,
	repairToRun,
	runBlocker,
	startHealing,
	stopHealing
} from '#lib/server/healer.js';
import { reviewBlock, settleRepair } from '#lib/server/healer-review.js';
import { startRun } from '#lib/server/runner.js';
import { getRuns } from './runs.remote.js';

const target = z.object({
	id: z.string().regex(/^[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$/),
	testId: z.string().regex(/^[\w-]{1,200}$/)
});

/**
 * Whether the healer can be started here, the test it is working on, and why nothing may run
 * while a repair has not been read.
 */
export const getHealer = query(() => ({
	on: healerOn(),
	problem: healerProblem() ?? null,
	active: activeHealing(),
	unread: reviewBlock() ?? null
}));

/** What the healer did or is doing for one test of a run. */
export const getHealing = query(target, ({ id, testId }) => healingState(id, testId));

/**
 * Admins only, with sign-in on: the healer runs the test with the test users' passwords, changes
 * test code, and sends what it sees to the AI provider.
 */
export const startHealer = command(target, async ({ id, testId }) => {
	requireAdmin();
	const result = await startHealing(id, testId);
	if (!result.ok) error(409, result.error);
	await recordActivity('Started the healer', `${id} ${testId}`);
	await Promise.all([getHealer().refresh(), getHealing({ id, testId }).refresh()]);
});

export const stopHealer = command(target, async ({ id, testId }) => {
	requireAdmin();
	const stopped = stopHealing(id, testId);
	if (stopped) await recordActivity('Stopped the healer', `${id} ${testId}`);
	return { stopped };
});

/**
 * A person has read the repair: it counts as their review, and the repaired test runs like any
 * run. Until then the app runs no test code (healer-review.ts).
 */
export const runRepairedTest = command(target, async ({ id, testId }) => {
	requireAdmin();
	const repair = repairToRun(id, testId);
	if (!repair.ok) error(409, repair.error);
	const result = await startRun(
		{ files: [repair.file], grep: repair.title.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&') },
		() => runBlocker({ runId: id, testId })
	);
	// Only a run that starts settles the review: a refused one leaves the repair unread.
	if (!result.ok) error(409, result.error);
	settleRepair(id, testId);
	await recordActivity('Read and ran a repair of the healer', `${id} ${testId}`);
	await getHealing({ id, testId }).refresh();
	// As startTestRun does: the run page watches the run live once the list names it as running.
	await Promise.all([getRuns().refresh(), getHealer().refresh()]);
	return { id: result.id };
});

export const discardHealerRepair = command(target, async ({ id, testId }) => {
	requireAdmin();
	const result = discardRepair(id, testId);
	if (!result.ok) error(409, result.error);
	await recordActivity('Discarded a repair of the healer', `${id} ${testId}`);
	await getHealing({ id, testId }).refresh();
});
