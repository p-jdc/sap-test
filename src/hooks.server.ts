import type { Handle, ServerInit } from '@sveltejs/kit/hooks';
import { building } from '$app/env';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import {
	authMode,
	exposureProblem,
	isPublicPath,
	signedOutResponse
} from '#lib/server/auth/policy.js';
import { configuredHosts, hostAllowed } from '#lib/server/host-check.js';
import { oldLayoutProblem } from '#lib/server/paths.js';
import { applyRetention } from '#lib/server/runs-store.js';

const allowed = configuredHosts();
const mode = authMode();

/** Loaded only with sign-in on: it needs Bun's SQLite, which the Node unit tests do not have. */
const signIn = () => import('#lib/server/auth/auth.js').then((m) => m.signIn());

const DAY = 24 * 60 * 60 * 1000;

/**
 * The retention rules go by age, so they are applied when the app starts and once a day, not only
 * after a run: an app nobody runs tests in must still let go of old traces.
 */
function tidy() {
	try {
		applyRetention();
	} catch (e) {
		console.error('Could not apply the retention rules to the run history:', e);
	}
}

export const init: ServerInit = async () => {
	const problem = exposureProblem(mode) ?? oldLayoutProblem();
	if (problem) throw new Error(problem);
	if (mode === 'passkey') await signIn();
	tidy();
	// unref: the timer alone must not keep the process alive.
	setInterval(tidy, DAY).unref();
};

/** Refuses requests sent to a host name the app does not know (see host-check.ts). */
const checkHost: Handle = ({ event, resolve }) => {
	// HTTP/2 has no Host header; the URL's host then comes from the request's authority.
	const host = event.request.headers.get('host') ?? event.url.host;
	if (!hostAllowed(host, allowed)) {
		return new Response(
			'This host name is not allowed. Open the app as localhost, or add the name to TEST_APP_ALLOWED_HOSTS.',
			{ status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } }
		);
	}
	return resolve(event);
};

/**
 * With sign-in on: every request but the sign-in page and its calls needs a session. Better Auth
 * answers its own paths (/api/auth/...).
 */
const requireSession: Handle = async ({ event, resolve }) => {
	if (mode === 'off') return resolve(event);
	const { auth, store } = await signIn();
	const session = await auth.api.getSession({ headers: event.request.headers });
	if (session) {
		const { id, name, role } = session.user;
		event.locals.user = { id, name, role: role === 'admin' ? 'admin' : 'member' };
		if (event.url.pathname === '/api/auth/sign-out') store.record({ id, name }, 'Signed out');
	} else if (!isPublicPath(event.url.pathname)) {
		return signedOutResponse(event.request, event.url);
	}
	return svelteKitHandler({ event, resolve, auth, building });
};

/** The host check first: a request to an unknown name gets no further, not even to sign-in. */
export const handle: Handle = ({ event, resolve }) =>
	checkHost({
		event,
		resolve: (checked) => Promise.resolve(requireSession({ event: checked, resolve }))
	});
