const MASK = '***';

/**
 * Returns a function that replaces every secret in a value with `***`: in a string, and in the
 * strings inside arrays and plain objects (not in keys). Longer secrets go first, so a secret that
 * contains another is masked whole.
 */
export function redactor(secrets: readonly string[]): <T>(value: T) => T {
	const sorted = [...new Set(secrets.filter(Boolean))].toSorted((a, b) => b.length - a.length);
	const text = (s: string) => sorted.reduce((out, secret) => out.replaceAll(secret, MASK), s);
	const deep = (value: unknown): unknown => {
		if (typeof value === 'string') return text(value);
		if (Array.isArray(value)) return value.map((item) => deep(item));
		if (value !== null && typeof value === 'object') {
			return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, deep(v)]));
		}
		return value;
	};
	// Same shape in and out: only string values change.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion
	return <T>(value: T): T => (sorted.length === 0 ? value : (deep(value) as T));
}
