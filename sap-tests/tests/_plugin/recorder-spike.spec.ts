// SPIKE. Records flows in the UI5 shopping cart demo with the recorder in sap-plugin/recorder.ts
// and replays what it recorded in a fresh page. The "user" is Playwright itself, with stock
// locators: its input reaches the page like a person's, so the recorder sees real clicks and keys.
// Needs internet access (SAP's public demo kit).
import { test, expect, withSapMethods } from '../../sap-plugin';
import {
	installRecorder,
	recorderIdle,
	recorderReady,
	renderSpec,
	stepLocator
} from '../../sap-plugin/recorder';
import type { RecordedStep } from '../../sap-plugin/recorder';
import type { Locator, Page } from '../../sap-plugin';
import type { Browser, BrowserContext, Frame, TestInfo } from '@playwright/test';
import { chromium } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const CART = 'https://ui5.sap.com/test-resources/sap/m/demokit/cart/webapp/index.html';
const byId = (page: Page, id: string) => page.locator(`[id="container-cart---${id}"]`);

// A person rests on a control before clicking it, which is when the recorder describes it.
async function clickLikeAPerson(page: Page | Frame, target: Locator) {
	await target.hover();
	await recorderIdle(page);
	await target.click();
}

type Flow = {
	url: string;
	/** Pages served by the test itself, e.g. a WebGUI stand-in. */
	prepare?: (context: BrowserContext) => Promise<unknown>;
};
const cartDemo: Flow = { url: CART };

async function record(
	browser: Browser,
	testInfo: TestInfo,
	flow: Flow,
	user: (page: Page) => Promise<void>
): Promise<RecordedStep[]> {
	const context = await browser.newContext();
	await flow.prepare?.(context);
	const recorded = await installRecorder(context);
	const page = withSapMethods(await context.newPage());
	await page.goto(flow.url);
	await user(page);
	// The last step is reported once the recorder has described its control.
	for (const frame of page.frames()) await recorderIdle(frame);
	const steps = await recorded();
	await context.close();
	const spec = renderSpec(flow.url, steps, '../../sap-plugin');
	await testInfo.attach('recorded.spec.ts', { body: spec, contentType: 'text/plain' });
	console.log(spec);
	return steps;
}

async function replay(
	browser: Browser,
	flow: Flow,
	steps: RecordedStep[],
	verify: (page: Page) => Promise<void>
) {
	const context = await browser.newContext();
	await flow.prepare?.(context);
	const page = withSapMethods(await context.newPage());
	await page.goto(flow.url);
	for (const step of steps) {
		const control = stepLocator(page, step)!;
		if (step.action === 'click') await control.click({ force: step.force });
		if (step.action === 'fill') await control.fill(step.value!);
		if (step.action === 'fill' && step.picker) await control.blur();
		if (step.action === 'press') await control.press(step.key!);
	}
	await verify(page);
	await context.close();
}

// The recorder on a UI5 page starts once the app has rendered; a person starts later than that.
async function ui5Started(page: Page) {
	await recorderReady(page);
	await page.waitForUI5();
}

async function putScreenCleanInCart(page: Page) {
	await ui5Started(page);
	await page.getByRole('searchbox').fill('Screen clean');
	await page.getByRole('searchbox').press('Enter');
	await clickLikeAPerson(
		page,
		page.getByRole('region', { name: 'First column' }).getByText('Screen clean', { exact: true })
	);
	await clickLikeAPerson(page, page.getByRole('button', { name: 'Add to Cart' }));
	await clickLikeAPerson(
		page,
		page
			.getByRole('region', { name: 'Product Header' })
			.getByRole('button', { name: 'Show Shopping Cart' })
	);
	await expect(page.getByText('Total: 2,30 EUR')).toBeVisible();
}

const needingALook = (steps: RecordedStep[]) =>
	steps.filter((step) => step.problem || !(step.selector || step.sid));

