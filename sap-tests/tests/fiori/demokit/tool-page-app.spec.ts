// KI-generiert, geprüft von: <Name>
// Covers SAP's public UI5 demo kit app "Tool Page App" (sap.tnt ToolPage); needs internet access.
import { test, expect } from '@playwright/test';
import { iconButton, navItem, title } from '../../../helpers/fiori';

const URL =
	'https://ui5.sap.com/test-resources/sap/tnt/demokit/toolpageapp/webapp/index.html?sap-ui-theme=sap_horizon_dark';
const SIDE_NAV_TOGGLE_ICON = 'sap-icon://menu2';
const CURRENT_FIRST_NAME = 'John';
const NEW_FIRST_NAME = 'Jane';
const SAVE_TOAST = 'Save was clicked';

test('demo kit: open each main area via the side navigation', async ({ page }) => {
	await page.goto(URL);
	await expect(title(page, 'Customer Overview')).toBeVisible();

	await navItem(page, 'Settings').click();
	await expect(title(page, 'Edit Shop Owner')).toBeVisible();
	await expect(page).toHaveURL(/#\/masterSettings$/);

	await navItem(page, 'Statistics').click();
	await expect(title(page, 'Shopping Card Statistics')).toBeVisible();
	await expect(page).toHaveURL(/#\/statistics$/);

	await navItem(page, 'Usage Statistics').click();
	await expect(title(page, 'Usage Statistics')).toBeVisible();
	await expect(page).toHaveURL(/#\/usageStatistics$/);

	await navItem(page, 'Order Statistics').click();
	await expect(title(page, 'Order Statistics')).toBeVisible();
	await expect(page).toHaveURL(/#\/orderStatistics$/);

	await navItem(page, 'Home').click();
	await expect(title(page, 'Customer Overview')).toBeVisible();
});

test('demo kit: change the shop owner first name in the settings and save', async ({ page }) => {
	await page.goto(URL);
	await navItem(page, 'Settings').click();
	await expect(title(page, 'Edit Shop Owner')).toBeVisible();

	// The first-name Input has no label/name property, so it is found by its current value.
	await page.getByRoleUI5('Input', { value: CURRENT_FIRST_NAME }).fill(NEW_FIRST_NAME);
	await page.getByRoleUI5('ObjectPageHeaderActionButton', { text: 'Save' }).click();
	await expect(page.getByText(SAVE_TOAST)).toBeVisible();
	await expect(page.getByRoleUI5('Input', { value: NEW_FIRST_NAME })).toBeVisible();
});

test('demo kit: collapse the side navigation, open usage statistics from it and expand it again', async ({
	page
}) => {
	await page.goto(URL);
	const usageStatistics = navItem(page, 'Usage Statistics');
	await expect(usageStatistics).toBeVisible();

	await iconButton(page, SIDE_NAV_TOGGLE_ICON).click();
	await expect(usageStatistics).toBeHidden();

	// Collapsed, the parent item opens a popover that lists its sub-items.
	await navItem(page, 'Statistics').click();
	await usageStatistics.click();
	await expect(title(page, 'Usage Statistics')).toBeVisible();
	await expect(page).toHaveURL(/#\/usageStatistics$/);

	await iconButton(page, SIDE_NAV_TOGGLE_ICON).click();
	await expect(usageStatistics).toBeVisible();
});
