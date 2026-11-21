// The login flow of page.SAPLogin, after the Playwright-SAP fork's client code (client/page.ts,
// Apache-2.0, Copyright Arpit Sureka). In a file of its own so that the recorder (record.mjs) can
// log in the same way without loading the selector engines.
import { expect } from '@playwright/test';
import type { Page, Response } from '@playwright/test';

export async function sapLogin(
	page: Page,
	username: string,
	password: string,
	url?: string
): Promise<Response | null> {
	const response = url ? await page.goto(url) : null;
	const netweaverUser = page.getByRole('textbox', { name: 'User Required' });
	const fioriUser = page.getByRole('textbox', { name: 'User', exact: true });
	await expect(
		netweaverUser.or(fioriUser).first(),
		'SAPLogin: no Fiori launchpad or NetWeaver login page found'
	).toBeVisible({ timeout: 30_000 });

	if (await netweaverUser.isVisible()) {
		await netweaverUser.fill(username);
		await page.getByRole('textbox', { name: 'Password Required' }).fill(password);
		await page.getByRole('button', { name: 'Log On Emphasized' }).click();
	} else {
		await fioriUser.fill(username);
		await page.getByRole('textbox', { name: 'Password', exact: true }).fill(password);
		await page.getByRole('button', { name: 'Log On' }).click();
	}
	await page.waitForLoadState();
	return response;
}