test('a recorded cart flow replays through the recorded UI5 control selectors', async ({
	browser
}, testInfo) => {
	const steps = await record(browser, testInfo, cartDemo, async (page) => {
		await putScreenCleanInCart(page);
		// The same "Compare" link the fork could only describe by position.
		await clickLikeAPerson(page, page.getByRole('link', { name: 'Compare' }).nth(1));
		await expect(page.getByText('Notebook Lock - HT-1111')).toBeVisible();
	});

	expect(steps.map((step) => step.action)).toEqual([
		'fill',
		'press',
		'click',
		'click',
		'click',
		'click'
	]);
	expect(needingALook(steps)).toEqual([]);
	// The cart button is an icon on a button: the button is recorded, not its picture.
	const cartButton = steps[4]?.selector;
	expect(cartButton?.controlType).toBe('sap.m.ToggleButton');
	expect(JSON.stringify(steps)).not.toContain('sap.ui.core.Icon');

	await replay(browser, cartDemo, steps, async (page) => {
		await expect(page.getByText('Total: 2,30 EUR')).toBeVisible();
		await expect(page.getByText('Notebook Lock - HT-1111')).toBeVisible();
	});
});

test('masked fields and a calendar day are recorded and replay', async ({ browser }, testInfo) => {
	let picked = '';
	const steps = await record(browser, testInfo, cartDemo, async (page) => {
		await putScreenCleanInCart(page);
		await clickLikeAPerson(page, byId(page, 'cartView--proceedButton'));
		await clickLikeAPerson(page, byId(page, 'checkoutView--contentsStep-nextButton'));
		await clickLikeAPerson(page, byId(page, 'checkoutView--paymentTypeStep-nextButton'));

		const type = async (field: string, text: string, shown = text) => {
			const input = byId(page, `checkoutView--${field}-inner`);
			await clickLikeAPerson(page, input);
			// A masked field sets itself up a moment after it gets focus and loses keys typed
			// before that. A person would see it and type again; so does this.
			await expect(async () => {
				await input.press('ControlOrMeta+a');
				await input.press('Backspace');
				await input.pressSequentially(text, { delay: 40 });
				await expect(input).toHaveValue(shown, { timeout: 1_000 });
			}).toPass();
		};
		await type('creditCardHolderName', 'Jane Doe');
		// sap.m.MaskInput: sets its value itself, key by key.
		await type('creditCardNumber', '1234567890123456', '1234-5678-9012-3456');
		await type('creditCardSecurityNumber', '123');

		// The calendar's arrows and days are parts of controls, no controls of their own.
		await clickLikeAPerson(page, byId(page, 'checkoutView--creditCardExpirationDate-icon'));
		await clickLikeAPerson(page, page.getByRole('button', { name: 'Next Month' }));
		// A greyed-out day of the month after: UI5 marks it disabled and takes the click all the same.
		const otherMonth = page.locator('.sapUiCalItemOtherMonth[aria-disabled="true"]').last();
		await otherMonth.hover({ force: true });
		await recorderIdle(page);
		await otherMonth.click({ force: true });
		const date = byId(page, 'checkoutView--creditCardExpirationDate-inner');
		await expect(date).not.toHaveValue('');
		picked = await date.inputValue();

		await clickLikeAPerson(page, byId(page, 'checkoutView--creditCardStep-nextButton'));
		await expect(byId(page, 'checkoutView--invoiceStep')).toBeVisible();
	});

	const typed = steps.filter((step) => step.action === 'fill').map((step) => step.value);
	expect(typed).toEqual(['Screen clean', 'Jane Doe', '1234-5678-9012-3456', '123', picked]);
	expect(needingALook(steps)).toEqual([]);
	// The calendar: three clicks (icon, next month, day) and the value it put into the field. The
	// calendar sets the value before the click event of the day, so the fill comes before it.
	const picker = 'container-cart---checkoutView--creditCardExpirationDate';
	const inPicker = steps.filter((step) => step.picker === picker);
	expect(inPicker.map((step) => step.action)).toEqual(['click', 'click', 'fill', 'click']);
	// The spec fills in the date and has no clicks in the calendar, so it does not depend on the
	// day it runs.
	const spec = renderSpec(CART, steps, '../../sap-plugin');
	expect(spec).toContain(`.fill('${picked}')`);
	expect(spec).not.toContain('-cal');
	expect(spec).not.toContain('-icon');

	const written = steps.filter((step) => !(step.action === 'click' && step.picker === picker));
	await replay(browser, cartDemo, written, async (page) => {
		await expect(byId(page, 'checkoutView--invoiceStep')).toBeVisible();
		await expect(byId(page, 'checkoutView--creditCardExpirationDate-inner')).toHaveValue(picked);
	});
});

