import { test, expect } from '@playwright/test';
import { button, input } from '../../helpers/fiori';
import { requireEnv } from '../../helpers/env';

// Placeholder values (guide §4.5) – your recording contains the real ones.
const SOLD_TO_PARTY = '1000';

test('create sales order (Fiori)', async ({ page }) => {
	requireEnv('SAP_URL', 'SAP_USERNAME', 'SAP_PASSWORD');
	await page.SAPLogin(process.env.SAP_USERNAME!, process.env.SAP_PASSWORD!, process.env.SAP_URL);
	await button(page, 'Create').click();
	await input(page, 'Sold-To Party').fill(SOLD_TO_PARTY);
	await button(page, 'Save').click();
	await expect(page.getByText('Sales order')).toBeVisible();
});
