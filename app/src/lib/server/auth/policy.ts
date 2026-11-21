import { isIP } from 'node:net';

/**
 * Sign-in for the app. Off by default: on a laptop the app is reached only from that laptop. With
 * TEST_APP_AUTH=passkey every page, remote function and run file needs a signed-in user, who signs
 * in with a passkey (auth.ts). Without it, the app refuses to listen on the network (`exposure`).
 */
export type AuthMode = 'off' | 'passkey';

export function authMode(value = process.env.TEST_APP_AUTH): AuthMode {
	const mode = (value ?? '').trim().toLowerCase();
	if (mode === '' || mode === 'off') return 'off';
	if (mode === 'passkey') return 'passkey';
	throw new Error(`TEST_APP_AUTH must be "passkey" or "off", not "${value}".`);
}

/** Whether HOST (the address the server listens on) reaches only this computer. */
export function listensLocally(host = process.env.HOST): boolean {
	const name = (host ?? '')
		.trim()
		.replaceAll(/^\[|\]$/g, '')
		.toLowerCase();
	if (name === '' || name === 'localhost') return true;
	if (isIP(name) === 4) return name.startsWith('127.');
	return name === '::1';
}

/**
 * Why the app must not start, or null. Anyone who can reach an app without sign-in can run tests
 * with the saved SAP credentials and read every trace, so it does not listen on the network
 * without it, nor with sign-in but without its https address.
 */
export function exposureProblem(
	mode: AuthMode,
	host = process.env.HOST,
	appUrl = process.env.BETTER_AUTH_URL
): string | null {
	if (listensLocally(host)) return null;
	if (mode === 'off')
		return `HOST=${host} makes the app reachable from the network, which needs sign-in: set TEST_APP_AUTH=passkey (see the README), or listen on 127.0.0.1.`;
	// Taken from requests instead, the address would be http:// behind a proxy that ends TLS, and
	// the passkeys would belong to whatever name a request used.
	if (!appUrl?.startsWith('https://'))
		return `On the network, sign-in needs the app's https:// address in BETTER_AUTH_URL (passkeys belong to its host name), not ${appUrl ? `"${appUrl}"` : 'nothing'}.`;
	return null;
}

/** Paths that answer without a session: the sign-in page and what it calls. */
const PUBLIC = ['/signin', '/api/auth/', '/api/signin-state'];

export function isPublicPath(pathname: string): boolean {
	return PUBLIC.some((p) => (p.endsWith('/') ? pathname.startsWith(p) : pathname === p));
}

/**
 * The answer to a request without a session: a page load goes to the sign-in page (and back
 * afterwards); data requests (remote functions, run files) get 401.
 */
export function signedOutResponse(request: Request, url: URL): Response {
	const wantsPage =
		request.method === 'GET' && (request.headers.get('accept') ?? '').includes('text/html');
	if (!wantsPage) {
		return new Response('Sign in first.', {
			status: 401,
			headers: { 'content-type': 'text/plain; charset=utf-8' }
		});
	}
	const back = url.pathname + url.search;
	const target = back === '/' ? '/signin' : `/signin?redirect=${encodeURIComponent(back)}`;
	return new Response(null, { status: 303, headers: { location: target } });
}

/** Only a path on this app, so a sign-in link cannot send the browser elsewhere afterwards. */
export function safeRedirect(target: string | null): string {
	if (!target || !target.startsWith('/') || target.startsWith('//') || target.startsWith('/\\'))
		return '/';
	return target;
}
