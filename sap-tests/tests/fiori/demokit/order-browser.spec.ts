// KI-generiert, geprüft von: <Name>
// Covers SAP's public UI5 demo kit app "Order Browser" (mock server); needs internet access.
import { test, expect } from '../../../sap-plugin';
import { button, iconButton, title } from '../../../helpers/fiori';

const ORDER_BROWSER_URL =
	'https://ui5.sap.com/test-resources/sap/m/demokit/orderbrowser/webapp/test/mockServer.html?sap-ui-theme=sap_horizon_dark';

// Static mock data shipped with the demo (localService/mockdata), stable across reloads.
const ALL_ORDERS_TITLE = 'Orders (10)';
const CUSTOMER = 'Tortuga Restaurante';
const CUSTOMER_ORDERS_TITLE = 'Orders (2)';
const ORDER = 'Order 7918';
const OTHER_CUSTOMER_ORDER = 'Order 6858';
const LINE_ITEMS_TITLE = 'Line Items (4)';
const LINE_ITEM_COUNT = 4;
const PRODUCT = 'Aniseed Syrup';
const SHIP_STREET = 'Tottenham Court Road';
const SHIP_CITY = 'N170AA London';
const PROCESSOR = 'Jack Smith';
const GROUP_BY_CUSTOMER = 'Group by Customer';
const CUSTOMER_GROUP_COUNT = 5;

test.beforeEach(async ({ page }) => {
	await page.goto(ORDER_BROWSER_URL);
	await expect(title(page, ALL_ORDERS_TITLE)).toBeVisible();
});

test('demo kit: search orders by customer and open one to check header and line items', async ({
	page
}) => {
	const search = page.getByRoleUI5('SearchField');
	await search.fill(CUSTOMER);
	await search.press('Enter');
	await expect(title(page, CUSTOMER_ORDERS_TITLE)).toBeVisible();
	await expect(page.getByRoleUI5('ObjectListItem', { title: OTHER_CUSTOMER_ORDER })).toBeVisible();

	await page.getByRoleUI5('ObjectListItem', { title: ORDER }).click();
	await expect(page.getByRoleUI5('ObjectListItem', { selected: 'true' })).toContainText(ORDER);
	await expect(title(page, ORDER)).toBeVisible();
	await expect(page.getByRoleUI5('ObjectAttribute', { title: 'Customer' })).toContainText(CUSTOMER);
	await expect(title(page, LINE_ITEMS_TITLE)).toBeVisible();
	await expect(page.getByRoleUI5('ColumnListItem')).toHaveCount(LINE_ITEM_COUNT);
	await expect(page.getByRoleUI5('ObjectIdentifier', { title: PRODUCT })).toBeVisible();
});

test('demo kit: switch order detail from shipping address to processor information', async ({
	page
}) => {
	await page.getByRoleUI5('ObjectListItem', { title: ORDER }).click();
	await expect(title(page, ORDER)).toBeVisible();
	await expect(title(page, 'Shipping Address')).toBeVisible();
	await expect(page.getByRoleUI5('Text', { text: SHIP_STREET })).toBeVisible();
	await expect(page.getByRoleUI5('Text', { text: SHIP_CITY })).toBeVisible();

	await page.getByRoleUI5('IconTabFilter', { key: 'processor' }).click();
	await expect(title(page, 'Processor Information')).toBeVisible();
	await expect(page.getByRoleUI5('Text', { text: PROCESSOR })).toBeVisible();
	await expect(page.getByRoleUI5('Text', { text: SHIP_STREET })).toBeHidden();
});

test('demo kit: group the order list by customer', async ({ page }) => {
	await iconButton(page, 'sap-icon://group-2').click();
	await page.getByRoleUI5('StandardListItem', { title: GROUP_BY_CUSTOMER }).click();
	await button(page, 'OK').click();

	await expect(page.getByRoleUI5('Dialog')).toBeHidden();
	await expect(page.getByRoleUI5('GroupHeaderListItem')).toHaveCount(CUSTOMER_GROUP_COUNT);
	await expect(page.getByRoleUI5('GroupHeaderListItem', { title: CUSTOMER })).toBeVisible();
	await expect(title(page, ALL_ORDERS_TITLE)).toBeVisible();
});