test('the written spec: title, login from the environment, no click before a fill', () => {
	const field = { id: 'app--name', interaction: { idSuffix: 'inner' } };
	const date = { id: 'app--date', interaction: { idSuffix: 'inner' } };
	const steps: RecordedStep[] = [
		{ seq: 1, action: 'click', selector: field },
		{ seq: 2, action: 'fill', selector: field, value: "O'Brien" },
		{ seq: 3, action: 'click', sid: 'wnd[0]/tbar[1]/btn[8]', frames: ['iframe[name="app"]'] },
		{
			seq: 4,
			action: 'click',
			selector: { id: 'app--cal', interaction: { idSuffix: '20261208' } },
			force: true
		},
		// A date picked in a calendar: only the value it put into the field is written.
		{ seq: 5, action: 'click', selector: { id: 'app--date-icon' }, picker: 'app--date' },
		{
			seq: 6,
			action: 'click',
			selector: { id: 'app--date-cal', interaction: { idSuffix: '20261208' } },
			force: true,
			picker: 'app--date'
		},
		{ seq: 7, action: 'fill', selector: date, value: 'Dec 8, 2026', picker: 'app--date' },
		// The calendar's last click arrives after the value it set.
		{ seq: 8, action: 'click', selector: { id: 'app--date-cal--Month0' }, picker: 'app--date' }
	];
	expect(
		renderSpec('https://sap.example.com/fiori', steps, '../../sap-plugin', {
			name: 'Create order',
			login: true,
			urlFromEnv: true
		})
	).toBe(
		[
			`import { test, locateSIDSelector } from '../../sap-plugin';`,
			``,
			`test('Create order', async ({ page }) => {`,
			`\tawait page.SAPLogin(process.env.SAP_USERNAME!, process.env.SAP_PASSWORD!, process.env.SAP_URL);`,
			`\tawait page.locateUI5Control({ id: 'app--name', interaction: { idSuffix: 'inner' } }).fill('O\\'Brien');`,
			`\tawait page.frameLocator('iframe[name="app"]').locator(locateSIDSelector('wnd[0]/tbar[1]/btn[8]')).click();`,
			`\tawait page.locateUI5Control({ id: 'app--cal', interaction: { idSuffix: '20261208' } }).click({ force: true });`,
			`\tawait page.locateUI5Control({ id: 'app--date', interaction: { idSuffix: 'inner' } }).fill('Dec 8, 2026');`,
			`\tawait page.locateUI5Control({ id: 'app--date', interaction: { idSuffix: 'inner' } }).blur();`,
			`});`,
			``
		].join('\n')
	);
	expect(renderSpec('https://x.test/', [], './sap-plugin')).toContain(
		`test('recorded', async ({ page }) => {\n\tawait page.goto('https://x.test/');`
	);
	// Another system of systems.json: the spec reads its own variables.
	expect(
		renderSpec('https://ewm.example.com/fiori', [], '../../sap-plugin', {
			login: true,
			urlFromEnv: true,
			env: { url: 'EWM_URL', user: 'EWM_USER', password: 'EWM_PASSWORD' }
		})
	).toContain(
		'await page.SAPLogin(process.env.EWM_USER!, process.env.EWM_PASSWORD!, process.env.EWM_URL);'
	);
});

// WebGUI marks each element with an `lsdata` attribute that carries its SID. A real WebGUI needs
// a test system, so this is a stand-in page, served by the test.
const WEBGUI_STAND_IN = `<!doctype html><html><body>
<label>Order <input lsdata='{"0":"x","SID":"wnd[0]/usr/ctxtVBAK-VBELN"}' /></label>
<span lsdata='{"SID":"wnd[0]/tbar[1]/btn[8]"}'><button onclick="this.textContent='pressed'">Run</button></span>
<p>No SID here</p>
</body></html>`;
const html = (body: string) => ({ contentType: 'text/html', body });
const webgui: Flow = {
	url: 'https://webgui.test/',
	prepare: (context) =>
		context.route('https://webgui.test/', (route) => route.fulfill(html(WEBGUI_STAND_IN)))
};

