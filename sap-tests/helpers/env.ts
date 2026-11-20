import { test } from '@playwright/test';

/** Skips the current test unless every named variable is set (keeps the suite green without an SAP system). */
export function requireEnv(...names: string[]) {
	const missing = names.filter((n) => !process.env[n]);
	test.skip(missing.length > 0, `missing env: ${missing.join(', ')}`);
}
