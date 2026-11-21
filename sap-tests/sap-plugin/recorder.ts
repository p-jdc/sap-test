// SPIKE. A recorder for UI5 pages on stock Playwright. A script in the page watches clicks and
// input, asks UI5's own sap.ui.test.RecordReplay to describe the control, and reports the step.
// The user's input is never held back or repeated: the page reacts as it does without a recorder.
// The control under the mouse is described ahead of the click, while the page is still in the
// state the click will meet, and the selector is checked in the page against UI5's own finder.
// On a page without UI5 it records WebGUI elements by their SID, read from the `lsdata` attribute
// the way the Playwright-SAP fork's recorder does (sidSelectorGenerator, Apache-2.0).
// The only runtime import is ./ui5control: record.mjs bundles this file for plain Node.
import type { BrowserContext, Frame, Locator, Page } from '@playwright/test';
import { ui5ControlSelector } from './ui5control';
import type { UI5ControlSelector } from './ui5control';

export type RecordedStep = {
	seq: number;
	action: 'click' | 'fill' | 'press';
	/** A UI5 control. Missing on WebGUI pages and when UI5 could not describe the element. */
	selector?: UI5ControlSelector;
	/** A WebGUI element: its full SID path. */
	sid?: string;
	/** The iframes the element sits in, outermost first, each as a CSS selector. */
	frames?: string[];
	/** A part of the control that is no control itself (a calendar day): its exact text. */
	innerText?: string;
	value?: string;
	key?: string;
	/**
	 * The element is marked disabled (aria-disabled) and the app acted on the click all the same, as
	 * UI5's calendar does for the greyed-out days of the next month. Playwright waits for such an
	 * element to become enabled, so the replay must click without that check.
	 */
	force?: boolean;
	/** Why the step needs a look, e.g. the selector matches several controls. */
	problem?: string;
	/** What was clicked, for the comment on steps that need a look. */
	hint?: string;
};

const BINDING = 'sapRecorderReport';

// What the page script keeps on `window`, for the script itself and for recorderReady/Idle.
type RecorderState = { ready: boolean; busy: number; steps: number };
declare global {
	interface Window {
		sapRecorderState?: RecorderState;
	}
}