test('WebGUI stand-in: clicks and typing are recorded by SID and replay', async ({
	browser
}, testInfo) => {
	const steps = await record(browser, testInfo, webgui, async (page) => {
		await page.getByLabel('Order').click();
		await page.getByLabel('Order').pressSequentially('4711');
		// The button sits inside the element that carries the SID.
		await page.getByRole('button', { name: 'Run' }).click();
		// Without a SID nothing is recorded.
		await page.getByText('No SID here').click();
		await expect(page.getByRole('button')).toHaveText('pressed');
	});

	expect(steps.map((step) => [step.action, step.sid, step.value])).toEqual([
		['click', 'wnd[0]/usr/ctxtVBAK-VBELN', undefined],
		['fill', 'wnd[0]/usr/ctxtVBAK-VBELN', '4711'],
		['click', 'wnd[0]/tbar[1]/btn[8]', undefined]
	]);

	await replay(browser, webgui, steps, async (page) => {
		await expect(page.getByLabel('Order')).toHaveValue('4711');
		await expect(page.getByRole('button')).toHaveText('pressed');
	});
});

// Two pages of one flow. Each page is a document of its own and numbers its steps from 1.
const sidButton = (n: number) =>
	// oxlint-disable-next-line secure-coding/no-xpath-injection -- HTML of a stand-in page; the rule takes the SID path for XPath
	`<span lsdata='{"SID":"wnd[0]/usr/btn[${n}]"}'><button>Button ${n}</button></span>`;
const twoPages: Flow = {
	url: 'https://webgui.test/first',
	prepare: async (context) => {
		await context.route('https://webgui.test/first', (route) =>
			route.fulfill(
				html(`<!doctype html><html><body>${[1, 2, 3].map(sidButton).join('')}
<span lsdata='{"SID":"wnd[0]/usr/lnkNEXT"}'><a href="/second">Next page</a></span></body></html>`)
			)
		);
		await context.route('https://webgui.test/second', (route) =>
			route.fulfill(
				html(
					`<!doctype html><html><body><h1>Second</h1>${[4, 5].map(sidButton).join('')}</body></html>`
				)
			)
		);
	}
};

test('steps on a second page come after the steps on the first', async ({ browser }, testInfo) => {
	const steps = await record(browser, testInfo, twoPages, async (page) => {
		for (const n of [1, 2, 3]) await page.getByRole('button', { name: `Button ${n}` }).click();
		await page.getByRole('link', { name: 'Next page' }).click();
		await expect(page.getByRole('heading', { name: 'Second' })).toBeVisible();
		for (const n of [4, 5]) await page.getByRole('button', { name: `Button ${n}` }).click();
	});
	expect(steps.map((step) => step.sid)).toEqual([
		'wnd[0]/usr/btn[1]',
		'wnd[0]/usr/btn[2]',
		'wnd[0]/usr/btn[3]',
		'wnd[0]/usr/lnkNEXT',
		'wnd[0]/usr/btn[4]',
		'wnd[0]/usr/btn[5]'
	]);
});

test('what was typed into the last field is recorded when the recording ends there', async ({
	browser
}, testInfo) => {
	const steps = await record(browser, testInfo, webgui, async (page) => {
		await page.getByLabel('Order').click();
		// The cursor stays in the field: nobody clicks elsewhere before pressing Stop.
		await page.getByLabel('Order').pressSequentially('4711');
	});
	expect(steps.map((step) => [step.action, step.sid, step.value])).toEqual([
		['click', 'wnd[0]/usr/ctxtVBAK-VBELN', undefined],
		['fill', 'wnd[0]/usr/ctxtVBAK-VBELN', '4711']
	]);
});

const withPassword: Flow = {
	url: 'https://webgui.test/password',
	prepare: (context) =>
		context.route('https://webgui.test/password', (route) =>
			route.fulfill(
				html(`<!doctype html><html><body>
<label>User <input lsdata='{"SID":"wnd[0]/usr/txtUSER"}' /></label>
<label>New password <input type="password" lsdata='{"SID":"wnd[0]/usr/pwdNEW"}' /></label>
<button onclick="document.querySelector('[type=password]').type='text'">Show</button>
</body></html>`)
			)
		)
};

test('a typed password is not recorded, also after the field shows it', async ({
	browser
}, testInfo) => {
	const steps = await record(browser, testInfo, withPassword, async (page) => {
		await page.getByLabel('User').fill('TESTER');
		await page.getByLabel('New password').pressSequentially('Tr0ub4dor');
		// "Show password" turns the field into a text field while it has the focus.
		await page.getByRole('button', { name: 'Show' }).click();
		await page.getByLabel('New password').pressSequentially('&3');
		await page.getByLabel('User').click();
	});
	const fills = steps.filter((step) => step.action === 'fill');
	expect(fills.map((step) => [step.sid, step.value, step.secret])).toEqual([
		['wnd[0]/usr/txtUSER', 'TESTER', undefined],
		['wnd[0]/usr/pwdNEW', undefined, true],
		['wnd[0]/usr/pwdNEW', undefined, true]
	]);
	expect(JSON.stringify(steps)).not.toContain('Tr0ub4dor');
	const spec = renderSpec(withPassword.url, steps, '../../sap-plugin');
	expect(spec).not.toContain('Tr0ub4dor');
	expect(spec).toContain(
		`await fillSecret(page.locateSID('wnd[0]/usr/pwdNEW'), process.env.RECORDED_PASSWORD!);`
	);
	expect(spec).toContain(`import { test, fillSecret } from '../../sap-plugin';`);
});

