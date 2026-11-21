import type { Handle } from '@sveltejs/kit/hooks';
import { configuredHosts, hostAllowed } from '#lib/server/host-check.js';

const allowed = configuredHosts();

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
