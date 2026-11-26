// Checks the WebGUI helpers (sap-plugin/webgui.ts, helpers/webgui.ts) on stand-in pages. Their
// lsdata follows WebGUI screens captured on real systems (Hochfrequenz/sapwebgui.mcp, MIT): the
// status bar wnd[0]/sbar_msg, and a popup wnd[1] that is a dialog named by its header.
import { test, expect, type Page } from '../../sap-plugin';
import { expectStatusBar, popup, pressKey, readStatusBar, roundTrip } from '../../helpers/webgui';
import {
	attachWebGUIState,
	describeWebGUIState,
	parseStatusBar,
	webguiState
} from '../../sap-plugin/webgui';

type Bar = { text?: string; barType: string; messageType?: string };

const statusBar = ({ text, barType, messageType = '' }: Bar) =>
	`<div id="wnd[0]/sbar_msg" ct="MB" role="note" lsdata='${JSON.stringify({
		...(text ? { 0: text } : {}),
		1: barType,
		11: { SID: 'wnd[0]/sbar_msg', Type: 'MESSAGEBAR', messageType, applicationText: text ?? '' }
	})}'><span>${text ?? ''}</span></div>`;

const POPUP = `<div ct="PW_standards" role="dialog" aria-labelledby="P1-title"
	lsdata='{"13":{"SID":"wnd[1]","Type":"GuiModalWindow","ModalNo":1}}'>
	<header><span id="P1-title">Exit</span></header>
	<div role="button" lsdata='{"27":{"SID":"wnd[1]/usr/btnBUTTON_1","Type":"GuiButton"}}'
		onclick="this.closest('[role=dialog]').hidden = true">Yes</div>
</div>`;

const screen = (...parts: string[]) =>
	`<!doctype html><html><body><div lsdata='{"SID":"wnd[0]","Type":"GuiMainWindow"}'>${parts.join('')}</div></body></html>`;

test('parseStatusBar: the type comes from the bar type, which is the same in every language', () => {
	expect(parseStatusBar(JSON.stringify({ 0: 'Saved', 1: 'OK' }))).toEqual({
		type: 'S',
		text: 'Saved'
	});
	// German screens translate messageType ("Fehler"), not the bar type.
	expect(
		parseStatusBar(
			JSON.stringify({ 0: 'Tabelle angeben', 1: 'ERROR', 11: { messageType: 'Fehler' } })
		)
	).toEqual({ type: 'E', text: 'Tabelle angeben' });
	expect(parseStatusBar(JSON.stringify({ x: 0, 1: 'TEXT', 3: 'NONE' }))).toEqual({
		type: '',
		text: ''
	});
	expect(parseStatusBar(JSON.stringify({ 0: 'Note', 1: 'TEXT' }))).toEqual({
		type: 'I',
		text: 'Note'
	});
	expect(() => parseStatusBar(JSON.stringify({ 0: 'x', 1: 'BLINKING' }))).toThrow(
		/Unknown WebGUI message bar type "BLINKING"/
	);
});

test('readStatusBar and expectStatusBar read the status bar', async ({ page }) => {
	await page.setContent(
		screen(statusBar({ text: 'Enter a table name', barType: 'ERROR', messageType: 'Error' }))
	);
	expect(await readStatusBar(page)).toEqual({ type: 'E', text: 'Enter a table name' });
	await expectStatusBar(page, 'E');
	await expectStatusBar(page, 'E', 'table name');
	await expectStatusBar(page, 'E', /^Enter a \w+ name$/);
	await expect(expectStatusBar(page, 'S', undefined, { timeout: 500 })).rejects.toThrow(
		/status bar shows a message of type S/
	);
});

test('expectStatusBar waits until the message shows', async ({ page }) => {
	await page.setContent(screen(statusBar({ barType: 'TEXT' })));
	await page.evaluate(() =>
		setTimeout(() => {
			const bar = document.getElementById('wnd[0]/sbar_msg')!;
			bar.setAttribute(
				'lsdata',
				JSON.stringify({ 0: 'Document 4711 saved', 1: 'OK', 11: { SID: 'wnd[0]/sbar_msg' } })
			);
		}, 300)
	);
	await expectStatusBar(page, 'S', 'saved');
});

test('expectStatusBar waits for a status bar that is drawn later', async ({ page }) => {
	// The screen comes 1.5 s late, longer than one read of the status bar waits.
	await page.setContent(
		`<!doctype html><html><body><div id="screen"></div><template>${statusBar({ text: 'Saved', barType: 'OK' })}</template></body></html>`
	);
	await page.evaluate(() =>
		setTimeout(() => {
			const later = document.querySelector('template')!;
			document.getElementById('screen')!.append(later.content.cloneNode(true));
		}, 1_500)
	);
	await expectStatusBar(page, 'S', 'Saved');

	await page.setContent('<p>No WebGUI screen</p>');
	await expect(expectStatusBar(page, 'S', undefined, { timeout: 2_500 })).rejects.toThrow(
		/\(not read\)/
	);
});

test('popup: the dialog wnd[1], named by its title', async ({ page }) => {
	await page.setContent(screen(statusBar({ barType: 'TEXT' }), POPUP));
	await expect(popup(page)).toHaveAccessibleName('Exit');
	await expect(popup(page, 2)).toHaveCount(0);
	await page.getByRoleSID('button', { name: 'BUTTON_1', wnd: 1 }).click();
	await expect(popup(page)).toBeHidden();
});

