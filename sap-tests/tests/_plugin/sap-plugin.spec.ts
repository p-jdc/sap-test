// Checks the SAP plugin itself (sap-plugin/): the ported selector engines, the page methods and
// the UI5 wait and model reads.
// The UI5 tests use SAP's public demo kit and need internet access; the SID tests use a stand-in
// page, because a real WebGUI needs a test system.
import { test, expect } from '../../sap-plugin';

const TOOL_PAGE =
	'https://ui5.sap.com/test-resources/sap/tnt/demokit/toolpageapp/webapp/index.html';

// WebGUI marks each element with an `lsdata` attribute that carries its SID.
const WEBGUI_STAND_IN = `<!doctype html><html><body>
<input lsdata='{"0":"x","SID":"wnd[0]/usr/ctxtVBAK-VBELN"}' />
<input lsdata='{"SID":"wnd[0]/usr/ctxtVBAK-VBELN2"}' />
<input lsdata='{"SID":"wnd[1]/usr/txt[3]"}' />
<button lsdata='{"SID":"wnd[0]/tbar[1]/btn[8]"}' onclick="this.textContent='pressed'">Run</button>
</body></html>`;

test('ui5role: code in the shape the fork recorder emits finds the controls', async ({ page }) => {
	await page.goto(TOOL_PAGE);
	await expect(
		page.getByRoleUI5('Title', { text: 'Customer Overview' }, { exact: true })
	).toBeVisible();
	// `text` matches as a case-insensitive substring: "statistics" finds three navigation items.
	await expect(page.getByRoleUI5('NavigationListItem', { text: 'statistics' })).toHaveCount(3);
	// With exact, only the whole, case-sensitive text matches.
	await expect(
		page.getByRoleUI5('NavigationListItem', { text: 'Statistics' }, { exact: true })
	).toHaveCount(1);
	await expect(
		page.getByRoleUI5('NavigationListItem', { text: 'statistics' }, { exact: true })
	).toHaveCount(0);
});

test('ui5role: several properties in one call must all match', async ({ page }) => {
	await page.goto(TOOL_PAGE);
	await page.getByRoleUI5('NavigationListItem', { text: 'Settings' }, { exact: true }).click();
	await expect(page.getByRoleUI5('Input', { value: 'John', type: 'Text' })).toHaveCount(1);
	await expect(page.getByRoleUI5('Input', { value: 'John', type: 'Email' })).toHaveCount(0);
});

test('ui5xpath: locateUI5 finds a control by its path in the UI5 control tree', async ({
	page
}) => {
	await page.goto(TOOL_PAGE);
	await expect(page.getByRoleUI5('Title', { text: 'Customer Overview' })).toBeVisible();
	await expect(page.locateUI5('//ToolPage//SideNavigation')).toHaveCount(1);
	await expect(page.locateUI5('//ToolPage//NoSuchControl')).toHaveCount(0);
});

test('ui5role: a page without UI5 reports that clearly', async ({ page }) => {
	await page.setContent('<button>Plain</button>');
	await expect(
		page.getByRoleUI5('Button', { text: 'Plain' }).click({ timeout: 2_000 })
	).rejects.toThrow(/SAP UI5 not found in page/);
});

test('sid: locateSID and getByRoleSID match the whole SID only', async ({ page }) => {
	await page.setContent(WEBGUI_STAND_IN);
	await expect(page.locateSID('wnd[0]/usr/ctxtVBAK-VBELN')).toHaveCount(1);
	await page.getByRoleSID('textField', { name: 'VBAK-VBELN' }).fill('4711');
	await expect(page.locateSID('wnd[0]/usr/ctxtVBAK-VBELN')).toHaveValue('4711');
	await expect(page.locateSID('wnd[0]/usr/ctxtVBAK-VBELN2')).toHaveValue('');

	await expect(page.getByRoleSID('text', { pos: 3, wnd: 1 })).toHaveCount(1);
	await page.getByRoleSID('button', { pos: 8, sub: 'tbar[1]' }).click();
	await expect(page.locateSID('wnd[0]/tbar[1]/btn[8]')).toHaveText('pressed');
	expect(() => page.getByRoleSID('noSuchRole', {})).toThrow(/Invalid SID role name/);
});

