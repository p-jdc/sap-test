// Records tasks in SAP's Fiori elements demo "Manage Products" (list report, object page, smart
// filter bar, value help) with the recorder in sap-plugin/recorder.ts, writes the spec the recorder
// would save, and runs that spec with Playwright as it is. The "user" is Playwright with stock
// locators, as in recorder-spike.spec.ts. Needs internet access (SAP's public demo kit).
import { test, expect, withSapMethods } from '../../sap-plugin';
import {
	installRecorder,
	recorderIdle,
	recorderReady,
	renderSpec
} from '../../sap-plugin/recorder';
import type { RecordedStep } from '../../sap-plugin/recorder';
import type { Locator, Page } from '../../sap-plugin';
import type { Browser, TestInfo } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const MANAGE_PRODUCTS =
	'https://ui5.sap.com/test-resources/sap/suite/ui/generic/template/demokit/sample.manage.products.sepmra/test/index.html#masterDetail-display';

async function clickLikeAPerson(page: Page, target: Locator) {
	await target.hover();
	await recorderIdle(page);
	await target.click();
}
const checkButton = (page: Page) =>
	page.locator('[data-sap-recorder]').getByRole('button', { name: 'Check' });
async function checkLikeAPerson(page: Page, target: Locator) {
	await checkButton(page).click();
	await clickLikeAPerson(page, target);
}

async function record(
	browser: Browser,
	testInfo: TestInfo,
	user: (page: Page) => Promise<void>
): Promise<{ steps: RecordedStep[]; spec: string }> {
	const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
	const recorded = await installRecorder(context);
	const page = withSapMethods(await context.newPage());
	await page.goto(MANAGE_PRODUCTS);
	await recorderReady(page);
	await page.waitForUI5();
	await user(page);
	for (const frame of page.frames()) await recorderIdle(frame);
	const steps = await recorded();
	await context.close();
	const spec = renderSpec(MANAGE_PRODUCTS, steps, '../../../sap-plugin', { name: testInfo.title });
	await testInfo.attach('recorded.spec.ts', { body: spec, contentType: 'text/plain' });
	console.log(spec);
	return { steps, spec };
}

// The written spec, run by Playwright as it is: what a person gets after closing the browser.
function runAsWritten(spec: string, testInfo: TestInfo) {
	const root = dirname(testInfo.config.configFile!);
	const folder = join(root, 'tests', '_plugin', `.recorded-${testInfo.testId}`);
	mkdirSync(folder, { recursive: true });
	const file = join(folder, 'recorded.spec.ts');
	writeFileSync(file, spec);
	// A folder of its own: a run empties its output folder first, which would take this run's.
	const output = mkdtempSync(join(tmpdir(), 'sap-recorded-run-'));
	try {
		const run = spawnSync(
			process.execPath,
			[
				join(root, '..', 'node_modules', '@playwright', 'test', 'cli.js'),
				'test',
				file,
				'--project=chromium',
				'--reporter=line',
				'--retries=0',
				`--output=${output}`
			],
			{ cwd: root, encoding: 'utf8', env: { ...process.env, CI: '' }, timeout: 180_000 }
		);
		const said = run.stdout + run.stderr;
		console.log(said);
		expect(run.status, said).toBe(0);
	} finally {
		rmSync(folder, { recursive: true, force: true });
		rmSync(output, { recursive: true, force: true });
	}
}

test.describe.configure({ timeout: 360_000 });
test.use({ actionTimeout: 30_000 });

test('list report to object page: search, open a product, check its price and supplier', async ({
	browser
}, testInfo) => {
	const { steps, spec } = await record(browser, testInfo, async (page) => {
		const search = page.getByRole('searchbox', { name: 'Search' });
		await clickLikeAPerson(page, search);
		await search.pressSequentially('HT-1030');
		await clickLikeAPerson(page, page.getByRole('button', { name: 'Go', exact: true }));
		await expect(page.getByRole('heading', { name: 'Products (1)' })).toBeVisible();
		await checkLikeAPerson(page, page.getByRole('heading', { name: 'Products (1)' }));
		// The product name is a link that opens nothing in this demo; the rest of the row opens it.
		await clickLikeAPerson(page, page.getByText('Computer Components', { exact: true }));
		await expect(page.getByRole('tab', { name: 'Supplier Information' })).toBeVisible();
		await checkLikeAPerson(page, page.getByText('230.00').filter({ visible: true }).first());
		await clickLikeAPerson(page, page.getByRole('tab', { name: 'Supplier Information' }));
		await checkLikeAPerson(
			page,
			page.getByText('Alpine Systems').filter({ visible: true }).first()
		);
	});
	expect(steps.filter((step) => !(step.selector || step.sid))).toEqual([]);
	// Fiori elements' IDs do not say what they find; the comment above the step does.
	expect(spec).toContain('// the "Search" field');
	expect(spec).toContain('// the "Go" button');
	expect(spec).toContain('// the "Supplier Information" icon tab filter');
	runAsWritten(spec, testInfo);
});

test('filter by supplier through the value help', async ({ browser }, testInfo) => {
	const { steps, spec } = await record(browser, testInfo, async (page) => {
		await clickLikeAPerson(page, page.getByRole('button', { name: /Show Value Help/ }).first());
		const dialog = page.getByRole('dialog', { name: 'Select Supplier' });
		await expect(dialog).toBeVisible();
		await clickLikeAPerson(page, dialog.getByText('Alpine Systems', { exact: true }));
		await clickLikeAPerson(page, dialog.getByRole('button', { name: 'Select' }));
		await clickLikeAPerson(page, page.getByRole('button', { name: 'Go', exact: true }));
		const result = page.getByRole('heading', { name: /^Products \(\d+\)$/ });
		await expect(result).not.toHaveText('Products (0)');
		await checkLikeAPerson(page, result);
		await checkLikeAPerson(page, page.getByText('Ergo Screen E-I (HT-1030)', { exact: true }));
	});
	expect(steps.filter((step) => !(step.selector || step.sid))).toEqual([]);
	// A value in the value help is found by its record, not by its place in the list.
	expect(spec).toContain(`bindingPath: { path: '/SEPMRA_C_PD_Supplier(\\'100000011\\')'`);
	expect(spec).toContain('// the "Show Value Help" icon of the "Supplier" field');
	runAsWritten(spec, testInfo);
});
