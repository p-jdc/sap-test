// KI-generiert, geprüft von: <Name>
// Covers SAP's public UI5 demo kit app "Shopping Cart" (sap.m cart demo); needs internet access.
import { test, expect } from '../../../sap-plugin';
import { button, iconButton, title } from '../../../helpers/fiori';
import { openCart } from '../../../helpers/cart-demo';

const URL =
	'https://ui5.sap.com/test-resources/sap/m/demokit/cart/webapp/index.html?sap-ui-theme=sap_horizon_dark';
const CATEGORY = 'Laptops';
const PRODUCT = 'Notebook Basic 17';
const TOTAL_EMPTY = 'Total: 0,00 EUR';
const TOTAL_ONE = 'Total: 1.249,00 EUR';
const TOTAL_TWO = 'Total: 2.498,00 EUR';
const SEARCH_TERM = 'Notebook';
const SEARCH_HIT = 'Notebook Lock';
const SEARCH_HIT_TOTAL = 'Total: 6,90 EUR';
const EDIT_CART_ICON = 'sap-icon://edit';
const DELETE_ITEM_ICON = 'sap-icon://decline';

test('demo kit: browse a category, add a product twice and check quantity and total in the cart', async ({
	page
}) => {
	await page.goto(URL);
	await page.getByRoleUI5('StandardListItem', { title: CATEGORY }).click();
	await expect(page.getByRoleUI5('Page', { title: CATEGORY })).toBeVisible();

	// The product title text opens the detail page; ObjectListItem itself resolves to its "Compare" link.
	await page.getByRoleUI5('Text', { text: PRODUCT }).click();
	await expect(page.getByRoleUI5('ObjectHeader', { title: PRODUCT })).toBeVisible();

	await openCart(page);
	await expect(page.getByRoleUI5('Text', { text: TOTAL_EMPTY })).toBeVisible();

	await button(page, 'Add to Cart').click();
	await expect(page.getByRoleUI5('ObjectListItem', { intro: '1 x' })).toBeVisible();
	await expect(page.getByRoleUI5('Text', { text: TOTAL_ONE })).toBeVisible();

	await button(page, 'Add to Cart').click();
	await expect(page.getByRoleUI5('ObjectListItem', { intro: '2 x' })).toBeVisible();
	await expect(page.getByRoleUI5('Text', { text: TOTAL_TWO })).toBeVisible();
});

test('demo kit: search a product, add it to the cart and start the checkout', async ({ page }) => {
	await page.goto(URL);
	await expect(page.getByRoleUI5('StandardListItem', { title: CATEGORY })).toBeVisible();

	const search = page.getByRoleUI5('SearchField', { placeholder: 'Search' });
	await search.fill(SEARCH_TERM);
	await search.press('Enter');
	await expect(page.getByRoleUI5('ObjectListItem', { title: SEARCH_HIT })).toBeVisible();
	await expect(page.getByRoleUI5('StandardListItem', { title: CATEGORY })).toBeHidden();

	await page.getByRoleUI5('Text', { text: SEARCH_HIT }).click();
	await expect(page.getByRoleUI5('ObjectHeader', { title: SEARCH_HIT })).toBeVisible();

	await openCart(page);
	await button(page, 'Add to Cart').click();
	await expect(page.getByRoleUI5('ObjectListItem', { intro: '1 x' })).toBeVisible();
	await expect(page.getByRoleUI5('Text', { text: SEARCH_HIT_TOTAL })).toBeVisible();

	await button(page, 'Proceed').click();
	await expect(page.getByRoleUI5('Page', { title: 'Checkout' })).toBeVisible();
	await expect(page.getByRoleUI5('WizardStep', { title: 'Items' })).toBeVisible();
	// Catalog and cart views stay in the DOM and are still visible while the page slides in,
	// so wait until only the checkout's entry and total are left on screen.
	await expect(
		page.getByRoleUI5('ObjectListItem', { title: SEARCH_HIT }).filter({ visible: true })
	).toHaveCount(1);
	await expect(
		page.getByRoleUI5('Text', { text: SEARCH_HIT_TOTAL }).filter({ visible: true })
	).toHaveCount(1);
});

test('demo kit: remove a product from the cart in edit mode', async ({ page }) => {
	await page.goto(URL);
	await page.getByRoleUI5('StandardListItem', { title: CATEGORY }).click();
	await page.getByRoleUI5('Text', { text: PRODUCT }).click();
	await expect(page.getByRoleUI5('ObjectHeader', { title: PRODUCT })).toBeVisible();

	await openCart(page);
	await button(page, 'Add to Cart').click();
	await expect(page.getByRoleUI5('ObjectListItem', { intro: '1 x' })).toBeVisible();
	await expect(page.getByRoleUI5('Text', { text: TOTAL_ONE })).toBeVisible();

	await iconButton(page, EDIT_CART_ICON).click();
	await expect(title(page, 'Edit Cart')).toBeVisible();
	await iconButton(page, DELETE_ITEM_ICON).click();
	await expect(page.getByRoleUI5('Dialog', { title: 'Confirmation' })).toBeVisible();
	await button(page, 'Delete').click();
	await expect(page.getByRoleUI5('ObjectListItem', { intro: '1 x' })).toBeHidden();
	await expect(page.getByRoleUI5('Text', { text: TOTAL_EMPTY })).toBeVisible();

	await button(page, 'Save Changes').click();
	await expect(title(page, 'Shopping Cart')).toBeVisible();
	await expect(page.getByRoleUI5('ObjectListItem', { intro: '1 x' })).toBeHidden();
	await expect(button(page, 'Proceed')).toBeDisabled();
});
