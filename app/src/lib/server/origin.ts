/** True when both URLs point at the same scheme, host and port. Invalid URLs never match. */
export function sameOrigin(a: string, b: string): boolean {
	try {
		return new URL(a).origin === new URL(b).origin;
	} catch {
		return false;
	}
}

/** A host name or address that always means this computer. */
function isLoopback(hostname: string): boolean {
	const name = hostname.replaceAll(/^\[|\]$/g, '').toLowerCase();
	return (
		name === 'localhost' ||
		name.endsWith('.localhost') ||
		name === '::1' ||
		/^127(?:\.\d{1,3}){3}$/.test(name)
	);
}

/**
 * Whether a user and password may be sent to this URL: over https, or over http only to this
 * computer (a local mock or stand-in). Over http to any other host they would cross the network
 * unencrypted.
 */
export function allowsCredentials(url: string): boolean {
	try {
		const { protocol, hostname } = new URL(url);
		return protocol === 'https:' || (protocol === 'http:' && isLoopback(hostname));
	} catch {
		return false;
	}
}