test('popups and new tabs get the SAP methods too', async ({ page, context }) => {
	await page.goto(TOOL_PAGE);
	const [popup] = await Promise.all([
		page.waitForEvent('popup'),
		page.evaluate((url) => void window.open(url), TOOL_PAGE)
	]);
	await expect(
		popup.getByRoleUI5('Title', { text: 'Customer Overview' }, { exact: true })
	).toBeVisible();

	const tab = await context.newPage();
	await tab.setContent(WEBGUI_STAND_IN);
	await expect(tab.locateSID('wnd[0]/tbar[1]/btn[8]')).toBeVisible();
});

// A worklist app on an OData V2 model, served by a mock server inside the page.
const WORKLIST_PAGE =
	'https://ui5.sap.com/test-resources/sap/m/demokit/tutorial/worklist/07/webapp/test/mockServer.html';

test('waitForUI5: after it, the page is loaded without any retrying', async ({ page }) => {
	await page.goto(WORKLIST_PAGE);
	await page.waitForUI5();
	// count() does not wait: the rows are only there if waitForUI5 waited for the data request.
	expect(await page.getByRoleUI5('ColumnListItem').count()).toBeGreaterThan(0);
});

test('waitForUI5: a page without UI5 reports that clearly', async ({ page }) => {
	await page.setContent('<button>Plain</button>');
	await expect(page.waitForUI5({ timeout: 1_000 })).rejects.toThrow(
		/UI5 did not come to rest within 1000 ms/
	);
});

test('model reads: what a table has loaded and what a row holds', async ({ page }) => {
	await page.goto(WORKLIST_PAGE);
	await page.waitForUI5();
	const table = page.getByRoleUI5('Table');
	const products = await page.ui5BoundData(table);
	expect(products.length).toBe(await page.getByRoleUI5('ColumnListItem').count());
	expect(products).toContainEqual(expect.objectContaining({ ProductName: 'Alice Mutton' }));

	// Relative path: read from the entity the row shows. Absolute path: from the model's root.
	const firstRow = page.getByRoleUI5('ColumnListItem').first();
	const productId = await page.ui5ModelProperty(firstRow, 'ProductID');
	expect(products[0]).toMatchObject({ ProductID: productId });
	expect(await page.ui5ModelProperty(table, `/Products(${String(productId)})/ProductName`)).toBe(
		await page.ui5ModelProperty(firstRow, 'ProductName')
	);
});

test('model reads: unsaved changes show as pending', async ({ page }) => {
	await page.goto(WORKLIST_PAGE);
	await page.waitForUI5();
	const table = page.getByRoleUI5('Table');
	expect(await page.ui5HasPendingChanges(table)).toBe(false);
	// Stands in for a user editing a field: the demo app has no editable form.
	await page.evaluate(`(() => {
		const row = document.querySelector('.sapMListTblRow');
		const model = sap.ui.require('sap/ui/core/Element').closestTo(row).getModel();
		model.setProperty('/' + Object.keys(model.getProperty('/'))[0] + '/UnitsInStock', 1);
	})()`);
	expect(await page.ui5HasPendingChanges(table)).toBe(true);
});

test('model reads: errors name what is missing', async ({ page }) => {
	await page.goto(TOOL_PAGE);
	await page.waitForUI5();
	const heading = page.getByRoleUI5('Title', { text: 'Customer Overview' }, { exact: true });
	await expect(page.ui5BoundData(heading, 'rows')).rejects.toThrow(/has "rows" bound to a model/);
	// The demo app's side navigation is bound to a JSON model named "side".
	const navigation = page.getByRoleUI5('NavigationListItem', { text: 'Home' });
	await expect(page.ui5HasPendingChanges(navigation, 'side')).rejects.toThrow(
		/does not track pending changes/
	);
	await expect(page.ui5ModelProperty(heading, 'name', 'noSuchModel')).rejects.toThrow(
		/no model "noSuchModel"/
	);
});
