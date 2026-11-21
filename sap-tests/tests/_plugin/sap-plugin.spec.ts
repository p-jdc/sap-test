// Checks the SAP plugin itself (sap-plugin/): the ported selector engines, the page methods and
// the UI5 wait and model reads.
// The UI5 tests use SAP's public demo kit and need internet access; the SID tests use a stand-in
// page, because a real WebGUI needs a test system.
import { test, expect, fillSecret, signingIn, type Page } from '../../sap-plugin';
import { isInsecureHttp } from '../../sap-plugin/secure-url';

const TOOL_PAGE =
	'https://ui5.sap.com/test-resources/sap/tnt/demokit/toolpageapp/webapp/index.html';

// WebGUI marks each element with an `lsdata` attribute that carries its SID.
const WEBGUI_STAND_IN = `<!doctype html><html><body>
<input lsdata='{"0":"x","SID":"wnd[0]/usr/ctxtVBAK-VBELN"}' />
<input lsdata='{"SID":"wnd[0]/usr/ctxtVBAK-VBELN2"}' />
<input lsdata='{"SID":"wnd[1]/usr/txt[3]"}' />
<button lsdata='{"SID":"wnd[0]/tbar[1]/btn[8]"}' onclick="this.textContent='pressed'">Run</button>
</body></html>`;

// The NetWeaver login page as SAPLogin finds it: the "Required" marker is part of each name.
const LOGIN_STAND_IN = `<!doctype html><html><body>
<label>User <span>Required</span> <input id="user" /></label>
<label>Password <span>Required</span> <input id="password" type="password" /></label>
<button onclick="document.getElementById('sent').textContent =
	document.getElementById('user').value + ':' + document.getElementById('password').value">
	Log On <span>Emphasized</span>
</button>
<output id="sent"></output>
</body></html>`;

/** Names of the page's global functions that fillSecret hands values out through. */
const secretBindings = () => Object.keys(window).filter((key) => key.startsWith('__sapSecret_'));

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

