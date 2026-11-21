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
		if (step.action === 'click') await control.click();
		if (step.action === 'fill') await control.fill(step.value!);
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

	await replay(browser, cartDemo, steps, async (page) => {
		await expect(page.getByText('Total: 2,30 EUR')).toBeVisible();
		await expect(page.getByText('Notebook Lock - HT-1111')).toBeVisible();
	});
});

test('masked fields and a calendar day are recorded and replay', async ({ browser }, testInfo) => {
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
		await clickLikeAPerson(page, page.getByRole('gridcell').getByText('15', { exact: true }));
		await expect(byId(page, 'checkoutView--creditCardExpirationDate-inner')).not.toHaveValue('');

		await clickLikeAPerson(page, byId(page, 'checkoutView--creditCardStep-nextButton'));
		await expect(byId(page, 'checkoutView--invoiceStep')).toBeVisible();
	});

	const typed = steps.filter((step) => step.action === 'fill').map((step) => step.value);
	expect(typed).toEqual(['Screen clean', 'Jane Doe', '1234-5678-9012-3456', '123']);
	expect(needingALook(steps)).toEqual([]);

	await replay(browser, cartDemo, steps, async (page) => {
		await expect(byId(page, 'checkoutView--invoiceStep')).toBeVisible();
	});
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
