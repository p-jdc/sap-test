// A test system with a self-signed certificate, such as an SAP Cloud Appliance Library appliance
// reached by its IP address. The setting SAP_SELF_SIGNED_HOST names that one host. Browsers for a
// system that signs in with the SAP login then accept its certificate, but only while the system's
// address is on that host: pointing the address at another system ends the exception by itself.
// Nothing else is accepted, so a man in the middle on any other address still fails the check.
// No imports: the test app bundles this file (setting-value.ts, recorder.ts).

/** The setting that holds the host whose self-signed certificate is accepted. */
export const SELF_SIGNED_SETTING = 'SAP_SELF_SIGNED_HOST';

const asHost = (value: string) => value.trim().toLowerCase();

/** Why `value` cannot be the host of SAP_SELF_SIGNED_HOST, or undefined when it can. */
export function selfSignedHostProblem(value: string): string | undefined {
	const host = asHost(value);
	const url = URL.canParse(`https://${host}/`) ? new URL(`https://${host}/`) : undefined;
	if (!host || url?.hostname !== host || url.port)
		return `${SELF_SIGNED_SETTING} must be a host name or IP address only, without https://, port or path, for example 203.0.113.10.`;
	return undefined;
}

/**
 * Whether the browser for `address` accepts a self-signed certificate: it is an https:// address
 * on `host`, the value of SAP_SELF_SIGNED_HOST. False when either is missing.
 */
export function acceptsSelfSigned(address: string | undefined, host: string | undefined): boolean {
	if (!address || !host || !URL.canParse(address)) return false;
	const url = new URL(address);
	return url.protocol === 'https:' && url.hostname === asHost(host);
}
