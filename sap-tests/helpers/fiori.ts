import type { Locator, Page } from '@playwright/test';

// How the fork matches properties: `text` is a case-insensitive substring ("Statistics" also finds
// "Usage Statistics"), every other property must match whole (case-insensitive). Pass
// `{ exact: true }` where a short text would also hit longer ones, as `title` and `navItem` do.

export const button = (page: Page, text: string) => page.getByRoleUI5('Button', { text });

/** Only for controls with a `label` property: a plain sap.m.Input has none (its Label is a separate control). */
export const input = (page: Page, label: string) => page.getByRoleUI5('Input', { label });

/** A button that shows only an icon, e.g. `iconButton(page, 'sap-icon://edit')`. */
export const iconButton = (page: Page, icon: string) => page.getByRoleUI5('Button', { icon });

/** A sap.m.Title with exactly this text (page and section headings). */
export const title = (page: Page, text: string) =>
	page.getByRoleUI5('Title', { text }, { exact: true });

/** A launchpad or overview tile, by its header. */
export const tile = (page: Page, header: string) => page.getByRoleUI5('GenericTile', { header });

/** An entry of a sap.tnt side navigation, by its exact text. */
export const navItem = (page: Page, text: string) =>
	page.getByRoleUI5('NavigationListItem', { text }, { exact: true });

/**
 * Types into a field that `fill()` refuses: the fork resolves some controls (TextArea, the smart
 * filter bar's SFBMultiInput) to their wrapper element instead of the inner input.
 */
export async function typeInto(field: Locator, text: string) {
	await field.click();
	await field.page().keyboard.type(text);
}

/**
 * Only the matches that are shown. UI5 keeps the controls of views and wizard steps that are not
 * shown in the page, so a locator can match a hidden twin as well.
 */
export const visible = (locator: Locator) => locator.filter({ visible: true });

/** Fills a field and leaves it with Tab, for fields that are validated when they lose focus. */
export async function fillAndLeave(field: Locator, value: string) {
	await field.fill(value);
	await field.press('Tab');
}
