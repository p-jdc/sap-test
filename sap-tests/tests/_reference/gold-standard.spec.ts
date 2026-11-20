// Reference test (guide §5.3): replace with the cleanest pilot test once it has been hand-reviewed.
import { test, expect } from '@playwright/test';
import { button, input } from '../../helpers/fiori';
import { requireEnv } from '../../helpers/env';

const SOLD_TO_PARTY = '1000';

test('reference: create sales order', async ({ page }) => {
	requireEnv('SAP_URL', 'SAP_USERNAME', 'SAP_PASSWORD');
	await page.SAPLogin(process.env.SAP_USERNAME!, process.env.SAP_PASSWORD!, process.env.SAP_URL!);
	await button(page, 'Create').click();
	await input(page, 'Sold-To Party').fill(SOLD_TO_PARTY);
	await button(page, 'Save').click();
	await expect(page.getByText('Sales order')).toBeVisible();
});
