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

test('a new test is recorded or planned by the AI, which is off until it is turned on', async ({
	page
}) => {
	await page.goto('/recorder');
	await expect(page.getByRole('heading', { name: 'Record a test' })).toBeVisible();
	await page.getByRole('option', { name: 'Let the AI plan it' }).click();
	await expect(page).toHaveURL(/\/recorder\?way=plan$/);
	await expect(page.getByRole('heading', { name: 'Plan a test' })).toBeVisible();
	await expect(page.getByText(/^The planner is off\./)).toBeVisible();
	await expect(page.locator('ui5-button', { hasText: 'Plan the tests' })).toHaveAttribute(
		'disabled'
	);
	// The choice is in the address: a reload stays on the planner.
	await page.reload();
	await expect(page.getByRole('heading', { name: 'Plan a test' })).toBeVisible();
	await page.getByRole('option', { name: 'Record it yourself' }).click();
	await expect(page.getByRole('button', { name: 'Start recording' })).toBeVisible();
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
	await expect(page.locator('[data-setting]')).toHaveCount(18);
	// Where the Mock IDoc receiver sends IDocs: four settings each for S/4HANA and EWM.
	await expect(page.locator('[data-setting^="IDOC_S4_"]')).toHaveCount(4);
	await expect(page.locator('[data-setting^="IDOC_EWM_"]')).toHaveCount(4);
	await expect(page.locator('[data-setting="IDOC_EWM_PASSWORD"] ui5-input')).toHaveAttribute(
		'type',
		'Password'
	);
	await expect(page.getByText('SAP_PASSWORD')).toBeHidden();
	await expect(page.locator('[data-setting="SAP_PASSWORD"] ui5-input')).toHaveAttribute(
		'type',
		'Password'
	);
});

