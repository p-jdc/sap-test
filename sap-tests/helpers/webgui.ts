// Guide §4.6 – tests call these, not the fork's API, so swapping the tool underneath
// later means changing this folder instead of every test.
// getByRoleSID requires an options object in the fork's types, even when empty (the guide's §4.6
// example passes only the role and does not type-check).
import type { Page } from '@playwright/test';
import { expect } from '../sap-plugin';
import { readStatusBar, roundTrip } from '../sap-plugin/webgui';
import type { MessageType, RoundTripOptions, StatusBarMessage } from '../sap-plugin/webgui';
import { readGrid } from '../sap-plugin/webgui-grid';
import type { GridRow, WebGUIGrid } from '../sap-plugin/webgui-grid';

export { readGrid, readStatusBar, roundTrip };
export type { GridRow, MessageType, RoundTripOptions, StatusBarMessage, WebGUIGrid };

// expect.poll does not retry when its callback throws: a screen that is not there yet (SAP still
// answering, WebGUI drawing anew) would end the wait at once. A read that fails is a value that
// does not match instead, so the poll goes on, and the failure message shows why it failed.
const NOT_READ = '(not read)';
const errorText = (error: unknown) =>
	(error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';
const notRead = (error: unknown): StatusBarMessage => ({
	type: '',
	text: `${NOT_READ} ${errorText(error)}`
});

/** Starts a transaction from the command field and waits until SAP shows its first screen. */
export async function runTransaction(page: Page, tcode: string) {
	await page.getByRoleSID('okCode', {}).fill('/n' + tcode);
	await roundTrip(page, () => page.keyboard.press('Enter'));
}

/** Presses a key (Enter, F8, Control+S, …) and waits until SAP has answered. */
export async function pressKey(page: Page, key: string, options?: RoundTripOptions) {
	await roundTrip(page, () => page.keyboard.press(key), options);
}

export function field(page: Page, name: string) {
	return page.getByRoleSID('textField', { name });
}

/**
 * The popup (modal window) `wnd[window]`, 1 for the first one. It is a dialog named by its title:
 * `await expect(popup(page)).toHaveAccessibleName('Exit')`, and `toBeHidden()` once it is closed.
 * Its buttons and fields: `page.getByRoleSID('button', { name: 'BUTTON_1', wnd: 1 })`.
 */
export const popup = (page: Page, window = 1) => page.locateSID(`wnd[${window}]`);

/**
 * Waits until the status bar shows a message of this type (S, W, E, A, I), and with `text` one
 * that contains it (a string) or matches it (a RegExp). Check right after the step that shows the
 * message: a message left over from an earlier step with the same type passes as well.
 * Prefer a part of the text that does not change between runs, such as the fixed words around a
 * document number.
 */
export async function expectStatusBar(
	page: Page,
	type: MessageType,
	text?: string | RegExp,
	options?: { timeout?: number }
) {
	const expected =
		text === undefined
			? { type }
			: {
					type,
					text:
						typeof text === 'string' ? expect.stringContaining(text) : expect.stringMatching(text)
				};
	await expect
		.poll(() => readStatusBar(page, 1_000).catch(notRead), {
			message: `status bar shows a message of type ${type}`,
			timeout: options?.timeout
		})
		.toEqual(expect.objectContaining(expected));
}

/**
 * Waits until the ALV grid `gridSid` shows a row with these cell values, by technical column
 * name: a string must be the whole cell text, a RegExp must match it. Other columns may hold
 * anything. A long list draws only the rows on screen; restrict the selection so the row is among
 * them.
 */
export async function expectGridRow(
	page: Page,
	gridSid: string,
	values: Record<string, string | RegExp>,
	options?: { timeout?: number }
) {
	const expected = Object.fromEntries(
		Object.entries(values).map(([column, value]) => [
			column,
			typeof value === 'string' ? value : expect.stringMatching(value)
		])
	);
	await expect
		.poll(
			() =>
				readGrid(page, gridSid, { timeout: 1_000 }).then(
					(grid) => grid.rows.map((row) => row.values),
					(error: unknown) => [{ [NOT_READ]: errorText(error) }]
				),
			{
				message: `grid ${gridSid} shows a row with ${JSON.stringify(values)}`,
				timeout: options?.timeout
			}
		)
		.toContainEqual(expect.objectContaining(expected));
}
