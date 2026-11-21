// Starts signed in: setup/sign-in.setup.ts saves the session for the "ariba" project (systems.json).
import { test, expect } from '../../sap-plugin';
import { requireEnv } from '../../helpers/env';

test('open requisition (Ariba)', async ({ page }) => {
	requireEnv('ARIBA_URL', 'ARIBA_USER', 'ARIBA_PASS');
	await page.goto(process.env.ARIBA_URL!);
	await page.getByRole('link', { name: 'Create' }).click();
	await page.getByRole('link', { name: 'Requisition' }).click();
	await expect(page.getByRole('heading', { name: 'Requisition' })).toBeVisible();
});
