// Seed for the Playwright test agents when the flow starts behind the SAP login (Fiori launchpad
// or WebGUI): logs in with the values from .env and hands the logged-in page to the agent.
// Skipped without those values, like every test that needs an SAP system.
import { test } from '../../sap-plugin';
import { requireEnv } from '../../helpers/env';

test('seed: logged in to SAP', async ({ page }) => {
	requireEnv('SAP_URL', 'SAP_USERNAME', 'SAP_PASSWORD');
	await page.SAPLogin(process.env.SAP_USERNAME!, process.env.SAP_PASSWORD!, process.env.SAP_URL);
});
