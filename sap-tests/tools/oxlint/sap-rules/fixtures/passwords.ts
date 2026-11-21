// Read by tests/_plugin/lint-rules.spec.ts, which lints this file and compares the findings with
// the `expect:` comments. Not a test and never run.
import { fillSecret, test } from '../../../../sap-plugin';

const password = process.env.SAP_PASSWORD!;

test('fixture', async ({ page }) => {
	await page.getByLabel('Password').fill(password); // expect: sap(no-secret-fill)
	await page.getByRole('textbox', { name: 'Kennwort' }).fill('x'); // expect: sap(no-secret-fill)
	await page.getByLabel('Sign in').fill(process.env.SAP_PASSWORD!); // expect: sap(no-secret-fill)
	await page.getByLabel('Passwort').pressSequentially(password); // expect: sap(no-secret-fill)
	await page.getByLabel('PIN').type(password); // expect: sap(no-secret-fill)

	await fillSecret(page.getByLabel('Password'), 'Welcome1'); // expect: sap(no-literal-secret)
	await page.SAPLogin('TESTER', 'Wel' + 'come1', process.env.SAP_URL); // expect: sap(no-literal-secret)

	// Not findings.
	await fillSecret(page.getByLabel('Password'), password);
	await page.SAPLogin(process.env.SAP_USERNAME!, process.env.SAP_PASSWORD!, process.env.SAP_URL);
	await page.getByLabel('Passenger').fill('Miller');
	await page.getByLabel('Search').fill('secret santa');
	await page.getByLabel('Customer').fill(process.env.SAP_USERNAME!);
	await page.getByLabel('Password').click();
});