test('webguiState and its attachment name the status bar and the open popups', async ({
	page
}, testInfo) => {
	await page.setContent('<p>Not a WebGUI screen</p>');
	expect(await webguiState(page)).toBeUndefined();

	await page.setContent(screen(statusBar({ text: 'Enter a table name', barType: 'ERROR' }), POPUP));
	const state = await webguiState(page);
	expect(state).toEqual({
		statusBar: { type: 'E', text: 'Enter a table name', barType: 'ERROR' },
		popups: [{ window: 1, title: 'Exit' }]
	});
	expect(describeWebGUIState(state!)).toBe(
		'Status bar: E "Enter a table name"\nPopup open: wnd[1] "Exit"\n'
	);

	await attachWebGUIState(page, testInfo);
	const attachment = testInfo.attachments.find((a) => a.name === 'webgui-state');
	expect(attachment?.path).toBeTruthy();
	expect(attachment?.contentType).toBe('text/plain');
});

test('webguiState keeps the text of a status bar type it does not know', async ({ page }) => {
	await page.setContent(screen(statusBar({ text: 'Processing stopped', barType: 'BLINKING' })));
	const state = await webguiState(page);
	expect(state?.statusBar).toEqual({ type: '', text: 'Processing stopped', barType: 'BLINKING' });
	expect(describeWebGUIState(state!)).toBe(
		'Status bar: unknown message bar type "BLINKING" "Processing stopped"\n'
	);
});

test('attachWebGUIState gives up on a page whose script hangs', async ({ page }, testInfo) => {
	await page.setContent(screen(statusBar({ text: 'Saved', barType: 'OK' })));
	// The page's only thread loops for 6 s, longer than attachWebGUIState waits.
	const hanging = page.evaluate(() => {
		const end = Date.now() + 6_000;
		while (Date.now() < end);
	});
	const started = Date.now();
	await attachWebGUIState(page, testInfo);
	expect(Date.now() - started).toBeLessThan(5_000);
	expect(testInfo.attachments.find((a) => a.name === 'webgui-state')).toBeUndefined();
	await hanging;
});

// A stand-in WebGUI on its own origin: Enter posts the screen, SAP answers after `delayMs`, and
// the page draws the answer into the status bar a moment later, the way WebGUI renders a response.
const ORIGIN = 'http://webgui.test';

// The stand-in's own script. With ?rounds=2, Enter sends a second round trip after the first.
const WEBGUI_SCRIPT = `<script>
const rounds = Number(new URL(location.href).searchParams.get('rounds') || 1);
const post = () => fetch('/webgui', { method: 'POST' }).then((response) => response.text());
document.addEventListener('keydown', (event) => {
	if (event.key !== 'Enter') return;
	let answer = post();
	for (let round = 1; round < rounds; round++) answer = answer.then(post);
	answer.then((text) => setTimeout(() => {
		document.getElementById('wnd[0]/sbar_msg').setAttribute('lsdata',
			JSON.stringify({ 0: text, 1: 'OK', 11: { SID: 'wnd[0]/sbar_msg' } }));
	}, 0));
});
</script>`;

async function serveWebGUI(
	page: Page,
	{ delayMs, rounds = 1 }: { delayMs: number; rounds?: number }
) {
	let posts = 0;
	await page.route(`${ORIGIN}/**`, async (route) => {
		if (route.request().method() !== 'POST')
			return route.fulfill({
				contentType: 'text/html',
				body: screen(statusBar({ barType: 'TEXT' }), WEBGUI_SCRIPT)
			});
		posts += 1;
		await new Promise((done) => setTimeout(done, delayMs));
		return route.fulfill({ contentType: 'text/plain', body: `answer ${posts}` });
	});
	await page.goto(`${ORIGIN}/webgui?rounds=${rounds}`);
	return () => posts;
}

test('roundTrip returns once SAP has answered and the answer is drawn', async ({ page }) => {
	const posts = await serveWebGUI(page, { delayMs: 400 });
	await pressKey(page, 'Enter');
	// Read once, without retrying: the answer must already be on the screen.
	expect(await readStatusBar(page)).toEqual({ type: 'S', text: 'answer 1' });
	expect(posts()).toBe(1);
});

test('roundTrip also waits for a second round trip that follows the first', async ({ page }) => {
	const posts = await serveWebGUI(page, { delayMs: 200, rounds: 2 });
	await pressKey(page, 'Enter');
	expect(await readStatusBar(page)).toEqual({ type: 'S', text: 'answer 2' });
	expect(posts()).toBe(2);
});

test('roundTrip returns when the action sends nothing, and fails when SAP does not answer', async ({
	page
}) => {
	await serveWebGUI(page, { delayMs: 2_000 });
	const started = Date.now();
	await pressKey(page, 'F1', { startTimeout: 300 });
	expect(Date.now() - started).toBeLessThan(2_000);
	await expect(
		roundTrip(page, () => page.keyboard.press('Enter'), { timeout: 500 })
	).rejects.toThrow(/WebGUI did not answer within 500 ms/);
});
