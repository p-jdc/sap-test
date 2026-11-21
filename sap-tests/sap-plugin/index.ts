// SAP locators on stock Playwright. Specs import `test` and `expect` from here instead of
// '@playwright/test' and keep calling page.getByRoleUI5 / locateUI5 / locateSID / getByRoleSID /
// SAPLogin exactly as with the Playwright-SAP fork, so code recorded with the fork's codegen runs
// unchanged. The selector strings and the login flow follow the fork's client code
// (packages/playwright-core/src/utils/isomorphic/sap/locatorUtils.ts and client/page.ts,
// Apache-2.0, Copyright Arpit Sureka). waitForUI5 and the ui5* model reads (ui5.ts) are our own
// additions; the fork has no counterpart.
import { existsSync } from 'node:fs';
import { test as base, expect, selectors } from '@playwright/test';
import type { BrowserContext, Locator, Page, Response } from '@playwright/test';
import { ENGINES, ENGINE_NAMES, engineSource } from './engines';
import { fillSecret } from './secret';
import { sessionFile, type SapSession } from './session';
import { ui5BoundData, ui5HasPendingChanges, ui5ModelProperty, waitForUI5 } from './ui5';
import type { WaitForUI5Options } from './ui5';
import { sidPrefixMapping } from './vendor/playwright-sap/isomorphic/sidPrefixMapping';

export type ByRoleUI5Properties = Record<string, string>;
export type ByRoleUI5Options = { exact?: boolean };
export type ByRoleSIDOptions = { name?: string; pos?: number; wnd?: number; sub?: string };

export interface SapPageMethods {
	/** A UI5 control by its type (last part of the class name) and property values. */
	getByRoleUI5(role: string, properties?: ByRoleUI5Properties, options?: ByRoleUI5Options): Locator;
	/** A UI5 control by an XPath over the UI5 control tree. */
	locateUI5(xpath: string): Locator;
	/** A WebGUI element by its full SID path, e.g. `wnd[0]/tbar[1]/btn[8]`. */
	locateSID(sid: string): Locator;
	/** A WebGUI element by role and name or position, e.g. `('textField', { name: 'VBAK-VBELN' })`. */
	getByRoleSID(role: string, options: ByRoleSIDOptions): Locator;
	/**
	 * Logs in on a Fiori launchpad or NetWeaver login page. When the test starts with a saved
	 * session (the SAP projects, see session.ts), it only opens `url` and types nothing; a login
	 * page there means the session has expired, which fails the test.
	 */
	SAPLogin(username: string, password: string, url?: string): Promise<Response | null>;
	/**
	 * Waits until UI5 has rendered and is at rest (no open request, timer or rendering). For state
	 * that does not retry, such as the model reads below; clicks and `expect` wait on their own.
	 */
	waitForUI5(options?: WaitForUI5Options): Promise<void>;
	/** The entries a list or table has loaded from its model ('items', or 'rows' for sap.ui.table). */
	ui5BoundData(control: Locator, aggregation?: string): Promise<unknown[]>;
	/** A model value: '/absolute' from the model's root, otherwise relative to the control's entity. */
	ui5ModelProperty(control: Locator, path: string, model?: string): Promise<unknown>;
	/** Whether the control's OData model holds changes that are not saved yet. */
	ui5HasPendingChanges(control: Locator, model?: string): Promise<boolean>;
}

declare module 'playwright-core' {
	// oxlint-disable-next-line no-shadow -- declaration merging: this extends Playwright's Page
	interface Page extends SapPageMethods {}
}

// Same escaping as Playwright's escapeForAttributeSelector: `s` = exact, `i` = case-insensitive.
const attributeValue = (value: string, exact: boolean) =>
	`"${value.replace(/\\/g, '\\\\').replace(/["]/g, '\\"')}"${exact ? 's' : 'i'}`;

export function getByRoleUI5Selector(
	role: string,
	properties: ByRoleUI5Properties = {},
	options: ByRoleUI5Options = {}
): string {
	const attributes = Object.entries(properties).map(
		([key, value]) => `[${key}=${attributeValue(value, !!options.exact)}]`
	);
	return `${ENGINES.ui5role}=${role}${attributes.join('')}`;
}

export const locateUI5Selector = (xpath: string) => `${ENGINES.ui5xpath}=${xpath}`;

export const locateSIDSelector = (sid: string) => `${ENGINES.sid}=${sid}`;

export function getByRoleSIDSelector(role: string, options: ByRoleSIDOptions): string {
	const prefix = Object.entries(sidPrefixMapping).find(([, name]) => name === role)?.[0];
	if (!prefix) throw new Error(`Invalid SID role name provided: ${role}`);
	if (options.name && options.pos) throw new Error('Both name and pos provided. Only one allowed');
	const wnd = `wnd[${options.wnd ?? 0}]`;
	const sub = options.sub || 'usr';
	const position = options.pos !== undefined ? `[${options.pos}]` : '';
	return `${ENGINES.sid}=${wnd}/${sub}/${prefix}${options.name ?? ''}${position}`;
}

