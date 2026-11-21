import { error } from '@sveltejs/kit';
import { getRequestEvent } from '$app/server';
import { authMode } from './policy.js';

/**
 * Who is asking, for remote functions. With sign-in off the app is reached from this computer
 * only (policy.ts), and its one user may do everything.
 */
export function currentUser(): App.Locals['user'] | undefined {
	return getRequestEvent().locals.user;
}

/** Stops a request from anyone but an admin, when sign-in is on. */
export function requireAdmin() {
	if (authMode() === 'off') return;
	if (currentUser()?.role !== 'admin') error(403, 'Only an admin can do this.');
}

/** Notes an action in the activity log (Settings), with sign-in on. Never pass a secret value. */
export async function recordActivity(action: string, detail?: string) {
	if (authMode() === 'off') return;
	const { signIn } = await import('./auth.js');
	(await signIn()).store.record(currentUser() ?? null, action, detail);
}
