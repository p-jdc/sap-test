// KI-generiert, geprüft von: <Name>
// Covers SAP's public Fiori elements demo app "Manage Products" (list report / object page, mock server); needs internet access.
import { test, expect } from '@playwright/test';
import { button, title, typeInto } from '../../../helpers/fiori';

const MANAGE_PRODUCTS_URL =
	'https://ui5.sap.com/test-resources/sap/suite/ui/generic/template/demokit/sample.manage.products.sepmra/test/index.html?sap-ui-theme=sap_horizon_dark#masterDetail-display';

// Fiori elements apps in the sandbox launchpad take a while to start.
const APP_START_TIMEOUT = 60_000;

// Static mock data shipped with the demo (localService/mockdata), stable across reloads.
// The app is display-only: the product entity set is not creatable, updatable or deletable.
const PRODUCT_ID = 'HT-1030';
const PRODUCT_LINK = 'Ergo Screen E-I (HT-1030)';
const SEARCH_RESULT_TITLE = 'Products (1)';
const PRODUCT_PRICE = '230.00';
const PRODUCT_SUPPLIER = 'Alpine Systems';
const PRODUCT_CONTACT = 'Joseph Gschwandtner';
const CATEGORY = 'Printers & Scanners';
const CATEGORY_RESULT_TITLE = 'Products (13)';
const CATEGORY_PRODUCT_LINK = 'Laser Basic (HT-1041)';
const OTHER_CATEGORY_PRODUCT_LINK = 'Ergo Screen E-I (HT-1030)';

test.beforeEach(async ({ page }) => {
	await page.goto(MANAGE_PRODUCTS_URL);
	await expect(button(page, 'Go')).toBeVisible({ timeout: APP_START_TIMEOUT });
});

test('demo kit: search a product by ID in the list report', async ({ page }) => {
	await page.getByRoleUI5('SFBSearchField', { placeholder: 'Search' }).fill(PRODUCT_ID);
	await button(page, 'Go').click();
	await expect(title(page, SEARCH_RESULT_TITLE)).toBeVisible();
	await expect(page.getByRoleUI5('SmartLink', { text: PRODUCT_LINK })).toBeVisible();
});

test('demo kit: filter the list report by product category', async ({ page }) => {
	// The Category filter is the only SFBMultiInput in the filter bar and has no identifying
	// property; fill() does not reach its inner input.
	await typeInto(page.getByRoleUI5('SFBMultiInput'), CATEGORY);
	await button(page, 'Go').click();
	await expect(title(page, CATEGORY_RESULT_TITLE)).toBeVisible();
	await expect(page.getByRoleUI5('SmartLink', { text: CATEGORY_PRODUCT_LINK })).toBeVisible();
	await expect(page.getByRoleUI5('SmartLink', { text: OTHER_CATEGORY_PRODUCT_LINK })).toHaveCount(
		0
	);
});

test('demo kit: open a product from the list report and check its object page', async ({
	page
}) => {
	await page.getByRoleUI5('SFBSearchField', { placeholder: 'Search' }).fill(PRODUCT_ID);
	await button(page, 'Go').click();
	await expect(page.getByRoleUI5('SmartLink', { text: PRODUCT_LINK })).toBeVisible();
	// The search leaves exactly one row, and a row has no property to select it by.
	await page.getByRoleUI5('ColumnListItem').click();
	await expect(page.getByRoleUI5('ObjectPageLayout')).toBeVisible();
	await expect(page.getByRoleUI5('Text', { text: PRODUCT_ID }, { exact: true })).toBeVisible();
	await expect(page.getByRoleUI5('SmartField', { value: PRODUCT_PRICE })).toBeVisible();
	await page.getByRoleUI5('IconTabFilter', { text: 'Supplier Information' }).click();
	await expect(
		page.getByRoleUI5('ObjectPageSection', { title: 'Supplier Information' })
	).toBeVisible();
	await expect(page.getByRoleUI5('Text', { text: PRODUCT_SUPPLIER })).toBeVisible();
	await expect(page.getByRoleUI5('Text', { text: PRODUCT_CONTACT })).toBeVisible();
});
