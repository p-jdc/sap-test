// page.SAPLogin and the SAP login page, after the Playwright-SAP fork's client/page.ts (Apache-2.0,
// Copyright Arpit Sureka), plus the saved-session handling of session.ts.
import { expect, type Locator, type Page, type Response } from '@playwright/test';
import { fillSecret } from './secret';

const netweaverUserField = (page: Page) => page.getByRole('textbox', { name: 'User Required' });
const fioriUserField = (page: Page) => page.getByRole('textbox', { name: 'User', exact: true });

/** The user field of a Fiori launchpad or NetWeaver login page: visible while signed out. */
export function sapLoginPage(page: Page): Locator {
	return netweaverUserField(page).or(fioriUserField(page)).first();
}

/** page.SAPLogin: see SapPageMethods in index.ts. */
export async function sapLogin(
	page: Page,
	username: string,
	password: string,
	url?: string
): Promise<Response | null> {
	// A test's browser context starts without cookies unless it was given a saved session.
	const fromSession = (await page.context().cookies()).length > 0;
	const response = url ? await page.goto(url) : null;
	const netweaverUser = netweaverUserField(page);
	const fioriUser = fioriUserField(page);
	const loginPage = sapLoginPage(page);
	if (fromSession) {
		// Typing the password here would put it into this test's trace.
		if (await loginPage.isVisible()) {
			throw new Error(
				'SAPLogin: the saved SAP session is no longer valid (a login page opened). Run the tests again: the sign-in setup saves a new one.'
			);
		}
		return response;
	}
	await expect(loginPage, 'SAPLogin: no Fiori launchpad or NetWeaver login page found').toBeVisible(
		{
			timeout: 30_000
		}
	);

	if (await netweaverUser.isVisible()) {
		await netweaverUser.fill(username);
		await fillSecret(page.getByRole('textbox', { name: 'Password Required' }), password);
		await page.getByRole('button', { name: 'Log On Emphasized' }).click();
	} else {
		await fioriUser.fill(username);
		await fillSecret(page.getByRole('textbox', { name: 'Password', exact: true }), password);
		await page.getByRole('button', { name: 'Log On' }).click();
	}
	await page.waitForLoadState();
	return response;
}
