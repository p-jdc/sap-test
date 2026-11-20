// Guide §4.6 – tests call these, not the fork's API, so swapping the tool underneath
// later means changing this folder instead of every test.
// getByRoleSID requires an options object in the fork's types, even when empty (the guide's §4.6
// example passes only the role and does not type-check).
import type { Page } from '@playwright/test';

export async function runTransaction(page: Page, tcode: string) {
	await page.getByRoleSID('okCode', {}).fill('/n' + tcode);
	await page.keyboard.press('Enter');
}

export function field(page: Page, name: string) {
	return page.getByRoleSID('textField', { name });
}
