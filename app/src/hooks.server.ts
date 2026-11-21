import type { Handle, ServerInit } from '@sveltejs/kit/hooks';
import { configuredHosts, hostAllowed } from '#lib/server/host-check.js';
import { applyRetention } from '#lib/server/runs-store.js';

const allowed = configuredHosts();

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

export const init: ServerInit = () => {
	tidy();
	// unref: the timer alone must not keep the process alive.
	setInterval(tidy, DAY).unref();
};

/** Refuses requests sent to a host name the app does not know (see host-check.ts). */
export const handle: Handle = ({ event, resolve }) => {
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
