/** Whether a host name is an IPv4 or IPv6 address (a passkey needs a name). */
export function isIP(hostname: string): boolean {
	return (
		/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith('[') || hostname.includes(':')
	);
}