// Runs in every frame before the page's own scripts. Playwright sends this function to the page as
// text, so its helpers must live inside it.
/* oxlint-disable unicorn/consistent-function-scoping */
function recorderScript(binding: string) {
	type Described = { selector?: unknown; sid?: string; innerText?: string; problem?: string };
	type RecordReplay = {
		findControlSelectorByDOMElement(options: { domElement: Element }): Promise<unknown>;
	};
	type Finder = { _findElements(selector: unknown): Element[] };
	type Report = (step: Record<string, unknown>) => Promise<void>;
	type Editable = HTMLInputElement | HTMLTextAreaElement;
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the binding and UI5's loader are globals this file cannot declare: the name of the first is a parameter, and ui5.ts declares the second without the callback form
	const win = window as unknown as {
		sap?: { ui?: { require?: (modules: string[], loaded: (...m: never[]) => void) => void } };
	} & Record<string, Report>;
	if (window.sapRecorderState) return;
	const state: RecorderState = { ready: false, busy: 0, steps: 0 };
	window.sapRecorderState = state;

	let seq = 0;
	let recordReplay: RecordReplay | undefined;
	let finder: Finder | undefined;

	// Shows that the recorder is on and counts the steps. It takes no clicks.
	const badge = document.createElement('div');
	badge.style.cssText =
		'position:fixed;z-index:2147483647;top:8px;left:50%;transform:translateX(-50%);padding:6px 12px;' +
		'border-radius:14px;background:#b00;color:#fff;font:12px/1.2 sans-serif;white-space:nowrap;' +
		'pointer-events:none;opacity:.9';
	const showBadge = () => {
		badge.textContent =
			state.ready || state.steps > 0 || document.querySelector('[lsdata]')
				? `● Recording · ${state.steps} steps`
				: '○ Recorder waiting for UI5';
		if (window.top === window && !badge.isConnected && document.documentElement)
			document.documentElement.append(badge);
	};
	document.addEventListener('DOMContentLoaded', showBadge);

	// RecordReplay is loaded once the app has rendered, so the recorder does not change how UI5
	// boots. Until then (and on pages without UI5) nothing is recorded.
	const load = () => {
		const require = win.sap?.ui?.require;
		if (!require || !document.querySelector('[data-sap-ui-area] > *')) {
			setTimeout(load, 200);
			return;
		}
		require(['sap/ui/test/RecordReplay', 'sap/ui/test/_ControlFinder'], (
			loadedRecordReplay: RecordReplay,
			loadedFinder: Finder
		) => {
			recordReplay = loadedRecordReplay;
			finder = loadedFinder;
			state.ready = true;
			showBadge();
			// The app may have put the cursor into a field before this point.
			if (isEditable(document.activeElement)) enter(document.activeElement);
		});
	};
	load();

	const report = (step: Record<string, unknown>) => {
		state.steps++;
		showBadge();
		return win[binding](step);
	};
	const hintFor = (target: Element) =>
		[
			(target.textContent ?? '').trim().slice(0, 60),
			`<${target.tagName.toLowerCase()}${target.id ? ` id="${target.id}"` : ''}>`,
			`in control ${target.closest('[data-sap-ui]')?.id ?? 'none'}`
		]
			.filter(Boolean)
			.join(' ');

	// WebGUI: the element's SID is in the `lsdata` attribute of the element itself, of one close
	// around it, or of one just inside it. Only full paths count (wnd[0]/usr/...).
	const sidOf = (holder: Element | null | undefined) => {
		const sid = /["']?SID["']?\s*:\s*["']([^"']+)["']/.exec(
			holder?.getAttribute('lsdata') ?? ''
		)?.[1];
		return sid && sid.split('/').length > 2 ? sid : undefined;
	};
	const sidFor = (target: Element): string | undefined => {
		let around: Element | null = target;
		for (let level = 0; around && level < 5; level++, around = around.parentElement)
			if (around.hasAttribute('lsdata')) return sidOf(around);
		return sidOf(target.querySelector('[lsdata]'));
	};
	// What is recorded: everything on a UI5 page, and WebGUI elements on any other page.
	const watched = (target: Element) => state.ready || !!sidFor(target);

	const selectorFor = async (element: Element): Promise<unknown> => {
		try {
			return (await recordReplay?.findControlSelectorByDOMElement({ domElement: element })) ?? null;
		} catch {
			return null;
		}
	};
	// What the replay will do: find exactly one element and click its middle. That must land on
	// the element the user used, not just somewhere in the same control.
	const check = (selector: unknown, target: Element): string | undefined => {
		let found: Element[];
		try {
			// A copy: the finder rewrites the selector it is given.
			// oxlint-disable-next-line no-underscore-dangle -- UI5's name
			found = finder?._findElements(JSON.parse(JSON.stringify(selector))) ?? [];
		} catch {
			return 'UI5 could not resolve its own selector';
		}
		if (found.length !== 1) return `the selector matches ${found.length} elements`;
		if (target.contains(found[0])) return undefined;
		const box = found[0].getBoundingClientRect();
		const [x, y] = [box.left + box.width / 2, box.top + box.height / 2];
		const used = target.getBoundingClientRect();
		const hits = x >= used.left && x <= used.right && y >= used.top && y <= used.bottom;
		return hits ? undefined : 'the selector finds another element than the one used';
	};
	const describe = async (target: Element): Promise<Described> => {
		if (!state.ready) {
			const sid = sidFor(target);
			return sid ? { sid } : { problem: 'neither UI5 nor a WebGUI SID describes this element' };
		}
		state.busy++;
		try {
			const selector = await selectorFor(target);
			const direct = selector ? { selector, problem: check(selector, target) } : undefined;
			if (direct && !direct.problem) return direct;
			// UI5 cannot address this element itself: a part of a control (a day in a calendar,
			// where it answers with the control and so with another day) or a control it finds
			// nothing unique for (the icon in a button). The nearest control around it that UI5
			// can describe stands in, with the element's text if it has one.
			const innerText = (target.textContent ?? '').trim() || undefined;
			let root = target.closest('[data-sap-ui]');
			if (root === target) root = target.parentElement?.closest('[data-sap-ui]') ?? null;
			let around: Record<string, unknown> | null = null;
			for (let level = 0; root && level < 3; level++) {
				const selectorAround = await selectorFor(root);
				if (selectorAround && typeof selectorAround === 'object') {
					around = { ...selectorAround };
					break;
				}
				root = root.parentElement?.closest('[data-sap-ui]') ?? null;
			}
			const unknown = { problem: 'UI5 could not describe this element' };
			if (!root || !around) return direct ?? unknown;

			// 1. The part by its ID inside the control ("<control>-next"), UI5's own way.
			const prefix = `${root.id}-`;
			let part: Element | null = target;
			while (part && part !== root && !part.id.startsWith(prefix)) part = part.parentElement;
			if (part && part !== root) {
				const byId = { ...around, interaction: { idSuffix: part.id.slice(prefix.length) } };
				if (!check(byId, target)) return { selector: byId };
			}
			// 2. The part by its text, looked up in the whole control.
			const whole = { ...around, interaction: 'root' };
			const sameText = [...root.querySelectorAll('*')].filter(
				(other) => other.children.length === 0 && (other.textContent ?? '').trim() === innerText
			);
			if (innerText && sameText.length === 1 && !check(whole, root))
				return { selector: whole, innerText };
			// 3. The control alone, if its middle is what was used.
			const problem = check(around, target);
			if (problem && direct) return direct;
			return { selector: around, problem };
		} finally {
			state.busy--;
		}
	};

	// Described ahead of the click. Once the click is on its way the page may already be changing,
	// and a selector made then could describe the control as the click left it.
	type Prepared = { result: Promise<Described>; settled?: Described; at: number };
	const prepared = new WeakMap<Element, Prepared>();
	const prepare = (target: Element): Prepared => {
		const entry: Prepared = { result: describe(target), at: Date.now() };
		void entry.result.then((described) => {
			entry.settled = described;
			return described;
		});
		prepared.set(target, entry);
		return entry;
	};
	const fresh = (target: Element, maxAge: number) => {
		const entry = prepared.get(target);
		return entry && Date.now() - entry.at < maxAge ? entry : undefined;
	};
	window.addEventListener(
		'mousemove',
		(event) => {
			if (!state.ready || state.busy || !(event.target instanceof Element)) return;
			if (!fresh(event.target, 400)) prepare(event.target);
		},
		true
	);
	window.addEventListener(
		'pointerdown',
		(event) => {
			if (event.button !== 0 || !(event.target instanceof Element)) return;
			if (!watched(event.target)) return;
			if (!fresh(event.target, 2_000)?.settled) prepare(event.target);
		},
		true
	);
	window.addEventListener(
		'click',
		(event) => {
			const target = event.target;
			if (!event.isTrusted || event.button !== 0) return;
			if (!(target instanceof Element) || !watched(target)) return;
			const entry = prepared.get(target) ?? prepare(target);
			const force = target.closest('[aria-disabled="true"]') ? { force: true } : {};
			const step = { seq: ++seq, action: 'click', hint: hintFor(target), ...force };
			prepared.delete(target);
			void entry.result.then((described) => report({ ...step, ...described }));
		},
		true
	);

	// A field is described when it gets focus, before its value changes: a selector made after
	// typing could contain the typed value, which the field does not have yet when the test
	// replays. What was typed is read from the field when it is left, so fields that set their
	// value themselves (sap.m.MaskInput) are covered too.
	const isEditable = (target: EventTarget | null): target is Editable =>
		target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
	const fields = new WeakMap<Element, { described: Promise<Described>; value: string }>();
	const enter = (field: Editable) => {
		const known = fields.get(field) ?? { described: describe(field), value: field.value };
		fields.set(field, known);
		return known;
	};
	const recordTyping = (field: Editable) => {
		const known = fields.get(field);
		if (!known || known.value === field.value) return;
		const step = { seq: ++seq, action: 'fill', value: field.value, hint: hintFor(field) };
		known.value = field.value;
		void known.described.then((described) => report({ ...step, ...described }));
	};
	window.addEventListener(
		'focusin',
		(event) => {
			if (isEditable(event.target) && watched(event.target)) enter(event.target);
		},
		true
	);
	// A field that got its focus unseen is taken up at the first key instead. Its value before
	// that key is unknown, so whatever it holds when it is left counts as typed.
	window.addEventListener(
		'input',
		(event) => {
			const field = event.target;
			if (!isEditable(field) || !watched(field) || fields.has(field)) return;
			fields.set(field, { described: describe(field), value: field.value === '' ? ' ' : '' });
		},
		true
	);
	window.addEventListener(
		'focusout',
		(event) => {
			if (!isEditable(event.target)) return;
			recordTyping(event.target);
			fields.delete(event.target);
		},
		true
	);
	window.addEventListener(
		'keydown',
		(event) => {
			const target = event.target;
			if (event.key !== 'Enter' || !isEditable(target) || !watched(target)) return;
			const { described } = enter(target);
			recordTyping(target);
			const step = { seq: ++seq, action: 'press', key: 'Enter', hint: hintFor(target) };
			void described.then((found) => report({ ...step, ...found }));
		},
		true
	);
}

/* oxlint-enable unicorn/consistent-function-scoping */

const isSelector = (value: unknown): value is UI5ControlSelector =>
	typeof value === 'object' && value !== null && Object.keys(value).length > 0;

// A CSS selector for the iframe element of each frame around `frame`, outermost first.
async function framePath(frame: Frame): Promise<string[]> {
	const path: string[] = [];
	for (let current = frame; current.parentFrame(); current = current.parentFrame() ?? current) {
		const element = await current.frameElement();
		path.unshift(
			await element.evaluate((node) => {
				if (!(node instanceof Element)) return 'iframe';
				const attribute = ['name', 'id', 'title', 'src'].find((name) => node.getAttribute(name));
				return attribute ? `iframe[${attribute}="${node.getAttribute(attribute)}"]` : 'iframe';
			})
		);
	}
	return path;
}

/**
 * Starts recording in every page and frame of the context. Returns the steps so far, in the
 * order the user made them.
 */
export async function installRecorder(
	context: BrowserContext
): Promise<() => Promise<RecordedStep[]>> {
	const steps: RecordedStep[] = [];
	const arriving: Promise<unknown>[] = [];
	await context.exposeBinding(BINDING, ({ frame }, raw: RecordedStep) => {
		const step = { ...raw, selector: isSelector(raw.selector) ? raw.selector : undefined };
		arriving.push(
			framePath(frame)
				.catch(() => [])
				.then((frames) => steps.push(frames.length ? { ...step, frames } : step))
		);
	});
	await context.addInitScript(recorderScript, BINDING);
	return async () => {
		await Promise.all(arriving);
		// oxlint-disable-next-line unicorn/no-array-sort -- toSorted is not in the ES2022 library this project compiles against; the copy keeps `steps` untouched
		return [...steps].sort((a, b) => a.seq - b.seq);
	};
}

/** True once the recorder in the page or frame has loaded UI5's RecordReplay and records. */
export const recorderReady = (page: Page | Frame) =>
	page.waitForFunction(() => window.sapRecorderState?.ready);

/**
 * True once the recorder has described what is under the mouse. A person rests on a control for
 * a moment before clicking it; a script that plays the user waits for this instead.
 */
export const recorderIdle = (page: Page | Frame) =>
	page.waitForFunction(() => window.sapRecorderState?.busy === 0);

// The engine name sap-plugin registers the fork's SID engine under (ENGINES.sid in engines.ts).
const sidSelector = (sid: string) => `sid=${sid}`;

/** The locator a recorded step replays through, or undefined if the step has none. */
export function stepLocator(page: Page, step: RecordedStep): Locator | undefined {
	const selector = step.selector
		? ui5ControlSelector(step.selector)
		: step.sid && sidSelector(step.sid);
	if (!selector) return undefined;
	const frames = step.frames ?? [];
	const found = frames.length
		? frames
				.slice(1)
				.reduce((frame, next) => frame.frameLocator(next), page.frameLocator(frames[0]))
				.locator(selector)
		: page.locator(selector);
	return step.innerText ? found.getByText(step.innerText, { exact: true }) : found;
}

const quote = (text: string) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

// A selector as an object literal: bare keys, single quotes.
function literal(value: unknown): string {
	if (typeof value === 'string') return quote(value);
	if (Array.isArray(value)) return `[${value.map(literal).join(', ')}]`;
	if (typeof value === 'object' && value !== null) {
		const entries = Object.entries(value)
			.filter(([, entry]) => entry !== undefined)
			.map(
				([key, entry]) => `${/^[A-Za-z_$][\w$]*$/.test(key) ? key : quote(key)}: ${literal(entry)}`
			);
		return `{ ${entries.join(', ')} }`;
	}
	return JSON.stringify(value);
}

// The expression for the step's locator. In the top frame the page methods of sap-plugin; inside
// an iframe the same selectors through frameLocator, which has no such methods.
function locatorCode(step: RecordedStep): string | undefined {
	const frames = (step.frames ?? []).map((frame) => `.frameLocator(${quote(frame)})`).join('');
	let found: string | undefined;
	if (step.selector)
		found = frames
			? `page${frames}.locator(ui5ControlSelector(${literal(step.selector)}))`
			: `page.locateUI5Control(${literal(step.selector)})`;
	else if (step.sid)
		found = frames
			? `page${frames}.locator(locateSIDSelector(${quote(step.sid)}))`
			: `page.locateSID(${quote(step.sid)})`;
	if (!found) return undefined;
	return step.innerText ? `${found}.getByText(${quote(step.innerText)}, { exact: true })` : found;
}

function stepLines(step: RecordedStep): string[] {
	const lines: string[] = [];
	if (step.problem) lines.push(`// FIXME: ${step.problem}${step.hint ? ` (${step.hint})` : ''}`);
	const locator = locatorCode(step);
	if (!locator) {
		lines.push(`// ${step.action} was not recorded`);
		return lines;
	}
	if (step.action === 'click')
		lines.push(`await ${locator}.click(${step.force ? '{ force: true }' : ''});`);
	if (step.action === 'fill') lines.push(`await ${locator}.fill(${quote(step.value ?? '')});`);
	if (step.action === 'press') lines.push(`await ${locator}.press(${quote(step.key ?? '')});`);
	return lines;
}

export type SpecOptions = {
	/** The test's title. */
	name?: string;
	/** Start with page.SAPLogin and the credentials from the environment instead of page.goto. */
	login?: boolean;
	/** The start page is the configured SAP_URL: read it from the environment as well. */
	urlFromEnv?: boolean;
};

/** The recorded steps as a spec. `pluginImport` is the path to sap-plugin from the spec's folder. */
export function renderSpec(
	url: string,
	steps: RecordedStep[],
	pluginImport: string,
	options: SpecOptions = {}
): string {
	const address = options.urlFromEnv ? 'process.env.SAP_URL' : quote(url);
	const start = options.login
		? `await page.SAPLogin(process.env.SAP_USERNAME!, process.env.SAP_PASSWORD!, ${address});`
		: `await page.goto(${address}${options.urlFromEnv ? '!' : ''});`;
	// fill() focuses the field itself: the click a person makes to get into it adds nothing.
	const target = (step: RecordedStep) =>
		JSON.stringify([step.selector, step.sid, step.frames, step.innerText]);
	const kept = steps.filter((step, index) => {
		const next = steps[index + 1];
		return !(step.action === 'click' && next?.action === 'fill' && target(step) === target(next));
	});
	const body = [start, ...kept.flatMap(stepLines)].join('\n');
	const names = ['test', 'ui5ControlSelector', 'locateSIDSelector'].filter(
		(name) => name === 'test' || body.includes(`${name}(`)
	);
	return [
		`import { ${names.join(', ')} } from ${quote(pluginImport)};`,
		'',
		`test(${quote(options.name?.trim() || 'recorded')}, async ({ page }) => {`,
		...body.split('\n').map((line) => `\t${line}`),
		'});',
		''
	].join('\n');
}
