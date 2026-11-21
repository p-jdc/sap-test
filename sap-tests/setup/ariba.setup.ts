// Signs in to Ariba once per run for the tests of the "ariba" project (playwright.config.ts) and
// saves the session they start with. This project runs without a trace: the password typed here
// must not end up in one (see sap-plugin/session.ts).
import {
	test as setup,
	expect,
	clearSession,
	fillSecret,
	saveSession,
	signingIn
} from '../sap-plugin';
import { requireEnv } from '../helpers/env';

setup('sign in to Ariba', async ({ page }) => {
	clearSession('ariba');
	requireEnv('ARIBA_URL', 'ARIBA_USER', 'ARIBA_PASS');
	await signingIn(page, async () => {
		await page.goto(process.env.ARIBA_URL!);
		await page.getByLabel('User Name').fill(process.env.ARIBA_USER!);
		const password = page.getByLabel('Password');
		await fillSecret(password, process.env.ARIBA_PASS!);
		await page.getByRole('button', { name: 'Login' }).click();
		await expect(password, 'Still on the login page: check ARIBA_USER and ARIBA_PASS').toBeHidden();
	});
	await saveSession(page, 'ariba');
});
