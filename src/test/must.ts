import { expect } from 'vitest';

/** Asserts a value is present and returns it narrowed, for index access under noUncheckedIndexedAccess. */
export function must<T>(value: T | undefined | null): T {
	expect(value).toBeDefined();
	expect(value).not.toBeNull();
	if (value === undefined || value === null) throw new Error('must: value missing');
	return value;
}
