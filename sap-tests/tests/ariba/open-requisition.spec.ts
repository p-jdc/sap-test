import { test, expect } from '@playwright/test';
import { requireEnv } from '../../helpers/env';

test('open requisition (Ariba)', async ({ page }) => {
	requireEnv('ARIBA_URL', 'ARIBA_USER', 'ARIBA_PASS');
	await page.goto(process.env.ARIBA_URL!);
	await page.getByLabel('User Name').fill(process.env.ARIBA_USER!);
	await page.getByLabel('Password').fill(process.env.ARIBA_PASS!);
	await page.getByRole('button', { name: 'Login' }).click();
	await page.getByRole('link', { name: 'Create' }).click();
	await page.getByRole('link', { name: 'Requisition' }).click();
	await expect(page.getByRole('heading', { name: 'Requisition' })).toBeVisible();
});
