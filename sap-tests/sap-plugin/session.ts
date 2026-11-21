// Saved sign-in sessions. The sign-in projects in playwright.config.ts (setup/sign-in.setup.ts)
// sign in once per run, without a trace, and save the session; the tests of each system's project
// start with it. So the password is typed only where nothing records it: a trace holds the value of a
// filled password field in its page snapshots and the login request in its network log.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Page } from '@playwright/test';

/** Where a system's session is saved: sap-tests/.auth (gitignored), separate from recordings. */
export function sessionFile(system: string): string {
	return resolve(__dirname, '..', '.auth', `${system}-session.json`);
}

/**
 * Replaces the saved session with an empty one. The setup does this before it signs in, so a
 * failed or skipped sign-in never leaves an older session behind for the tests.
 */
export function clearSession(system: string) {
	const file = sessionFile(system);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify({ cookies: [], origins: [] }));
}

/** Saves the signed-in state of the page's browser context for the tests. */
export async function saveSession(page: Page, system: string) {
	await page.context().storageState({ path: sessionFile(system) });
}

/**
 * Runs a sign-in and, if it fails, empties the page's password fields before the error is
 * reported: on a failure Playwright writes the page's accessibility tree, field values included,
 * to error-context.md.
 */
export async function signingIn(page: Page, signIn: () => Promise<void>) {
	try {
		await signIn();
	} catch (error) {
		await page
			.locator('input[type="password"]')
			.evaluateAll((fields) => {
				for (const field of fields) if (field instanceof HTMLInputElement) field.value = '';
			})
			.catch(() => undefined);
		throw error;
	}
}
