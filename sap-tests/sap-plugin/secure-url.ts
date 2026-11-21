// Where a password may go: over https, or over http only to this computer (a local mock or
// stand-in). Over http to any other host it would cross the network unencrypted. The test app's
// Settings page applies the same rule (app/src/lib/server/origin.ts); this one also covers values
// from .env.

function isLoopback(hostname: string): boolean {
	const name = hostname.replaceAll(/^\[|\]$/g, '').toLowerCase();
	return (
		name === 'localhost' ||
		name.endsWith('.localhost') ||
		name === '::1' ||
		/^127(?:\.\d{1,3}){3}$/.test(name)
	);
}

/** True for an http:// URL to another computer: no password may be sent there. */
export function isInsecureHttp(url: string): boolean {
	try {
		const { protocol, hostname } = new URL(url);
		return protocol === 'http:' && !isLoopback(hostname);
	} catch {
		return false;
	}
}