test('the written spec stays valid code when a value or a hint has line breaks', () => {
	const spec = renderSpec(
		'https://x.test/',
		[
			{ seq: 1, action: 'fill', sid: 'wnd[0]/usr/txtNOTE', value: 'first line\r\nsecond third' },
			{ seq: 2, action: 'click', problem: 'no selector', hint: 'Save\n\tdraft' }
		],
		'../../sap-plugin'
	);
	expect(spec.split('\n')).toEqual([
		`import { test } from '../../sap-plugin';`,
		``,
		`test('recorded', async ({ page }) => {`,
		`\tawait page.goto('https://x.test/');`,
		`\tawait page.locateSID('wnd[0]/usr/txtNOTE').fill('first line\\r\\nsecond\\u2028third');`,
		`\t// FIXME: no selector (Save draft)`,
		`\t// click was not recorded`,
		`});`,
		``
	]);
});

// A launchpad shows WebGUI and some apps inside an iframe.
const shell = (source: string): Flow => ({
	url: 'https://shell.test/',
	prepare: async (context) => {
		await webgui.prepare?.(context);
		await context.route('https://shell.test/', (route) =>
			route.fulfill(
				html(`<!doctype html><html><body><h1>Shell</h1>
<iframe name="application" src="${source}" style="width:1200px;height:650px"></iframe></body></html>`)
			)
		);
	}
});

test('inside an iframe: WebGUI steps carry the frame and replay', async ({ browser }, testInfo) => {
	const framed = shell(webgui.url);
	const steps = await record(browser, testInfo, framed, async (page) => {
		const app = page.frameLocator('iframe');
		await app.getByLabel('Order').click();
		await app.getByLabel('Order').pressSequentially('4711');
		await app.getByRole('button', { name: 'Run' }).click();
		await expect(app.getByRole('button')).toHaveText('pressed');
	});

	expect(steps.map((step) => step.frames)).toEqual(
		Array.from({ length: 3 }, () => ['iframe[name="application"]'])
	);
	await replay(browser, framed, steps, async (page) => {
		await expect(page.frameLocator('iframe').getByRole('button')).toHaveText('pressed');
	});
});

test('inside an iframe: a UI5 app is recorded and replays', async ({ browser }, testInfo) => {
	const framed = shell(`${CART}#/category/AC`);
	const steps = await record(browser, testInfo, framed, async (page) => {
		const frame = page.frame({ name: 'application' })!;
		await recorderReady(frame);
		const compare = frame.getByRole('link', { name: 'Compare' }).nth(1);
		await clickLikeAPerson(frame, compare);
		await expect(frame.getByText(/ - HT-\d+/)).toBeVisible();
	});

	expect(steps.map((step) => [step.action, step.frames])).toEqual([
		['click', ['iframe[name="application"]']]
	]);
	expect(needingALook(steps)).toEqual([]);
	await replay(browser, framed, steps, async (page) => {
		await expect(page.frameLocator('iframe').getByText(/ - HT-\d+/)).toBeVisible();
	});
});

// A chart draws its bars as SVG shapes: no controls, no text. The recorder names a bar by the
// values it stands for, read from the record the chart library keeps on the shape.
const CHART = 'https://ui5.sap.com/test-resources/sap/viz/demokit/chartdemo/index.html';
const selectedInChart = (page: Page) =>
	page.evaluate(() =>
		[...document.querySelectorAll('.v-datapoint-selected')].map((shape) => {
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion, no-underscore-dangle -- D3's record on the shape, under D3's name
			const values = ('__data__' in shape ? shape.__data__ : {}) as Record<string, unknown>;
			return `${String(values['Item Category'])} / ${String(values.measureNames)}`;
		})
	);

