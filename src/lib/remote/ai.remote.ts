import { command, query } from '$app/server';
import { recordActivity, requireAdmin } from '#lib/server/auth/access.js';
import { checkAi } from '#lib/server/ai/check.js';
import { aiStatus } from '#lib/server/ai/settings.js';

/** Which provider the app uses and what it still needs. Names only, never a value. */
export const getAiStatus = query(() => aiStatus());

/** One short request to the provider. Admins only: every call is billed. */
export const checkAiConnection = command(async () => {
	requireAdmin();
	const result = await checkAi();
	await recordActivity('Checked the AI connection', result.ok ? 'answered' : 'failed');
	return result;
});