const netweaverUserField = (page: Page) => page.getByRole('textbox', { name: 'User Required' });
const fioriUserField = (page: Page) => page.getByRole('textbox', { name: 'User', exact: true });

/** The user field of a Fiori launchpad or NetWeaver login page: visible while signed out. */
export function sapLoginPage(page: Page): Locator {
	return netweaverUserField(page).or(fioriUserField(page)).first();
}

async function sapLogin(
	page: Page,
	username: string,
	password: string,
	url?: string
): Promise<Response | null> {
	// A test's browser context starts without cookies unless it was given a saved session.
	const fromSession = (await page.context().cookies()).length > 0;
	const response = url ? await page.goto(url) : null;
	const netweaverUser = netweaverUserField(page);
	const fioriUser = fioriUserField(page);
	const loginPage = sapLoginPage(page);
	if (fromSession) {
		// Typing the password here would put it into this test's trace.
		if (await loginPage.isVisible()) {
			throw new Error(
				'SAPLogin: the saved SAP session is no longer valid (a login page opened). Run the tests again: the sign-in setup saves a new one.'
			);
		}
		return response;
	}
	await expect(loginPage, 'SAPLogin: no Fiori launchpad or NetWeaver login page found').toBeVisible(
		{
			timeout: 30_000
		}
	);

	if (await netweaverUser.isVisible()) {
		await netweaverUser.fill(username);
		await fillSecret(page.getByRole('textbox', { name: 'Password Required' }), password);
		await page.getByRole('button', { name: 'Log On Emphasized' }).click();
	} else {
		await fioriUser.fill(username);
		await fillSecret(page.getByRole('textbox', { name: 'Password', exact: true }), password);
		await page.getByRole('button', { name: 'Log On' }).click();
	}
	await page.waitForLoadState();
	return response;
}

/**
 * Adds the SAP methods to one page object. The fixture below does this for every page of the
 * worker's browser; call it yourself only for a page from another browser (a second launch, a
 * persistent context, a remote connection).
 */
export function withSapMethods(page: Page): Page {
	const methods: SapPageMethods = {
		getByRoleUI5: (role, properties, options) =>
			page.locator(getByRoleUI5Selector(role, properties, options)),
		locateUI5: (xpath) => page.locator(locateUI5Selector(xpath)),
		locateSID: (sid) => page.locator(locateSIDSelector(sid)),
		getByRoleSID: (role, options) => page.locator(getByRoleSIDSelector(role, options)),
		SAPLogin: (username, password, url) => sapLogin(page, username, password, url),
		waitForUI5: (options) => waitForUI5(page, options),
		ui5BoundData,
		ui5ModelProperty,
		ui5HasPendingChanges
	};
	return Object.assign(page, methods);
}

const onContext = (context: BrowserContext) => context.on('page', withSapMethods);

/** Options of the SAP projects in playwright.config.ts. */
export type SapOptions = {
	/**
	 * The saved session the tests start with (session.ts), or none. Set per project; the setup
	 * project that saves it must be one of the project's dependencies.
	 */
	sapSession: SapSession | undefined;
};

export const test = base.extend<SapOptions, { sapSelectorEngines: void }>({
	sapSession: [undefined, { option: true }],
	// Read when the test starts, after the setup project has saved the session. Without the file
	// (the setup was left out, e.g. with --no-deps), the test starts signed out.
	storageState: async ({ sapSession, storageState }, use) => {
		const file = sapSession ? sessionFile(sapSession) : undefined;
		await use(file && existsSync(file) ? file : storageState);
	},
	// Once per worker. Not a content script: the UI5 engines read window.sap, which only the page's
	// own JavaScript world has.
	sapSelectorEngines: [
		// oxlint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form
		async ({}, use) => {
			for (const name of ENGINE_NAMES)
				await selectors.register(name, { content: engineSource(name) });
			await use();
		},
		{ scope: 'worker', auto: true }
	],
	// Every page of every context of this worker's browser gets the methods: the test's own page,
	// popups, new tabs, and the pages of contexts a test opens itself (browser.newContext()).
	browser: [
		async ({ browser }, use) => {
			browser.on('context', onContext);
			await use(browser);
			browser.off('context', onContext);
		},
		{ scope: 'worker' }
	]
});

export { expect, fillSecret };
export { clearSession, saveSession, signingIn, type SapSession } from './session';
export type { Locator, Page } from '@playwright/test';
export type { WaitForUI5Options } from './ui5';
