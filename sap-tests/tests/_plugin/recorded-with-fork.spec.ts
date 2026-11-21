// Recorded with the Playwright-SAP 1.1.6 recorder (sap-tests/recorder) and left as recorded, apart from
// the import line (path, unused `expect` removed). It shows that recorder output replays on stock Playwright with sap-plugin.
import { test } from '../../sap-plugin';

test('test', async ({ page }) => {
	await page.goto(
		'https://ui5.sap.com/test-resources/sap/tnt/demokit/toolpageapp/webapp/index.html'
	);
	await page.getByRoleUI5('NavigationListItem', { text: 'Settings' }).click();
	await page.getByRoleUI5('Input', { value: 'John' }).click();
	await page.getByRoleUI5('Input', { value: 'John' }).press('ControlOrMeta+a');
	await page.getByRoleUI5('Input', { type: 'Text' }).first().fill('ane');
	await page.getByRoleUI5('ObjectPageHeaderActionButton', { text: 'Save' }).click();
	await page.getByRoleUI5('NavigationListItem', { text: 'Statistics' }).first().click();
	await page.getByRoleUI5('NavigationListItem', { text: 'Home' }).click();
});
