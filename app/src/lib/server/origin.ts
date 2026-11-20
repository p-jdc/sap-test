/** True when both URLs point at the same scheme, host and port. Invalid URLs never match. */
export function sameOrigin(a: string, b: string): boolean {
	try {
		return new URL(a).origin === new URL(b).origin;
	} catch {
		return false;
	}
}