test('settings page shows the setting names and the browser settings with technical details', async ({
	page
}) => {
	await technical(page);
	await page.goto('/settings');
	// The two browser settings: the Chromium path and the self-signed host.
	await expect(page.locator('[data-setting]')).toHaveCount(20);
	await expect(page.locator('[data-setting="SAP_SELF_SIGNED_HOST"]')).toBeVisible();
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

test('Mock PLC: against a real EWM a scenario asks for the HU numbers and runs with them', async ({
	page
}) => {
	await page.goto('/mfs');
	await expect(page.getByText('Start the Mock PLC')).toBeVisible();
	// The mode is "real EWM" by default. No EWM connects in this test: the PLCs wait.
	await expect(page.getByText('Scenarios for a real EWM are run after the start')).toBeVisible();
	await expect(page.locator('#scenario')).toHaveCount(0);
	await page.locator('ui5-button[icon="play"]').click();

	const runButton = page.locator('ui5-button', { hasText: 'Run scenario' });
	await expect(runButton).toBeVisible({ timeout: 20_000 });
	await expect(page.getByText('An HU that EWM already knows arrives')).toBeVisible();
	// Without a number EWM would not know the HU: the scenario cannot start.
	await expect(runButton).toHaveAttribute('disabled');
	await page.locator('#hu-number-A input').fill('112345678000004711');
	await expect(runButton).not.toHaveAttribute('disabled');
	await runButton.click();

	await expect(page.getByText('Scenario: Putaway into the high rack (real EWM)')).toBeVisible();
	await expect(page.getByText('HU A is 112345678000004711')).toBeVisible();

	await page.locator('ui5-button', { hasText: 'Stop scenario' }).click();
	await expect(page.locator('ui5-tag', { hasText: 'Stopped' })).toBeVisible();
	await page.locator('ui5-button[icon="stop"]').last().click();
	await expect(page.getByText('Start the Mock PLC')).toBeVisible();
});

test('Mock IDoc: a sample IDoc is received and shown, refused once set so, the list cleared, and one sent into EWM', async ({
	page
}) => {
	// The receiver card's send button; the card that sends into SAP has one with the same icon.
	const sendSample = page.locator('ui5-button[icon="paper-plane"]', { hasText: /^\s*Send\s*$/ });
	await page.goto('/idoc');
	await expect(page.getByText('Start the IDoc receiver')).toBeVisible();
	await page.locator('ui5-button[icon="play"]').click();
	await expect(page.locator('ui5-tag', { hasText: 'Receiving' })).toBeVisible({ timeout: 20_000 });
	await expect(page.getByText('/idoc/<partner>')).toBeVisible();
	await expect(page.getByText('No IDocs yet.')).toBeVisible();

	// The sample stands in for SAP.
	await page.locator('#sample').click();
	await page.locator('#sample ui5-option[data-value="orders05.xml"]').click();
	await sendSample.click();
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
	await sendSample.click();
	await expect(
		page.getByText('The receiver refused the IDoc (HTTP 500): Rejected by the IDoc mock')
	).toBeVisible();
	await expect(page.locator('button.idoc ui5-tag', { hasText: 'Rejected' })).toHaveCount(1);
	await page.locator('ui5-button', { hasText: 'Back to accept' }).click();
	await expect(page.getByText("Every partner's IDocs are accepted.")).toBeVisible();

	await page.locator('ui5-button[icon="delete"]').click();
	await expect(page.getByText('No IDocs yet.')).toBeVisible();

	// The e2e app sends to stand-ins only (TEST_APP_IDOC_STAND_INS): send the inbound sample into EWM's.
	await page.locator('#sap-to').click();
	const ewm = page.locator('#sap-to ui5-option[data-value="ewm"]');
	await expect(ewm).toContainText('EWM (stand-in)');
	await ewm.click();
	await expect(page.locator('ui5-tag', { hasText: 'Stand-in, not SAP' })).toBeVisible();
	await page.locator('ui5-button', { hasText: 'Send to EWM' }).click();
	await expect(
		page.getByText('The stand-in for EWM took the IDoc: IDoc number 0000000000000001.')
	).toBeVisible();
	await expect(page.locator('ui5-tag', { hasText: 'Taken by the stand-in' })).toHaveCount(1);
	await page.locator('ui5-button', { hasText: 'Clear the list' }).click();
	await expect(page.getByText('Nothing sent yet.')).toBeVisible();
	await page.locator('ui5-button[icon="stop"]').click();
	await expect(page.getByText('Start the IDoc receiver')).toBeVisible();
});

test('Mock OData: shows the data, logs a request, fails a service as set, and stops', async ({
	page
}) => {
	await page.goto('/odata');
	await expect(page.getByText('Start the OData mock')).toBeVisible();
	await page.locator('ui5-button[icon="play"]').click();
	await expect(page.locator('ui5-tag', { hasText: 'Serving' })).toBeVisible({ timeout: 20_000 });

	// The service and where it is served; the test calls it there, as an API test would.
	const served = page.locator('.line', { hasText: 'GWSAMPLE_BASIC' }).locator('.mono').first();
	await expect(served).toHaveText(
		/^http:\/\/127\.0\.0\.1:\d+\/sap\/opu\/odata\/IWBEP\/GWSAMPLE_BASIC$/
	);
	const service = (await served.textContent()) ?? '';

	// The data, as the files have it.
	await page.getByRole('button', { name: /^ProductSet\s+3$/ }).click();
	const table = page.getByRole('table', { name: 'Entries of ProductSet' });
	await expect(table.getByRole('cell', { name: 'MK-1000' })).toBeVisible();

	expect((await page.request.get(`${service}/ProductSet('MK-1000')?$format=json`)).status()).toBe(
		200
	);
	const read = page.locator('button.request', { hasText: "/ProductSet('MK-1000')" });
	await expect(read.locator('ui5-tag', { hasText: '200' })).toBeVisible();
	await read.click();
	await expect(page.locator('pre.raw', { hasText: 'Mock Notebook 15' })).toBeVisible();

	// A write shows after a refresh; a reset brings back the files.
	const created = await page.request.post(`${service}/ProductSet`, {
		data: {
			ProductID: 'MKE2E',
			TypeCode: 'PR',
			Category: 'Notebooks',
			Name: 'Written by the e2e test',
			SupplierID: '0100000000',
			TaxTarifCode: 1,
			MeasureUnit: 'EA',
			CurrencyCode: 'EUR',
			Price: '1.00'
		}
	});
	expect(created.status()).toBe(201);
	await page.getByRole('button', { name: 'Refresh' }).click();
	await expect(page.getByRole('button', { name: /^ProductSet\s+4$/ })).toBeVisible();
	await expect(table.getByRole('cell', { name: 'MKE2E' })).toBeVisible();
	await page.getByRole('button', { name: 'Reset to the files' }).click();
	await expect(page.getByRole('button', { name: /^ProductSet\s+3$/ })).toBeVisible();
	await expect(table.getByRole('cell', { name: 'MKE2E' })).toBeHidden();

	// A share the mock can't use is refused on the page, saying which field, and nothing is set.
	await page.locator('#fail-rate').locator('input').fill('0');
	await page.getByText('Set', { exact: true }).click();
	await expect(
		page.getByText('The share of requests must be a whole number from 1 to 100.')
	).toBeVisible();
	await expect(page.getByText('Every service answers normally.')).toBeVisible();
	await page.locator('#fail-rate').locator('input').fill('100');

	// Fail the service: the next request gets the error, marked in the log.
	await page.locator('#fail-status').locator('input').fill('503');
	await page.getByText('Set', { exact: true }).click();
	await expect(page.getByText('Fails with HTTP 503')).toBeVisible();
	expect((await page.request.get(`${service}/ProductSet/$count`)).status()).toBe(503);
	const failed = page.locator('button.request', { hasText: '/ProductSet/$count' });
	await expect(failed.locator('ui5-tag', { hasText: 'Failed as set' })).toBeVisible();
	await page.getByText('Back to normal').click();
	await expect(page.getByText('Every service answers normally.')).toBeVisible();

	// Tests started here call the system in the settings until switched.
	await expect(
		page.getByText('Tests started here call the SAP system in the settings.')
	).toBeVisible();
	await page.locator('ui5-switch#for-tests').click();
	await expect(page.getByText(/Tests started here call the mock instead/)).toBeVisible();

	await page.locator('ui5-button[icon="stop"]').click();
	await expect(page.getByText('Start the OData mock')).toBeVisible();
});
