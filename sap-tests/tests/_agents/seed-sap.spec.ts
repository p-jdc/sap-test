// Seed for the Playwright test agents when the flow starts behind the SAP login (Fiori launchpad
// or WebGUI). It belongs to the `sap` project, so setup/sap.setup.ts signs in first, without a
// trace, with the values from .env; SAPLogin here only opens the address with that session and
// hands the signed-in page to the agent. Skipped without those values, like every test that needs
// an SAP system.
import { test } from '../../sap-plugin';
import { requireEnv } from '../../helpers/env';

test('seed: logged in to SAP', async ({ page }) => {
	requireEnv('SAP_URL', 'SAP_USERNAME', 'SAP_PASSWORD');
	await page.SAPLogin(process.env.SAP_USERNAME!, process.env.SAP_PASSWORD!, process.env.SAP_URL);
});
