import { expect, test } from '@playwright/test';

test('dashboard shows the Playwright-SAP project', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByText(/Playwright-SAP \d+\.\d+\.\d+/)).toBeVisible();
	await expect(page.getByText('Pilot stability')).toBeVisible();
});

test('tests page lists the demo spec and opens its flow', async ({ page }) => {
	await page.goto('/tests');
	await page.getByRole('link', { name: 'demo: create sales order' }).click();
	await expect(page).toHaveURL(/\/flow\?key=/);
	// start node + 5 steps (beforeEach setContent, 2 fills, click, assert) + end node
	await expect(page.locator('.svelte-flow__node')).toHaveCount(7);
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
