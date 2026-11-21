import { authMode } from '#lib/server/auth/policy.js';
import type { RequestHandler } from './$types';

/**
 * What the sign-in page shows: whether sign-in is on, whether the first admin is still missing,
 * whether a setup or recovery link is valid (24 random bytes: not guessable), and the name an
 * invite link was made for. Public, so it says no more than that.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (authMode() === 'off') return Response.json({ on: false });
	const { signIn } = await import('#lib/server/auth/auth.js');
	const { store, setupValid } = await signIn();
	const invite = url.searchParams.get('invite');
	const setup = url.searchParams.get('setup');
	const recover = url.searchParams.get('recover');
	return Response.json({
		on: true,
		signedIn: !!locals.user,
		needsSetup: store.userCount() === 0,
		setup: setup ? setupValid(setup) : false,
		recover: recover ? store.recoveryValid(recover) : false,
		invite: invite ? (store.invite(invite)?.name ?? null) : null
	});
};