test('a bar in a chart is recorded by the values it stands for and replays', async ({
	browser
}, testInfo) => {
	const steps = await record(browser, testInfo, { url: CHART }, async (page) => {
		await ui5Started(page);
		await expect(page.locator('.v-datapoint').first()).toBeVisible();
		// The first bar: profit for action movies.
		await clickLikeAPerson(page, page.locator('.v-datapoint').first());
		expect(await selectedInChart(page)).toEqual(['Action Movies / Profit']);
	});

	expect(needingALook(steps)).toEqual([]);
	expect(steps.map((step) => step.chartPoint)).toEqual([
		{ measureNames: 'Profit', 'Item Category': 'Action Movies' }
	]);
	expect(renderSpec(CHART, steps, '../../sap-plugin')).toContain(
		`.locator(ui5ChartPointSelector({ measureNames: 'Profit', 'Item Category': 'Action Movies' })).click();`
	);

	await replay(browser, { url: CHART }, steps, async (page) => {
		await expect.poll(() => selectedInChart(page)).toEqual(['Action Movies / Profit']);
	});
});

test('a point of a line chart is recorded by its values and replays', async ({
	browser
}, testInfo) => {
	const steps = await record(browser, testInfo, { url: CHART }, async (page) => {
		await ui5Started(page);
		await expect(page.locator('.v-datapoint').first()).toBeVisible();
		await clickLikeAPerson(page, page.locator('[id$="--select-arrow"]'));
		await clickLikeAPerson(page, page.getByRole('option', { name: 'Line', exact: true }));
		await page.waitForUI5();
		await expect(page.locator('.v-datapoint').first()).toBeVisible();
		await clickLikeAPerson(page, page.locator('.v-datapoint').nth(2));
		await expect.poll(() => selectedInChart(page)).toHaveLength(1);
	});

	expect(needingALook(steps)).toEqual([]);
	const point = steps.at(-1)?.chartPoint;
	expect(point).toBeDefined();

	await replay(browser, { url: CHART }, steps, async (page) => {
		await expect
			.poll(() => selectedInChart(page))
			.toEqual([`${point?.['Item Category']} / ${point?.measureNames}`]);
	});
});

// SAP's date picker sample. Its first field has no value at the start.
const DATE_PICKER =
	'https://ui5.sap.com/resources/sap/ui/documentation/sdk/index.html?sap-ui-xx-sample-id=sap.m.sample.DatePicker&sap-ui-xx-sample-lib=sap.m&sap-ui-xx-sample-origin=.&sap-ui-xx-dk-origin=https://ui5.sap.com';
const firstDateField = (page: Page) => page.locator('[id$="--DP1-inner"]');

/** Opens the first field's calendar, picks `day` of the month shown and returns the new value. */
async function pickDay(page: Page, day: string) {
	await clickLikeAPerson(page, page.locator('[id$="--DP1-icon"]'));
	await clickLikeAPerson(
		page,
		page.locator('.sapUiCalItem:not(.sapUiCalItemOtherMonth)').getByText(day, { exact: true })
	);
	await expect(page.locator('[id$="--DP1-RP-popover"]')).toBeHidden();
	return firstDateField(page).inputValue();
}

// What a test does to the page itself, through UI5: draw the view of the first field again, or
// set the field to another day of its month, as the app would.
type Ui5Page = { sap: { ui: { require(name: string): unknown } } };
const actOnPage = (page: Page, act: 'redraw' | 'setDate') =>
	page.evaluate((what) => {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- UI5's loader is a global of the page
		const ui5 = (window as unknown as Ui5Page).sap.ui;
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- sap/ui/core/Element
		const elements = ui5.require('sap/ui/core/Element') as {
			getElementById(id: string): {
				invalidate(): void;
				getDateValue(): Date | null;
				setDateValue(date: Date): void;
			};
		};
		const picker = document.querySelector('[id$="--DP1"]');
		if (!picker) throw new Error('date field not found');
		const field = elements.getElementById(picker.id);
		// The 20th of the month the field shows, so its calendar opens on that month.
		const shown = field.getDateValue() ?? new Date();
		if (what === 'setDate') field.setDateValue(new Date(shown.getFullYear(), shown.getMonth(), 20));
		else elements.getElementById(picker.closest('.sapUiView')!.id).invalidate();
	}, act);

