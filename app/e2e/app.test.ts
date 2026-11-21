import { expect, test, type Page } from '@playwright/test';

/** Switches on "Technical details" (kept in localStorage) before the app loads. */
async function technical(page: Page) {
	await page.addInitScript(() => {
		localStorage.setItem('sap-test-lab.technical', '1');
	});
}

test('home page speaks plain language until technical details are switched on', async ({
	page
}) => {
	await page.goto('/');
	await expect(page.getByText('Getting started')).toBeVisible();
	await expect(page.getByText(/Reliability: \d+ of \d+ tests/)).toBeVisible();
	await expect(page.getByText(/Playwright \d/)).toBeHidden();

	await page.locator('ui5-switch[accessible-name="Technical details"]').click();
	await expect(page.getByText(/Playwright \d+\.\d+\.\d+ with SAP plugin/)).toBeVisible();
	// The choice survives a reload.
	await page.reload();
	await expect(page.getByText(/Playwright \d+\.\d+\.\d+ with SAP plugin/)).toBeVisible();
});

test('tests page lists the demo spec and opens its flow', async ({ page }) => {
	await page.goto('/tests');
	await page.getByRole('link', { name: 'demo: create sales order' }).click();
	await expect(page).toHaveURL(/\/flow\?key=/);
	// start node + 5 steps (beforeEach setContent, 2 fills, click, assert) + end node
	await expect(page.locator('.svelte-flow__node')).toHaveCount(7);
	// Steps read as sentences, not code.
	await expect(page.getByText('Enter “1000” in “Sold-To Party”')).toBeVisible();
	await expect(page.getByText("getByLabel('Sold-To Party')")).toBeHidden();
});

test('the rule check flags the example spec', async ({ page }) => {
	await page.goto(
		'/flow?key=' + encodeURIComponent('fiori/rule-findings.example.spec.ts::example: rule findings')
	);
	await expect(page.locator('.svelte-flow__node .issue.error')).toHaveCount(3);
});

test('running a demo test streams to a finished, passed run', async ({ page }) => {
	await page.goto(
		'/flow?key=' + encodeURIComponent('_demo/order-form.spec.ts::demo: create sales order')
	);
	await page.locator('ui5-button', { hasText: 'Run this test' }).click();
	await expect(page).toHaveURL(/run=\d{8}-\d{6}-/);
	await expect(page.getByText('Test passed')).toBeVisible({ timeout: 30_000 });
	await expect(page.locator('.svelte-flow__node .node.passed')).toHaveCount(5);
});

test('settings page lists the settings without showing values', async ({ page }) => {
	await page.goto('/settings');
	await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
	// The browser path is for whoever installs the app; it shows with technical details only.
	await expect(page.locator('[data-setting]')).toHaveCount(6);
	await expect(page.getByText('SAP_PASSWORD')).toBeHidden();
	await expect(page.locator('[data-setting="SAP_PASSWORD"] ui5-input')).toHaveAttribute(
		'type',
		'Password'
	);
});

test('settings page shows the setting names and the browser path with technical details', async ({
	page
}) => {
	await technical(page);
	await page.goto('/settings');
	await expect(page.locator('[data-setting]')).toHaveCount(7);
	await expect(page.getByText('SAP_PASSWORD')).toBeVisible();
});
