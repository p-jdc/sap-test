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
	await expect(page.locator('[data-setting]')).toHaveCount(10);
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
	await expect(page.locator('[data-setting]')).toHaveCount(11);
	await expect(page.getByText('SAP_PASSWORD')).toBeVisible();
});

test('Mock PLC: the demo stores an HU, sends one with a contour error to clearing, and stops', async ({
	page
}) => {
	await page.goto('/mfs');
	await expect(page.getByText('Start the Mock PLC')).toBeVisible();
	await page.locator('#mode').click();
	await page.locator('ui5-option[data-value="demo"]').click();
	await page.locator('#speed').click();
	await page.locator('ui5-option[data-value="10"]').click();
	await page.locator('ui5-button[icon="play"]').click();

	await expect(page.getByText('Demo running')).toBeVisible({ timeout: 20_000 });
	// A UI5 tag's text includes its shadow content, so match plain text, not an anchored pattern.
	const connected = page.locator('ui5-tag', { hasText: 'Connected', hasNotText: 'Not connected' });
	await expect(connected).toHaveCount(4);
	// The warehouse is drawn: 3 aisles of 10 × 5 bins.
	await expect(page.locator('svg rect.bin')).toHaveCount(150);

	await page.locator('#hu').locator('input').fill('900001');
	await page.locator('ui5-button[icon="add"]').click();
	const stored = page.locator('.line', { hasText: '900001' });
	await expect(stored.getByText('Stored')).toBeVisible({ timeout: 20_000 });
	await expect(page.locator('svg rect.bin.occupied')).toHaveCount(1);

	await page.locator('#idpoint').click();
	await page.locator('ui5-option[data-value="CONT"]').click();
	await page.locator('#hu').locator('input').fill('900002');
	await page.locator('ui5-button[icon="add"]').click();
	await expect(page.locator('.line', { hasText: '900002' }).getByText('In clearing')).toBeVisible({
		timeout: 20_000
	});
	await expect(page.getByText('IP reads HU 900002: CONT')).toBeVisible();

	await page.locator('ui5-button[icon="stop"]').click();
	await expect(page.getByText('Start the Mock PLC')).toBeVisible();
});

test('Mock PLC: a scenario chosen at the start runs and passes, step by step', async ({ page }) => {
	await page.goto('/mfs');
	await expect(page.getByText('Start the Mock PLC')).toBeVisible();
	await page.locator('#mode').click();
	await page.locator('ui5-option[data-value="demo"]').click();
	await page.locator('#speed').click();
	await page.locator('ui5-option[data-value="10"]').click();
	await page.locator('#scenario').click();
	await page.locator('ui5-option[data-value="rejected-at-id-point"]').click();
	await expect(page.getByText('One HU sticks out (contour error)')).toBeVisible();
	await page.locator('ui5-button[icon="play"]').click();

	await expect(page.getByText('Scenario: Rejected at the identification point')).toBeVisible({
		timeout: 20_000
	});
	await expect(page.locator('ui5-tag', { hasText: 'Passed' })).toBeVisible({ timeout: 30_000 });
	await expect(page.getByText('HU A arrives at goods receipt, with a contour error')).toBeVisible();
	await expect(page.getByText('Expected results')).toBeVisible();
	await expect(page.locator('.check.failed')).toHaveCount(0);

	// Another scenario on the same Mock PLC.
	await page.locator('#next-scenario').click();
	await page.locator('ui5-option', { hasText: 'Putaway into the high rack' }).click();
	await page.locator('ui5-button', { hasText: 'Run' }).click();
	await expect(page.getByText('Scenario: Putaway into the high rack')).toBeVisible();
	await expect(page.locator('ui5-tag', { hasText: 'Passed' })).toBeVisible({ timeout: 30_000 });

	await page.locator('ui5-button[icon="stop"]').click();
	await expect(page.getByText('Start the Mock PLC')).toBeVisible();
});

test('Mock IDoc: a sample IDoc is received and shown, refused once set so, and the list cleared', async ({
	page
}) => {
	await page.goto('/idoc');
	await expect(page.getByText('Start the IDoc receiver')).toBeVisible();
	await page.locator('ui5-button[icon="play"]').click();
	await expect(page.locator('ui5-tag', { hasText: 'Receiving' })).toBeVisible({ timeout: 20_000 });
	await expect(page.getByText('/idoc/<partner>')).toBeVisible();
	await expect(page.getByText('No IDocs yet.')).toBeVisible();

	// The sample stands in for SAP.
	await page.locator('#sample').click();
	await page.locator('ui5-option[data-value="orders05.xml"]').click();
	await page.locator('ui5-button[icon="paper-plane"]').click();
	await expect(page.getByText('The receiver accepted the IDoc.')).toBeVisible();
	const first = page.locator('button.idoc', { hasText: 'ORDERS05 · ORDRSP' });
	await expect(first).toHaveCount(1);
	// A UI5 tag's text includes its shadow content: match contained text.
	await expect(first.locator('ui5-tag')).toContainText('Accepted');

	// Opened, it shows its control record and segments.
	await first.click();
	await expect(page.getByText('ORDERS05 · ORDRSP for PWMOCK')).toBeVisible();
	await expect(page.getByText('E1EDP19').first()).toBeVisible();
	await expect(page.getByText('Müller & Söhne GmbH')).toBeVisible();

	// Refuse PWMOCK's IDocs (the form starts at "Refuse" with HTTP 500).
	await page.locator('ui5-button', { hasText: /^\s*Set\s*$/ }).click();
	await expect(page.getByText('Rejected with HTTP 500: Rejected by the IDoc mock')).toBeVisible();
	await page.locator('ui5-button[icon="paper-plane"]').click();
	await expect(
		page.getByText('The receiver refused the IDoc (HTTP 500): Rejected by the IDoc mock')
	).toBeVisible();
	await expect(page.locator('button.idoc ui5-tag', { hasText: 'Rejected' })).toHaveCount(1);
	await page.locator('ui5-button', { hasText: 'Back to accept' }).click();
	await expect(page.getByText("Every partner's IDocs are accepted.")).toBeVisible();

	await page.locator('ui5-button[icon="delete"]').click();
	await expect(page.getByText('No IDocs yet.')).toBeVisible();
	await page.locator('ui5-button[icon="stop"]').click();
	await expect(page.getByText('Start the IDoc receiver')).toBeVisible();
});