test('every date picked is recorded: after the view is drawn again and after a cancelled pick', async ({
	browser
}, testInfo) => {
	const picked: string[] = [];
	const steps = await record(browser, testInfo, { url: DATE_PICKER }, async (page) => {
		await ui5Started(page);
		picked.push(await pickDay(page, '10'));

		// The view is drawn again: the field gets a new input element, the control stays.
		await firstDateField(page).evaluate((input) => input.setAttribute('data-drawn-before', ''));
		await actOnPage(page, 'redraw');
		await page.waitForUI5();
		await expect(firstDateField(page)).not.toHaveAttribute('data-drawn-before');
		picked.push(await pickDay(page, '12'));

		// The calendar opened and closed without a pick, then the app sets another date itself.
		await clickLikeAPerson(page, page.locator('[id$="--DP1-icon"]'));
		await page.keyboard.press('Escape');
		await expect(page.locator('[id$="--DP1-RP-popover"]')).toBeHidden();
		// Not while the field has the focus: whatever changes in a focused field counts as typed.
		await firstDateField(page).blur();
		await actOnPage(page, 'setDate');
		// The user picks the date from before again: a change of the field, so a step.
		picked.push(await pickDay(page, '12'));
	});

	expect(picked[0]).not.toBe(picked[1]);
	expect(picked[2]).toBe(picked[1]);
	const fills = steps.filter((step) => step.action === 'fill');
	expect(fills.map((step) => step.value)).toEqual(picked);
	expect(fills.every((step) => step.picker?.endsWith('--DP1'))).toBe(true);
	expect(needingALook(steps)).toEqual([]);
	const spec = renderSpec(DATE_PICKER, steps, '../../sap-plugin');
	expect(spec).not.toContain('-cal');
	expect(spec).not.toContain('-icon');
	expect(spec).not.toContain(`press('Enter')`);

	const written = steps.filter((step) => !(step.action === 'click' && step.picker));
	await replay(browser, { url: DATE_PICKER }, written, async (page) => {
		await expect(firstDateField(page)).toHaveValue(picked[1] ?? '');
	});
});

const freePort = () =>
	new Promise<number>((done) => {
		const server = createServer().listen(0, '127.0.0.1', () => {
			const address = server.address();
			server.close(() => done(typeof address === 'object' && address ? address.port : 0));
		});
	});

// The command itself, as the app and `bun run record` start it: a step is recorded, the process is
// asked to stop, and the file it leaves must pass the project's format check as it is.
test('the recorder command writes the spec in the project format', async () => {
	const root = dirname(test.info().config.configFile!);
	const folder = mkdtempSync(join(tmpdir(), 'sap-record-'));
	const output = join(folder, 'cli.spec.ts');
	const port = await freePort();
	const recorder = spawn(process.execPath, ['sap-plugin/record.mjs', CART, output], {
		cwd: root,
		env: { ...process.env, SAP_RECORD_HEADLESS: '1', SAP_RECORD_DEBUG_PORT: String(port) },
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let said = '';
	for (const stream of [recorder.stdout, recorder.stderr])
		stream.on('data', (chunk: Buffer) => (said += chunk.toString()));
	try {
		let page: Page | undefined;
		await expect(async () => {
			const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
			// The browser also holds an empty tab of its own; the recorder's is the one on the demo.
			page = browser
				.contexts()
				.flatMap((context) => context.pages())
				.find((candidate) => candidate.url().startsWith(CART));
			expect(page).toBeDefined();
		}).toPass();
		// A hidden browser window is small, and the demo then hides its search field.
		await page!.setViewportSize({ width: 1280, height: 800 });
		const app = withSapMethods(page!);
		await ui5Started(app);
		await app.getByRole('searchbox').fill('Screen clean');
		await app.getByRole('searchbox').press('Enter');
		await recorderIdle(app);
		recorder.kill('SIGTERM');
		const [code] = await once(recorder, 'exit');
		expect(code, said).toBe(0);

		const spec = readFileSync(output, 'utf8');
		expect(spec).toContain(`.fill('Screen clean')`);
		const check = spawnSync(
			process.execPath,
			[join(root, '..', 'node_modules/oxfmt/bin/oxfmt'), '--check', output],
			{ cwd: join(root, '..'), encoding: 'utf8' }
		);
		expect(check.stdout + check.stderr).toContain('All matched files use the correct format');
		expect(check.status).toBe(0);
	} finally {
		recorder.kill('SIGKILL');
		rmSync(folder, { recursive: true, force: true });
	}
});