test('pages of a context the test opens itself get the SAP methods too', async ({ browser }) => {
	const ownContext = await browser.newContext();
	const ownPage = await ownContext.newPage();
	await ownPage.setContent(WEBGUI_STAND_IN);
	await expect(ownPage.locateSID('wnd[0]/tbar[1]/btn[8]')).toBeVisible();
	await ownContext.close();

	// browser.newPage() opens a context of its own.
	const lonePage = await browser.newPage();
	await lonePage.setContent(WEBGUI_STAND_IN);
	await expect(lonePage.getByRoleSID('button', { pos: 8, sub: 'tbar[1]' })).toBeVisible();
	await lonePage.close();
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

test('fillSecret: types into a password field like fill, and takes its binding away again', async ({
	page
}) => {
	await page.setContent(LOGIN_STAND_IN);
	const password = page.locator('#password');
	await password.evaluate((el: HTMLInputElement) => {
		el.value = 'old';
		el.addEventListener(
			'input',
			() => (el.dataset.inputs = String(Number(el.dataset.inputs ?? 0) + 1))
		);
	});
	await fillSecret(password, 's3cr3t "pw"');
	await expect(password).toHaveValue('s3cr3t "pw"');
	await expect(password).toHaveAttribute('data-inputs', /^[1-9]/);
	expect(await page.evaluate(secretBindings)).toEqual([]);
});

test('fillSecret: refuses fields that would show the value in screenshots', async ({ page }) => {
	await page.setContent(LOGIN_STAND_IN);
	await expect(fillSecret(page.locator('#user'), 'secret')).rejects.toThrow(
		/only for password fields/
	);
	await expect(page.locator('#user')).toHaveValue('');
	expect(await page.evaluate(secretBindings)).toEqual([]);
});

test('fillSecret: refuses a page loaded over http from another computer', async ({ page }) => {
	for (const host of ['http://sap.test', 'http://app.localhost'])
		await page.route(`${host}/**`, (route) =>
			route.fulfill({ contentType: 'text/html', body: LOGIN_STAND_IN })
		);
	await page.goto('http://sap.test/login');
	await expect(fillSecret(page.locator('#password'), 'pw-123')).rejects.toThrow(
		'fillSecret: http://sap.test is not https://'
	);
	await expect(page.locator('#password')).toHaveValue('');
	// This computer may use http (a local mock or stand-in).
	await page.goto('http://app.localhost/login');
	await fillSecret(page.locator('#password'), 'pw-123');
	await expect(page.locator('#password')).toHaveValue('pw-123');
});

test('isInsecureHttp: only http to another computer', () => {
	const insecure = ['http://sap.example.com', 'http://10.0.0.5:8000', 'http://127.0.0.1.evil.test'];
	const fine = [
		'https://sap.example.com',
		'http://localhost:4999',
		'http://127.0.0.1',
		'http://[::1]:1',
		'about:blank'
	];
	expect(insecure.filter((url) => !isInsecureHttp(url))).toEqual([]);
	expect(fine.filter((url) => isInsecureHttp(url))).toEqual([]);
});

test('SAPLogin: logs in on a NetWeaver login page', async ({ page }) => {
	await page.setContent(LOGIN_STAND_IN);
	await page.SAPLogin('TESTUSER', 'pw-123');
	await expect(page.locator('#sent')).toHaveText('TESTUSER:pw-123');
});

/** A stand-in SAP system that shows `body` for every page; the context holds a session cookie. */
async function withSavedSession(page: Page, body: string) {
	await page.route('https://sap.test/**', (route) =>
		route.fulfill({ contentType: 'text/html', body })
	);
	await page
		.context()
		.addCookies([{ name: 'SAP_SESSIONID', value: 'ok', url: 'https://sap.test' }]);
}

test('SAPLogin: with a saved session it only opens the URL', async ({ page }) => {
	await withSavedSession(page, '<!doctype html><h1>Launchpad</h1>');
	await page.SAPLogin('TESTUSER', 'pw-123', 'https://sap.test/launchpad');
	await expect(page.getByRole('heading', { name: 'Launchpad' })).toBeVisible();
});

test('SAPLogin: an expired saved session fails instead of typing the password', async ({
	page
}) => {
	await withSavedSession(page, LOGIN_STAND_IN);
	await expect(page.SAPLogin('TESTUSER', 'pw-123', 'https://sap.test/')).rejects.toThrow(
		/saved SAP session is no longer valid/
	);
	await expect(page.locator('#password')).toHaveValue('');
});

test('signingIn: a failed sign-in leaves no password in the page', async ({ page }) => {
	await page.setContent(LOGIN_STAND_IN);
	await expect(
		signingIn(page, async () => {
			await fillSecret(page.locator('#password'), 'pw-123');
			throw new Error('login page did not go away');
		})
	).rejects.toThrow('login page did not go away');
	await expect(page.locator('#password')).toHaveValue('');
});

test('fillSecret: a UI5 password input takes the value as if typed', async ({ page }) => {
	await page.goto(TOOL_PAGE);
	await page.waitForUI5();
	// A sap.m.Input of type Password, like the one on the Fiori launchpad login, added to the demo app.
	await page.evaluate(`new Promise((done) => {
		const host = document.createElement('div');
		host.id = 'password-host';
		document.body.prepend(host);
		window.seen = {};
		sap.ui.require(['sap/m/Input'], (Input) => {
			new Input({
				type: 'Password',
				placeholder: 'Password stand-in',
				liveChange: (e) => (window.seen.liveChange = e.getParameter('value')),
				change: (e) => (window.seen.change = e.getParameter('value'))
			}).placeAt('password-host');
			done();
		});
	})`);
	await fillSecret(page.getByPlaceholder('Password stand-in'), 'Ui5-Secret');
	// Leaving the field fires UI5's change event, as clicking "Log On" does.
	await page.getByRoleUI5('Title', { text: 'Customer Overview' }, { exact: true }).click();
	expect(await page.evaluate(() => Reflect.get(window, 'seen'))).toEqual({
		liveChange: 'Ui5-Secret',
		change: 'Ui5-Secret'
	});
});
