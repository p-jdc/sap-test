import { isIP } from 'node:net';

/**
 * The app has no login and listens on this machine only. That alone does not stop a web page from
 * reaching it: a page can point its own domain name at 127.0.0.1 (DNS rebinding), and the browser
 * then treats the app as part of that site. Such a request still carries the page's name in its
 * Host header, so the app answers only to names it knows.
 *
 * An IP address is always accepted: rebinding needs a name, and whoever makes the app reachable on
 * the network (HOST) must be able to open it by address. Other names go in TEST_APP_ALLOWED_HOSTS.
 */
export function hostAllowed(host: string | null, allowed: readonly string[] = []): boolean {
	if (!host) return false;
	let name: string;
	try {
		// Drops the port, lowercases, and keeps the brackets of an IPv6 address.
		name = new URL(`http://${host}`).hostname.replace(/\.$/, '');
	} catch {
		return false;
	}
	if (name === 'localhost' || name.endsWith('.localhost')) return true;
	if (isIP(name.replaceAll(/^\[|\]$/g, '')) !== 0) return true;
	return allowed.includes(name);
}

/** `TEST_APP_ALLOWED_HOSTS=lab.example.com, sap-lab` → the extra names the app answers to. */
export function configuredHosts(value = process.env.TEST_APP_ALLOWED_HOSTS): string[] {
	return (value ?? '')
		.split(',')
		.map((name) => name.trim().toLowerCase())
		.filter(Boolean);
}
