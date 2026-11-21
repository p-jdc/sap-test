// Example of what the Test-App's rule check flags (guide §5.2). test.fixme keeps it from running.
// Delete once the team knows the rules.
import { test } from '../../sap-plugin';

test.fixme('example: rule findings', async ({ page }) => {
	await page.SAPLogin(process.env.SAP_USERNAME!, process.env.SAP_PASSWORD!, process.env.SAP_URL);
	await page.locator('#__button3-inner').click();
	await page.getByRoleUI5('Input', { label: 'Sold-To Party', value: '' }).fill('1000');
	await page.waitForTimeout(3000);
	await page.getByRoleUI5('Button', { text: 'Save' }).click();
});
