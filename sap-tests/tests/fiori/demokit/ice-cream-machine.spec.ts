// KI-generiert, geprüft von: <Name>
// Covers SAP's public UI5 demo kit app "Ice Cream Machine" (sap.suite.ui.commons); needs internet access.
import { test, expect } from '@playwright/test';
import { button, iconButton, tile, typeInto } from '../../../helpers/fiori';

const APP_URL =
	'https://ui5.sap.com/test-resources/sap/suite/ui/commons/demokit/icecream/webapp/index.html?sap-ui-theme=sap_horizon_dark';

const PRODUCTION_TILE = 'Production Process';
const KEY_FIGURES_HEADER = 'Key Figures for 2025';
const PROCESS_FLOW_PANEL = 'Complete Process Flow';
const PROCESS_LANES = ['Order', 'Manufacturing', 'Assembly', 'Marketing', 'Delivery', 'Payment'];
const AT_RISK_NODE = 'Assembly: Final';
const AT_RISK_STATE = 'At risk';

const REVIEWS_TILE = 'User Reviews';
const REVIEWS_PAGE = 'Customer Reviews';
const NAME_PLACEHOLDER = 'Your name';
const REVIEW_PLACEHOLDER = 'Write your review here';
const REVIEWER_NAME = 'Playwright Tester';
const REVIEW_TEXT = 'Creamy, cold and served in seconds.';

const QUALITY_TILE = 'Quality Control';
const TEMPERATURE_CHART = 'Ice Cream Temperature Comparison in °F';
const TABLE_VIEW_ICON = 'sap-icon://table-chart';
const TABLE_COLUMNS = ['Ice Cream ID', 'Temperature', 'Target Temperature'];
const ICE_CREAM_FLAVOURS = 8;
const FIRST_FLAVOUR = 'Chocolate';

test('demo kit: open production process and inspect an at-risk process flow node', async ({
	page
}) => {
	await page.goto(APP_URL);
	await tile(page, PRODUCTION_TILE).click();

	await expect(page.getByRoleUI5('Page', { title: PRODUCTION_TILE })).toBeVisible();
	await expect(page.getByRoleUI5('ObjectHeader', { title: KEY_FIGURES_HEADER })).toBeVisible();
	await expect(page.getByRoleUI5('Panel', { headerText: PROCESS_FLOW_PANEL })).toBeVisible();
	for (const lane of PROCESS_LANES) {
		await expect(page.getByRoleUI5('ProcessFlowLaneHeader', { text: lane })).toBeVisible();
	}

	const node = page.getByRoleUI5('ProcessFlowNode', { title: AT_RISK_NODE });
	await expect(node).toBeVisible();
	await expect(node).toContainText(AT_RISK_STATE);
	await node.click();
	await expect(page.getByText(`The node "${AT_RISK_NODE}" is clicked`)).toBeVisible();
});

test('demo kit: submit a customer review and see it in the timeline', async ({ page }) => {
	await page.goto(APP_URL);
	await tile(page, REVIEWS_TILE).click();
	await expect(page.getByRoleUI5('Page', { title: REVIEWS_PAGE })).toBeVisible();

	await page.getByRoleUI5('Input', { placeholder: NAME_PLACEHOLDER }).fill(REVIEWER_NAME);
	// fill() is refused here: the fork resolves TextArea to its wrapper <div>.
	await typeInto(page.getByRoleUI5('TextArea', { placeholder: REVIEW_PLACEHOLDER }), REVIEW_TEXT);
	await button(page, 'Submit').click();

	const newReview = page.getByRoleUI5('TimelineItem', { title: REVIEWER_NAME });
	await expect(newReview).toBeVisible();
	await expect(newReview).toContainText(REVIEW_TEXT);
	await expect(page.getByRoleUI5('Input', { placeholder: NAME_PLACEHOLDER })).toHaveValue('');
});

test('demo kit: switch quality control temperatures from chart to table view', async ({ page }) => {
	await page.goto(APP_URL);
	await tile(page, QUALITY_TILE).click();

	await expect(page.getByRoleUI5('Page', { title: QUALITY_TILE })).toBeVisible();
	await expect(page.getByRoleUI5('ChartContainer', { title: TEMPERATURE_CHART })).toBeVisible();
	await expect(page.getByRoleUI5('VizFrame')).toBeVisible();

	await iconButton(page, TABLE_VIEW_ICON).click();

	await expect(page.getByRoleUI5('Table')).toBeVisible();
	for (const column of TABLE_COLUMNS) {
		await expect(page.getByRoleUI5('Text', { text: column }, { exact: true })).toBeVisible();
	}
	await expect(page.getByRoleUI5('ColumnListItem')).toHaveCount(ICE_CREAM_FLAVOURS);
	await expect(page.getByRoleUI5('ColumnListItem').first()).toContainText(FIRST_FLAVOUR);
	await expect(page.getByRoleUI5('VizFrame')).toBeHidden();
});
