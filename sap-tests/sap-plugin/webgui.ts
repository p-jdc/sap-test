// WebGUI (SAP GUI for HTML) state that tests check or wait for: the status bar message, open
// popups, and whether SAP has answered a key press. Everything is read from the `lsdata` attribute
// WebGUI puts on its elements (the one the SID locators match), not from CSS classes or texts, so
// it works in every logon language. Which parts of lsdata to read follows the markup of real WebGUI
// screens captured by Hochfrequenz/sapwebgui.mcp (MIT), in English and German.
import { writeFile } from 'node:fs/promises';
import type { Page, Request, TestInfo } from '@playwright/test';
import { ENGINES } from './engines';

const sid = (page: Page, path: string) => page.locator(`${ENGINES.sid}=${path}`);

/** Message type as SAP names it: S success, W warning, E error, A abort, I information. */
export type MessageType = 'S' | 'W' | 'E' | 'A' | 'I';

export type StatusBarMessage = {
	/** Empty when the status bar shows no message. */
	type: MessageType | '';
	text: string;
};

// lsdata of wnd[0]/sbar_msg (ct="MB"): "1" is the message bar type and the same in every
// language, "0" the message text. Its "11".messageType is translated ("Fehler" for "Error") and is
// not used. OK, ERROR and TEXT (no message) are in the captured screens; WARNING and STOP are the
// other types of the Unified Rendering message bar and have not been seen on a real screen yet.
const MESSAGE_BAR_TYPES: Record<string, MessageType> = {
	OK: 'S',
	WARNING: 'W',
	ERROR: 'E',
	STOP: 'A'
};

const STATUS_BAR = 'wnd[0]/sbar_msg';

/** The message bar type and text from the lsdata of the status bar, as WebGUI names them. */
function messageBar(lsdata: string | null): { barType: string; text: string } {
	const data: unknown = JSON.parse(lsdata ?? '{}');
	const isObject = typeof data === 'object' && data !== null;
	const barType = isObject && '1' in data && typeof data['1'] === 'string' ? data['1'] : 'TEXT';
	const text = isObject && '0' in data && typeof data['0'] === 'string' ? data['0'].trim() : '';
	return { barType, text };
}

/** Parses the lsdata of the status bar. Unknown types fail loudly so they get added above. */
export function parseStatusBar(lsdata: string | null): StatusBarMessage {
	const { barType, text } = messageBar(lsdata);
	if (barType === 'TEXT' || barType === 'NONE') return { type: text ? 'I' : '', text };
	const type = MESSAGE_BAR_TYPES[barType];
	if (!type) throw new Error(`Unknown WebGUI message bar type "${barType}" (text: "${text}")`);
	return { type, text };
}

/** The status bar message as it is now. Waits for the status bar to exist, not for a message. */
export async function readStatusBar(page: Page, timeout?: number): Promise<StatusBarMessage> {
	return parseStatusBar(await statusBarData(page, timeout));
}

/** The lsdata of the status bar, unparsed. Waits for the status bar to exist. */
export const statusBarData = (page: Page, timeout?: number) =>
	sid(page, STATUS_BAR).getAttribute('lsdata', { timeout });

export type RoundTripOptions = {
	/** Milliseconds for the whole round trip. Default 30 000. */
	timeout?: number;
	/**
	 * Milliseconds to wait for the action to start a round trip. An action that sends nothing to
	 * SAP (a key the screen does not handle) returns after this. Default 1 000.
	 */
	startTimeout?: number;
};

const nothing = () => {};

const nextFrames = (page: Page) =>
	page.evaluate(
		() =>
			new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))
	);

/**
 * Runs `action` (a key press or click that sends the screen to SAP) and waits until SAP has
 * answered and WebGUI has drawn the answer. `networkidle` cannot tell this: a page that was idle
 * before counts as idle at once. Instead the round trips are counted: POST requests of the page's
 * main frame. When none is open, two animation frames give WebGUI the time to draw; a round trip
 * that starts meanwhile (WebGUI sometimes sends a second one) is waited for as well.
 */
