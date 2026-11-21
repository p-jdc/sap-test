import { test, expect } from '../../sap-plugin';
import { ORDER_FORM } from './fixture';

const SOLD_TO_PARTY = '1000';
const MATERIAL = 'TG11';

test.beforeEach(async ({ page }) => {
	await page.setContent(ORDER_FORM);
});

test('demo: create sales order', async ({ page }) => {
	await page.getByLabel('Sold-To Party').fill(SOLD_TO_PARTY);
	await page.getByLabel('Material').fill(MATERIAL);
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByRole('status')).toHaveText('Sales order 4711 created');
});

test('demo: save without material shows hint', async ({ page }) => {
	await page.getByLabel('Sold-To Party').fill(SOLD_TO_PARTY);
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByRole('status')).toHaveText('Fill all fields');
});

// Fails on purpose so the Test-App has a trace, screenshot and video to show.
test('demo: intentional failure (shows trace)', async ({ page }) => {
	await page.getByLabel('Sold-To Party').fill(SOLD_TO_PARTY);
	await page.getByRole('button', { name: 'Save' }).click();
	await expect(page.getByRole('status')).toHaveText('Sales order 4711 created', { timeout: 2_000 });
});
