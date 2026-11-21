// Signs in to SAP once per run for the tests of the "sap" project (playwright.config.ts) and
// saves the session they start with. This project runs without a trace: the password typed here
// must not end up in one (see sap-plugin/session.ts).
import {
	test as setup,
	expect,
	clearSession,
	sapLoginPage,
	saveSession,
	signingIn
} from '../sap-plugin';
import { requireEnv } from '../helpers/env';

setup('sign in to SAP', async ({ page }) => {
	clearSession('sap');
	requireEnv('SAP_URL', 'SAP_USERNAME', 'SAP_PASSWORD');
	await signingIn(page, async () => {
		await page.SAPLogin(process.env.SAP_USERNAME!, process.env.SAP_PASSWORD!, process.env.SAP_URL);
		await expect(
			sapLoginPage(page),
			'Still on the login page: check SAP_USERNAME and SAP_PASSWORD'
		).toBeHidden();
	});
	await saveSession(page, 'sap');
});