export async function roundTrip(
	page: Page,
	action: () => Promise<unknown>,
	{ timeout = 30_000, startTimeout = 1_000 }: RoundTripOptions = {}
): Promise<void> {
	const open = new Set<Request>();
	let started = false;
	let changed: () => void = nothing;
	const isRoundTrip = (request: Request) => {
		try {
			return (
				request.method() === 'POST' &&
				['xhr', 'fetch', 'document'].includes(request.resourceType()) &&
				request.frame() === page.mainFrame()
			);
		} catch {
			return false; // a service worker's request has no frame
		}
	};
	const onRequest = (request: Request) => {
		if (!isRoundTrip(request)) return;
		open.add(request);
		started = true;
		changed();
	};
	const onDone = (request: Request) => {
		if (open.delete(request)) changed();
	};
	// Resolves on the next change of `open`, or after `ms`.
	const nextChange = (ms: number) =>
		new Promise<void>((done) => {
			const timer = setTimeout(done, ms);
			changed = () => {
				clearTimeout(timer);
				done();
			};
		});

	page.on('request', onRequest);
	page.on('requestfinished', onDone);
	page.on('requestfailed', onDone);
	const deadline = Date.now() + timeout;
	const left = () => deadline - Date.now();
	try {
		await action();
		if (!started) await nextChange(Math.min(startTimeout, left()));
		if (!started) return;
		for (;;) {
			while (open.size > 0) {
				if (left() <= 0)
					throw new Error(
						`WebGUI did not answer within ${timeout} ms (${open.size} request(s) open)`
					);
				await nextChange(left());
			}
			await page.waitForLoadState('load', { timeout: Math.max(left(), 1) });
			await nextFrames(page);
			if (open.size === 0) return;
		}
	} finally {
		page.off('request', onRequest);
		page.off('requestfinished', onDone);
		page.off('requestfailed', onDone);
	}
}

export type WebGUIPopup = { window: number; title: string };

/** The status bar with WebGUI's own name of its type: `type` is empty for a type not known above. */
export type WebGUIStatusBar = StatusBarMessage & { barType: string };

export type WebGUIState = { statusBar: WebGUIStatusBar | undefined; popups: WebGUIPopup[] };

/**
 * What a WebGUI screen shows right now, without waiting: the status bar and the open popups
 * (modal windows wnd[1], wnd[2], …, a role=dialog each, named by its title). Undefined on a page
 * that is not a WebGUI screen.
 */
export async function webguiState(page: Page): Promise<WebGUIState | undefined> {
	const bar = sid(page, STATUS_BAR);
	if ((await bar.count()) === 0) return undefined;
	let statusBar: WebGUIStatusBar | undefined;
	try {
		const lsdata = await bar.first().getAttribute('lsdata', { timeout: 1_000 });
		const { barType, text } = messageBar(lsdata);
		let type: StatusBarMessage['type'] = '';
		try {
			type = parseStatusBar(lsdata).type;
		} catch {
			// A type not known yet: the description names WebGUI's own type and keeps the text.
		}
		statusBar = { type, text, barType };
	} catch {
		statusBar = undefined;
	}
	const popups: WebGUIPopup[] = [];
	for (let window = 1; window < 10; window++) {
		const popup = sid(page, `wnd[${window}]`);
		if ((await popup.count()) === 0) break;
		if (!(await popup.first().isVisible())) continue;
		const title = await popup.first().evaluate((element) =>
			(element.getAttribute('aria-labelledby') ?? '')
				.split(/\s+/)
				.map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
				.filter(Boolean)
				.join(' ')
		);
		popups.push({ window, title });
	}
	return { statusBar, popups };
}

function describeStatusBar(statusBar: WebGUIStatusBar | undefined): string {
	if (!statusBar) return 'Status bar: could not be read';
	const { type, text, barType } = statusBar;
	if (type) return `Status bar: ${type} "${text}"`;
	if (text || !['TEXT', 'NONE'].includes(barType))
		return `Status bar: unknown message bar type "${barType}" "${text}"`;
	return 'Status bar: no message';
}

export function describeWebGUIState({ statusBar, popups }: WebGUIState): string {
	const lines = [
		describeStatusBar(statusBar),
		...popups.map(({ window, title }) => `Popup open: wnd[${window}] "${title}"`)
	];
	return lines.join('\n') + '\n';
}

const ATTACH_TIMEOUT_MS = 3_000;

/**
 * For a failed test on a WebGUI screen: attaches what the screen showed at the end (status bar,
 * open popups) as webgui-state.txt, so a report shows at once when an error message or a popup
 * stopped the test. Never fails the test itself.
 */
export async function attachWebGUIState(page: Page, testInfo: TestInfo): Promise<void> {
	let timer: NodeJS.Timeout | number | undefined;
	try {
		if (page.isClosed()) return;
		// count(), isVisible() and evaluate() do not time out: a page whose script hangs would hold
		// the teardown until its own timeout. Without an answer in time there is no attachment.
		const state = await Promise.race([
			webguiState(page).catch(() => undefined),
			new Promise<undefined>((done) => {
				timer = setTimeout(done, ATTACH_TIMEOUT_MS);
			})
		]);
		if (!state) return;
		const path = testInfo.outputPath('webgui-state.txt');
		await writeFile(path, describeWebGUIState(state));
		await testInfo.attach('webgui-state', { path, contentType: 'text/plain' });
	} catch {
		// The page navigated away or closed while it was read: nothing to report.
	} finally {
		clearTimeout(timer);
	}
}
