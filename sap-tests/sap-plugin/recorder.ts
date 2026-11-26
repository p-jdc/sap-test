// SPIKE. A recorder for UI5 pages on stock Playwright. A script in the page watches clicks and
// input, asks UI5's own sap.ui.test.RecordReplay to describe the control, and reports the step.
// The user's input is never held back or repeated: the page reacts as it does without a recorder.
// The control under the mouse is described ahead of the click, while the page is still in the
// state the click will meet, and the selector is checked in the page against UI5's own finder.
// On a page without UI5 it records WebGUI elements by their SID, read from the `lsdata` attribute
// the way the Playwright-SAP fork's recorder does (sidSelectorGenerator, Apache-2.0).
// The only runtime import is ./ui5control: record.mjs bundles this file for plain Node.
import type { BrowserContext, Frame, Locator, Page } from '@playwright/test';
import { ui5ChartPointSelector, ui5ControlSelector } from './ui5control';
import type { UI5ChartPoint, UI5ControlSelector } from './ui5control';

export type RecordedStep = {
	/** The step's number within its document (a page or frame as loaded once). */
	seq: number;
	/**
	 * When the user made the step, in milliseconds. Each document counts its own `seq` from 1, so
	 * the steps of several documents (a new page after a navigation, an iframe) are put in order
	 * by this.
	 */
	at?: number;
	/** `expect`: a check the person asked for with the recorder's Check button. */
	action: 'click' | 'fill' | 'press' | 'expect';
	/**
	 * What an `expect` step checks: the field's value, the text, whether it is ticked, or only
	 * that it is shown. `value` holds the value or text, `checked` whether it is ticked.
	 */
	check?: 'value' | 'text' | 'checked' | 'visible';
	checked?: boolean;
	/** A UI5 control. Missing on WebGUI pages and when UI5 could not describe the element. */
	selector?: UI5ControlSelector;
	/** A WebGUI element: its full SID path. */
	sid?: string;
	/** The iframes the element sits in, outermost first, each as a CSS selector. */
	frames?: string[];
	/** A part of the control that is no control itself (a calendar day): its exact text. */
	innerText?: string;
	/**
	 * A data point of a chart (a bar, a point of a line, a slice): the values it stands for. The
	 * selector is then the chart.
	 */
	chartPoint?: UI5ChartPoint;
	/**
	 * A message that belongs to no control (sap.m.MessageToast): an element with the ARIA role
	 * alert, found by this text in it.
	 */
	alert?: string;
	value?: string;
	/**
	 * A password was typed. What was typed never leaves the page: the step has no `value`, and the
	 * written spec reads the password from an environment variable.
	 */
	secret?: boolean;
	key?: string;
	/**
	 * The element is marked disabled (aria-disabled) and the app acted on the click all the same, as
	 * UI5's calendar does for the greyed-out days of the next month. Playwright waits for such an
	 * element to become enabled, so the replay must click without that check.
	 */
	force?: boolean;
	/**
	 * The date or time field (sap.m.DatePicker and the like, its control ID) whose picker the step
	 * used. A fill with this is the value the picker put into the field; the clicks in the picker
	 * that led to it are left out of the spec, so the test does not depend on the day it runs.
	 */
	picker?: string;
	/** Why the step needs a look, e.g. the selector matches several controls. */
	problem?: string;
	/** What was clicked, for the comment on steps that need a look. */
	hint?: string;
	/**
	 * The control as a person sees it: its text or label, and what kind of control it is. The
	 * written spec names it in a comment where the selector does not (a Fiori elements ID).
	 */
	shown?: Shown;
};

export type Shown = {
	name: string;
	kind?: string;
	/** The field a part belongs to: the value help icon of the "Supplier" field. */
	of?: { name: string; kind?: string };
};

const BINDING = 'sapRecorderReport';

// What the page script keeps on `window`, for the script itself and for recorderReady/Idle.
type RecorderState = {
	ready: boolean;
	busy: number;
	steps: number;
	/** Reports what was typed into the field that has the focus, as leaving the field would. */
	flush?: () => void;
	/**
	 * Whether the next click records a check instead of a click. Set in every frame of the page:
	 * the Check button is in the top frame, the control may be in an iframe.
	 */
	checking?: boolean;
	setChecking?: (on: boolean) => void;
};
declare global {
	interface Window {
		sapRecorderState?: RecorderState;
	}
}

// Runs in every frame before the page's own scripts. Playwright sends this function to the page as
// text, so its helpers must live inside it.
/* oxlint-disable unicorn/consistent-function-scoping */
function recorderScript(binding: string) {
	type Described = {
		selector?: unknown;
		sid?: string;
		innerText?: string;
		chartPoint?: Record<string, string>;
		alert?: string;
		problem?: string;
		shown?: Shown;
	};
	type RecordReplay = {
		findControlSelectorByDOMElement(options: { domElement: Element }): Promise<unknown>;
	};
	type Finder = { _findElements(selector: unknown): Element[] };
	// The few parts of UI5's controls the recorder asks about.
	type Control = {
		getId(): string;
		getParent(): Control | null | undefined;
		isA(type: string): boolean;
		hasListeners(event: string): boolean;
		getDomRef(): Element | null;
		getFocusDomRef(): Element | null;
		getMetadata?(): { getName(): string };
		attachChange?(handler: () => void): void;
	};
	type ElementModule = {
		closestTo?(element: Element): Control | undefined;
		getElementById?(id: string): Control | undefined;
		registry?: { get(id: string): Control | undefined };
	};
	// A step as the page reports it: the selector is whatever UI5 answered, checked on arrival.
	type PageStep = Omit<Partial<RecordedStep>, 'selector' | 'action'> & {
		action: string;
		selector?: unknown;
	};
	type Report = (step: PageStep | { action: 'mode' }) => Promise<unknown>;
	type Editable = HTMLInputElement | HTMLTextAreaElement;
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- the binding and UI5's loader are globals this file cannot declare: the name of the first is a parameter, and ui5.ts declares the second without the callback form
	const win = window as unknown as {
		sap?: { ui?: { require?: (modules: string[], loaded: (...m: never[]) => void) => void } };
	} & Record<string, Report>;
	if (window.sapRecorderState) return;
	const state: RecorderState = { ready: false, busy: 0, steps: 0 };
	window.sapRecorderState = state;

	let seq = 0;
	// The number and time of a step, taken when the user makes it. Describing its control takes
	// a moment, so steps are reported out of order; these put them back.
	const next = () => ({ seq: ++seq, at: performance.timeOrigin + performance.now() });
	let recordReplay: RecordReplay | undefined;
	let finder: Finder | undefined;
	let elements: ElementModule | undefined;

	// Shows that the recorder is on, counts the steps and holds the Check button. In the top frame
	// only, in a shadow root of its own, so the page's styles do not reach it. Built element by
	// element: a page with Trusted Types refuses innerHTML.
	const badge = document.createElement('div');
	badge.dataset.sapRecorder = '';
	badge.style.cssText =
		'position:fixed;z-index:2147483647;top:8px;left:50%;transform:translateX(-50%);' +
		// Only the button takes the mouse: the app under the bar stays usable.
		'pointer-events:none';
	const shadow = badge.attachShadow({ mode: 'open' });
	const style = document.createElement('style');
	style.textContent =
		'.bar{display:flex;align-items:center;gap:8px;padding:4px 4px 4px 12px;border-radius:14px;' +
		'background:#b00;color:#fff;font:12px/1.2 sans-serif;white-space:nowrap;opacity:.92}' +
		'.bar.checking{background:#0a6ed1}' +
		'button{font:inherit;color:#b00;background:#fff;border:0;border-radius:10px;padding:3px 10px;cursor:pointer;pointer-events:auto}' +
		'.checking button{color:#0a6ed1}';
	const bar = document.createElement('div');
	bar.className = 'bar';
	const status = document.createElement('span');
	const checkButton = document.createElement('button');
	checkButton.type = 'button';
	checkButton.title = 'Record a check: click a field, a text or a checkbox next';
	bar.append(status, checkButton);
	shadow.append(style, bar);
	const recording = () => state.ready || state.steps > 0 || !!document.querySelector('[lsdata]');
	const showBadge = () => {
		bar.classList.toggle('checking', !!state.checking);
		if (state.checking) status.textContent = '✓ Click what to check · Esc cancels';
		else
			status.textContent = recording()
				? `● Recording · ${state.steps} steps`
				: '○ Recorder waiting for UI5';
		checkButton.textContent = state.checking ? 'Cancel' : 'Check';
		if (window.top === window && !badge.isConnected && document.documentElement)
			document.documentElement.append(badge);
	};
	document.addEventListener('DOMContentLoaded', showBadge);
	// An event on the recorder's own bar.
	const ours = (event: Event) => event.composedPath().includes(badge);

	// RecordReplay is loaded once the app has rendered, so the recorder does not change how UI5
	// boots. Until then (and on pages without UI5) nothing is recorded.
	const load = () => {
		const require = win.sap?.ui?.require;
		if (!require || !document.querySelector('[data-sap-ui-area] > *')) {
			setTimeout(load, 200);
			return;
		}
		require(['sap/ui/test/RecordReplay', 'sap/ui/test/_ControlFinder', 'sap/ui/core/Element'], (
			loadedRecordReplay: RecordReplay,
			loadedFinder: Finder,
			loadedElements: ElementModule
		) => {
			recordReplay = loadedRecordReplay;
			finder = loadedFinder;
			elements = loadedElements;
			state.ready = true;
			showBadge();
			// The app may have put the cursor into a field before this point.
			if (isEditable(document.activeElement)) enter(document.activeElement);
		});
	};
	load();

	const report = (step: PageStep) => {
		state.steps++;
		showBadge();
		return win[binding](step);
	};
	const hintFor = (target: Element) =>
		[
			(target.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
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
	// A chart (sap.viz) draws its bars, points and slices as SVG shapes. D3 keeps the record a shape
	// stands for on its element: the dimensions, the measure's value, and with several measures
	// which one (`measureNames`). The texts say which data point it is; the numbers are the
	// measured values, which change with the data, and row numbers, which are positions. A value
	// label drawn on a shape carries the same record and stands for the same data point.
	const chartShapes = (chart: Element) => [...chart.querySelectorAll('.v-datapoint')];
	// D3 keeps the record on a property of its own on the element.
	// oxlint-disable-next-line no-underscore-dangle -- D3's name
	const dataOf = (shape: Element): unknown => ('__data__' in shape ? shape.__data__ : undefined);
	const chartPointOf = (shape: Element): Record<string, string> | undefined => {
		const record = dataOf(shape);
		if (typeof record !== 'object' || record === null) return undefined;
		const texts = Object.entries(record).filter(
			(entry): entry is [string, string] =>
				typeof entry[1] === 'string' && !entry[0].startsWith('_')
		);
		return texts.length ? Object.fromEntries(texts) : undefined;
	};
	const sameChartPoint = (shape: Element, point: Record<string, string>) => {
		const record = dataOf(shape);
		if (typeof record !== 'object' || record === null) return false;
		const values = new Map<string, unknown>(Object.entries(record));
		return Object.entries(point).every(([name, value]) => values.get(name) === value);
	};

	// The control an element belongs to. Element.closestTo is UI5 1.106 and later.
	const controlOf = (element: Element): Control | undefined => {
		if (elements?.closestTo) return elements.closestTo(element) ?? undefined;
		const id = element.closest('[data-sap-ui]')?.id;
		return id ? (elements?.getElementById?.(id) ?? elements?.registry?.get(id)) : undefined;
	};
	// An icon that is only the picture on a button. UI5 describes it by its image ("an Icon whose
	// source matches cart"); the button around it has the text, tooltip or binding that names it,
	// and a click on the button does what the click on its icon did. An icon with its own press
	// handler does something of its own and stays.
	const PRESSABLE = ['sap.m.Button', 'sap.m.MenuButton', 'sap.m.Link'];
	const buttonAround = (target: Element): Element | undefined => {
		const control = controlOf(target);
		if (!control?.isA('sap.ui.core.Icon') || control.hasListeners('press')) return undefined;
		const parent = control.getParent();
		if (!parent || !PRESSABLE.some((type) => parent.isA(type))) return undefined;
		return parent.getDomRef() ?? undefined;
	};
	// The date or time field whose picker (calendar, clock) an element is in, if any. The picker's
	// popup is an aggregation of the field, so the field is among the element's parents.
	const pickerOf = (target: Element): Control | undefined => {
		let control = controlOf(target);
		for (let level = 0; control && level < 6; level++, control = control.getParent() ?? undefined)
			if (control.isA('sap.m.DateTimeField')) return control;
		return undefined;
	};

	// An element outside every control's DOM: a part a control draws elsewhere (the error message
	// of a field, in a popup of its own, with the ID "<field>-message-text"), found by the
	// control's selector and the rest of the ID as UI5 finds parts; else a message that belongs to
	// no control (sap.m.MessageToast), by its role and its text.
	const controlById = (id: string) => elements?.getElementById?.(id) ?? elements?.registry?.get(id);
	const apart = async (target: Element): Promise<Described | undefined> => {
		for (let cut = target.id.lastIndexOf('-'); cut > 0; cut = target.id.lastIndexOf('-', cut - 1)) {
			const owner = controlById(target.id.slice(0, cut))?.getDomRef();
			const ownSelector = owner ? await selectorFor(owner) : undefined;
			if (!ownSelector || typeof ownSelector !== 'object') continue;
			const part = { ...ownSelector, interaction: { idSuffix: target.id.slice(cut + 1) } };
			if (!check(part, target)) return { selector: part };
		}
		const alert = target.closest('[role=alert]');
		const text = alert ? oneLine(alert.textContent).slice(0, LONGEST_TEXT) : '';
		return text ? { alert: text } : undefined;
	};
	const describeControl = async (target: Element): Promise<Described> => {
		if (!state.ready) {
			const sid = sidFor(target);
			return sid ? { sid } : { problem: 'neither UI5 nor a WebGUI SID describes this element' };
		}
		const button = buttonAround(target);
		if (button) return describeControl(button);
		state.busy++;
		try {
			const selector = await selectorFor(target);
			const direct = selector ? { selector, problem: check(selector, target) } : undefined;
			// A shape of a chart is never the control itself, even where the chart's middle lies within
			// the shape's box, as it does for the slices of a pie.
			const shape = target.closest('.v-datapoint, .v-datalabel');
			if (direct && !direct.problem && !shape) return direct;
			// UI5 cannot address this element itself: a part of a control (a day in a calendar,
			// where it answers with the control and so with another day) or a control it finds
			// nothing unique for (the icon in a button). The nearest control around it that UI5
			// can describe stands in, with the element's text if it has one.
			const innerText = (target.textContent ?? '').trim() || undefined;
			let root = target.closest('[data-sap-ui]');
			if (root === target) root = target.parentElement?.closest('[data-sap-ui]') ?? null;
			let around: UI5ControlSelector | null = null;
			for (let level = 0; root && level < 3; level++) {
				const selectorAround = await selectorFor(root);
				if (selectorAround && typeof selectorAround === 'object') {
					around = { ...selectorAround };
					break;
				}
				root = root.parentElement?.closest('[data-sap-ui]') ?? null;
			}
			const unknown = { problem: 'UI5 could not describe this element' };
			if (!root || !around) return direct ?? (await apart(target)) ?? unknown;

			// A data point of a chart, by the values it stands for.
			const chartPoint = shape && root.contains(shape) ? chartPointOf(shape) : undefined;
			if (shape && chartPoint) {
				const chart = { ...around, interaction: 'root' };
				const same = chartShapes(root).filter((other) => sameChartPoint(other, chartPoint));
				if (same.length === 1 && !check(chart, root)) {
					// The replay clicks the middle of the shape. Its own value label may lie there; a
					// neighbour that overlaps it (bubbles) must not.
					const box = same[0].getBoundingClientRect();
					const atMiddle = document.elementFromPoint(
						box.left + box.width / 2,
						box.top + box.height / 2
					);
					const label = atMiddle?.closest('.v-datalabel');
					const own =
						!!atMiddle &&
						(same[0].contains(atMiddle) || (!!label && sameChartPoint(label, chartPoint)));
					return {
						selector: chart,
						chartPoint,
						problem: own ? undefined : 'another element covers the middle of this data point'
					};
				}
			}
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

	// What a person sees of the control: for a field its label (the element that labels it, as
	// UI5 links a sap.m.Label to its field) or its placeholder, else its text or its tooltip.
	// Screen reader texts that UI5 adds (sapUiInvisibleText) are no name.
	const LONGEST_NAME = 60;
	const oneLine = (text: string | null | undefined) =>
		(text ?? '').replaceAll('\u200b', '').replace(/\s+/g, ' ').trim();
	const labelOf = (element: Element) =>
		(element.getAttribute('aria-labelledby') ?? '')
			.split(/\s+/)
			.map((id) => (id ? document.getElementById(id) : null))
			.filter((label) => !!label && !label.classList.contains('sapUiInvisibleText'))
			.map((label) => oneLine(label?.textContent))
			.find(Boolean);
	// `sap.m.IconTabFilter` → `icon tab filter`, `SFBSearchField` → `SFB search field`.
	const kindOf = (type: string) =>
		(type.split('.').pop() ?? type)
			.replace(/([a-z])([A-Z])/g, '$1 $2')
			.replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
			.split(' ')
			.map((word) => (/[a-z]/.test(word) ? word.toLowerCase() : word))
			.join(' ');
	// The field (sap.m.Input, a filter bar's field) a part such as its value help icon sits in.
	const fieldControlOf = (control: Control | undefined) => {
		for (let level = 0; control && level < 3; level++, control = control.getParent() ?? undefined)
			if (control.isA('sap.m.InputBase') && isEditable(control.getFocusDomRef())) return control;
		return undefined;
	};
	const shownOf = (target: Element): Shown | undefined => {
		const control = state.ready ? controlOf(target) : undefined;
		const root = control?.getDomRef() ?? target;
		const field = isEditable(target) ? target : (control?.getFocusDomRef() ?? null);
		// Only a field one types into; a native checkbox or button input is named as what it is.
		const typed = isTextField(field) ? field : undefined;
		const around = typed ? undefined : fieldControlOf(control?.getParent() ?? undefined);
		const aroundRef = around?.getFocusDomRef();
		const of = aroundRef && shownOf(aroundRef);
		const text = typed ? '' : oneLine(root.textContent);
		const name = [
			typed && labelOf(typed),
			typed?.getAttribute('aria-label'),
			typed?.placeholder,
			text,
			labelOf(root),
			root.getAttribute('aria-label'),
			root.getAttribute('title')
		]
			.map(oneLine)
			// A long text is no name; cut short it would not match the code that holds it whole.
			.find((candidate) => candidate && candidate.length <= LONGEST_NAME);
		if (!name) return undefined;
		// Whatever kind of input it is, a person sees a field.
		const type = control?.getMetadata?.().getName();
		const kind = typed ? 'field' : type ? kindOf(type) : root.getAttribute('role');
		return {
			name,
			...(kind ? { kind } : {}),
			...(of ? { of: { name: of.name, ...(of.kind ? { kind: of.kind } : {}) } } : {})
		};
	};
	const describe = async (target: Element): Promise<Described> => {
		const described = await describeControl(target);
		if (!described.selector && !described.sid) return described;
		const shown = shownOf(buttonAround(target) ?? target);
		return shown ? { ...described, shown } : described;
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
			// The bar and a click that records a check (below) are no steps of the flow.
			if (state.checking || ours(event) || !watched(event.target)) return;
			if (!fresh(event.target, 2_000)?.settled) prepare(event.target);
			armPicker(event.target);
		},
		true
	);
	window.addEventListener(
		'click',
		(event) => {
			const target = event.target;
			if (!event.isTrusted || event.button !== 0) return;
			if (state.checking || ours(event)) return;
			if (!(target instanceof Element) || !watched(target)) return;
			const entry = prepared.get(target) ?? prepare(target);
			const force = target.closest('[aria-disabled="true"]') ? { force: true } : {};
			const picker = pickerAt.get(target) ?? pickerOf(target)?.getId();
			const step = {
				...next(),
				action: 'click',
				hint: hintFor(target),
				...force,
				...(picker ? { picker } : {})
			};
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
	// `typedAt`: the time of the last key, which is when the fill happened. The field is often left
	// much later (or, in check mode, not at all before a check in another frame).
	type Field = { described: Promise<Described>; value: string; secret: boolean; typedAt?: number };
	const fields = new WeakMap<Element, Field>();
	// A password must not end up in a spec file. A field that was a password field once stays one
	// for the recorder: a "show password" button turns it into a text field.
	const passwordFields = new WeakSet<Element>();
	const isSecret = (field: Editable) => {
		const now =
			field instanceof HTMLInputElement &&
			(field.type === 'password' || /password/i.test(field.autocomplete));
		if (now) passwordFields.add(field);
		return passwordFields.has(field);
	};
	const enter = (field: Editable) => {
		const known = fields.get(field) ?? {
			described: describe(field),
			value: field.value,
			secret: isSecret(field)
		};
		fields.set(field, known);
		return known;
	};
	// A date picked in a calendar is recorded as the value the field ends up with, not as the
	// clicks in the calendar: a day is addressed by its date, which is only on screen while its
	// month is shown, so a replay on another day would not find it. A click on the field's icon or
	// in its popup arms the field; its next change event reports the new value as a fill.
	//
	// Kept per control, not per input element: a view that is drawn again replaces the field's
	// input, while the control and its change listener stay. Every click in the picker takes the
	// field's value again, so a pick that was cancelled leaves no stale value behind.
	type Armed = { field: Editable; described: Promise<Described>; before: string };
	const armed = new WeakMap<Control, Armed>();
	const pickerAt = new WeakMap<Element, string>();
	const listening = new WeakSet<Control>();
	const fieldOf = (picker: Control) => {
		const field = picker.getFocusDomRef();
		return isEditable(field) ? field : undefined;
	};
	const armPicker = (target: Element) => {
		const picker = pickerOf(target);
		const field = picker && fieldOf(picker);
		if (!picker || !field) return;
		pickerAt.set(target, picker.getId());
		// A click into the field itself is typing, recorded as such.
		if (field.contains(target)) return;
		const known = armed.get(picker);
		armed.set(picker, {
			field,
			// Described once per input element, before its value changes.
			described: known?.field === field ? known.described : describe(field),
			before: field.value
		});
		if (listening.has(picker) || !picker.attachChange) return;
		listening.add(picker);
		picker.attachChange(() => {
			const pick = armed.get(picker);
			armed.delete(picker);
			const now = fieldOf(picker);
			if (!pick || !now || pick.before === now.value) return;
			const typed = fields.get(now);
			if (typed) typed.value = now.value;
			const step = {
				...next(),
				action: 'fill',
				value: now.value,
				picker: picker.getId(),
				hint: hintFor(now)
			};
			const described = pick.field === now ? pick.described : describe(now);
			void described.then((found) => report({ ...step, ...found }));
		});
	};
	const recordTyping = (field: Editable) => {
		const known = fields.get(field);
		if (!known || known.value === field.value) return;
		known.secret ||= isSecret(field);
		const typed = known.secret ? { secret: true } : { value: field.value };
		const typedAt = known.typedAt === undefined ? {} : { at: known.typedAt };
		const step = { ...next(), ...typedAt, action: 'fill', ...typed, hint: hintFor(field) };
		known.value = field.value;
		known.typedAt = undefined;
		// Typed by hand: the picker's change that follows is this value, already recorded.
		const picker = pickerOf(field);
		if (picker) armed.delete(picker);
		void known.described.then((described) => report({ ...step, ...described }));
	};
	// Typing is reported when the field is left. A recording that ends with the cursor still in a
	// field (Stop pressed, window closed) would lose that field, so it is reported then as well.
	state.flush = () => {
		if (isEditable(document.activeElement)) recordTyping(document.activeElement);
	};
	window.addEventListener('pagehide', state.flush);
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
			if (!isEditable(field) || !watched(field)) return;
			const typedAt = performance.timeOrigin + performance.now();
			const known = fields.get(field);
			if (known) {
				known.typedAt = typedAt;
				return;
			}
			fields.set(field, {
				described: describe(field),
				value: field.value === '' ? ' ' : '',
				secret: isSecret(field),
				typedAt
			});
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
			// Enter, and Tab out of a field: UI5 takes and checks a typed value when the field is left
			// (an error such as "Enter a number" shows then), and the replay must leave it the same way.
			const key =
				event.key === 'Tab'
					? event.shiftKey
						? 'Shift+Tab'
						: 'Tab'
					: event.key === 'Enter' && 'Enter';
			if (!key || !isEditable(target) || !watched(target)) return;
			const { described } = enter(target);
			recordTyping(target);
			const step = { ...next(), action: 'press', key, hint: hintFor(target) };
			void described.then((found) => report({ ...step, ...found }));
		},
		true
	);

	// Checks. The Check button turns the next click into a check of what was clicked: a field's
	// value, whether a checkbox is ticked, a text, else that the control is shown. That click
	// never reaches the app, so checking a button does not press it.
	const overlay = document.createElement('div');
	overlay.style.cssText =
		'position:fixed;z-index:2147483646;pointer-events:none;outline:2px solid #0a6ed1;' +
		'background:rgba(10,110,209,.08);border-radius:2px';
	state.setChecking = (on) => {
		// What was typed into the field that has the focus comes first: the check may be of that
		// value. Neither the Check button nor the check click takes the focus out of the field.
		if (on) state.flush?.();
		state.checking = on;
		if (!on) overlay.remove();
		showBadge();
	};
	// The mode is the same in every frame of the page: the recorder outside passes it on, and a
	// document that loads later (an iframe of a launchpad, a page after a round trip) asks for it.
	const checkEverywhere = (on: boolean) => {
		state.setChecking?.(on);
		void win[binding]({ action: 'checking', checked: on });
	};
	void win[binding]({ action: 'mode' }).then((on) => {
		if (on === true && !state.checking) state.setChecking?.(true);
		return on;
	});
	const TICKABLE =
		'input[type=checkbox],input[type=radio],[role=checkbox],[role=radio],[role=switch]';
	const isTickable = (element: Element) => element.matches(TICKABLE);
	const tickedOf = (element: Element) =>
		element instanceof HTMLInputElement
			? element.checked
			: element.getAttribute('aria-checked') === 'true';
	// A field one types into: no checkbox, radio button or push button.
	const isTextField = (element: Element | null): element is Editable =>
		isEditable(element) &&
		!element.matches(TICKABLE) &&
		!['button', 'submit', 'reset', 'image'].includes(element.type);
	// The input of the field an element is in (sap.m.Input, DatePicker, TextArea and the like).
	const fieldAround = (target: Element): Editable | undefined => {
		if (isTextField(target)) return target;
		let control = state.ready ? controlOf(target) : undefined;
		for (let level = 0; control && level < 3; level++, control = control.getParent() ?? undefined) {
			if (!control.isA('sap.m.InputBase')) continue;
			const field = control.getFocusDomRef();
			return isTextField(field) ? field : undefined;
		}
		return undefined;
	};
	type Checked = { element: Element; check: 'value' | 'checked' | 'text' };
	const checkedAt = (target: Element): Checked => {
		const tickable = target.closest(TICKABLE);
		if (tickable) return { element: tickable, check: 'checked' };
		const field = fieldAround(target);
		if (field) return { element: field, check: 'value' };
		return { element: buttonAround(target) ?? target, check: 'text' };
	};
	// The element the written locator will find: what UI5 resolves the selector to, or for WebGUI
	// the element whose lsdata holds the SID, as the sid engine finds it.
	const resolvedBy = (described: Described): Element | undefined => {
		const { sid } = described;
		if (sid)
			return [...document.querySelectorAll('[lsdata]')].find((holder) =>
				(holder.getAttribute('lsdata') ?? '').includes(`"SID":"${sid}"`)
			);
		if (!described.selector || described.innerText || described.chartPoint) return undefined;
		try {
			// oxlint-disable-next-line no-underscore-dangle -- UI5's name
			return finder?._findElements(JSON.parse(JSON.stringify(described.selector)))[0];
		} catch {
			return undefined;
		}
	};
	// The text as toHaveText compares it: textContent with its white space collapsed.
	const textOf = (element: Element) =>
		(element.textContent ?? '').replaceAll('\u200b', '').replace(/\s+/g, ' ').trim();
	const LONGEST_TEXT = 200;
	// What a checked field or checkbox held when it was clicked. Describing it can take a while (UI5
	// works out the selector), and the person may type on meanwhile: the check is of what was there.
	type Seen = { value?: string; checked?: boolean };
	const checkStep = (described: Described, at: Checked, seen: Seen): PageStep => {
		const located = described.chartPoint || described.innerText || described.alert;
		const element = resolvedBy(described) ?? at.element;
		if (!located && at.check === 'value' && isTextField(element) && !isSecret(element))
			return { action: 'expect', check: 'value', value: seen.value ?? element.value };
		if (!located && at.check === 'checked' && isTickable(element))
			return { action: 'expect', check: 'checked', checked: seen.checked ?? tickedOf(element) };
		const text = textOf(element);
		if (!located && at.check === 'text' && text && text.length <= LONGEST_TEXT)
			return { action: 'expect', check: 'text', value: text };
		// A password is never written down, not even as a check of its value.
		return { action: 'expect', check: 'visible' };
	};
	const BLOCKED = [
		'pointerdown',
		'mousedown',
		'pointerup',
		'mouseup',
		'dblclick',
		'touchstart',
		'touchend'
	];
	const block = (event: Event) => {
		event.preventDefault();
		event.stopImmediatePropagation();
	};
	for (const type of BLOCKED)
		window.addEventListener(
			type,
			(event) => {
				// A press on the bar must not take the focus out of a field or close a popup.
				if (ours(event) || state.checking) block(event);
			},
			{ capture: true, passive: false }
		);
	window.addEventListener(
		'click',
		(event) => {
			if (ours(event)) {
				block(event);
				if (event.composedPath().includes(checkButton)) checkEverywhere(!state.checking);
				return;
			}
			if (!state.checking || !(event.target instanceof Element)) return;
			block(event);
			// Typed while in the check mode: the keyboard is not blocked.
			state.flush?.();
			checkEverywhere(false);
			if (!watched(event.target)) return;
			const at = checkedAt(event.target);
			const step = { ...next(), hint: hintFor(at.element) };
			// A field's value is read now, before the next input can change it.
			const { element } = at;
			const typed = isTextField(element) && !isSecret(element) ? element.value : undefined;
			// Whether a checkbox is ticked is read once the click is over: a native checkbox ticks
			// itself before the click event and only goes back when the event has been cancelled.
			// Busy until then, so that the end of a recording waits for this step.
			state.busy++;
			const over = new Promise((done) => setTimeout(done));
			void over
				.then(async () => {
					const seen: Seen = {
						value: typed,
						checked: isTickable(element) ? tickedOf(element) : undefined
					};
					const described = await describe(element);
					return report({ ...step, ...described, ...checkStep(described, at, seen) });
				})
				.finally(() => state.busy--);
		},
		true
	);
	window.addEventListener(
		'mousemove',
		(event) => {
			if (!state.checking || !(event.target instanceof Element) || ours(event)) return;
			const box = checkedAt(event.target).element.getBoundingClientRect();
			overlay.style.left = `${box.left}px`;
			overlay.style.top = `${box.top}px`;
			overlay.style.width = `${box.width}px`;
			overlay.style.height = `${box.height}px`;
			if (!overlay.isConnected) document.documentElement.append(overlay);
		},
		true
	);
	window.addEventListener(
		'keydown',
		(event) => {
			if (!state.checking || event.key !== 'Escape') return;
			block(event);
			checkEverywhere(false);
		},
		true
	);
}

/* oxlint-enable unicorn/consistent-function-scoping */

/**
 * What a frame reports when the Check button turns the check mode on or off, and what a new
 * document asks to learn the mode of its page.
 */
type CheckingMode = { action: 'checking'; checked: boolean } | { action: 'mode' };

const isSelector = (value: unknown): value is UI5ControlSelector =>
	typeof value === 'object' && value !== null && Object.keys(value).length > 0;

// The page reports what it likes; only a name that is text is written into the spec.
const isShown = (value: unknown): value is Shown =>
	typeof value === 'object' &&
	value !== null &&
	'name' in value &&
	typeof value.name === 'string' &&
	(!('kind' in value) || typeof value.kind === 'string') &&
	(!('of' in value) || isShown(value.of));

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
	const checking = new WeakMap<Page, boolean>();
	await context.exposeBinding(BINDING, ({ frame }, raw: RecordedStep | CheckingMode) => {
		if (raw.action === 'mode') return checking.get(frame.page()) ?? false;
		if (raw.action === 'checking') {
			// The Check button was pressed, or a check was recorded: the same mode in every frame.
			checking.set(frame.page(), raw.checked);
			for (const other of frame.page().frames())
				if (other !== frame)
					void other
						.evaluate((on) => window.sapRecorderState?.setChecking?.(on), raw.checked)
						.catch(() => undefined);
			return raw.checked;
		}
		const step = {
			...raw,
			selector: isSelector(raw.selector) ? raw.selector : undefined,
			alert: typeof raw.alert === 'string' && raw.alert ? raw.alert : undefined,
			shown: isShown(raw.shown) ? raw.shown : undefined
		};
		arriving.push(
			framePath(frame)
				.catch(() => [])
				.then((frames) => steps.push(frames.length ? { ...step, frames } : step))
		);
		return false;
	});
	await context.addInitScript(recorderScript, BINDING);
	return async () => {
		// What was typed into the field the cursor is still in, and then whatever is on its way.
		const frames = context.pages().flatMap((page) => page.frames());
		await Promise.all(
			frames.map(async (frame) => {
				try {
					await frame.evaluate(() => window.sapRecorderState?.flush?.());
					await frame.waitForFunction(() => !window.sapRecorderState?.busy, null, {
						timeout: 2_000
					});
				} catch {
					// The page is closing or gone: its pagehide has reported what it could.
				}
			})
		);
		await Promise.all(arriving);
		// oxlint-disable-next-line unicorn/no-array-sort -- toSorted is not in the ES2022 library this project compiles against; the copy keeps `steps` untouched
		return [...steps].sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.seq - b.seq);
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
	const frames = step.frames ?? [];
	if (step.alert) {
		const scope = frames.length
			? frames
					.slice(1)
					.reduce((frame, next) => frame.frameLocator(next), page.frameLocator(frames[0]))
			: page;
		return scope.getByRole('alert').filter({ hasText: step.alert });
	}
	const selector = step.selector
		? ui5ControlSelector(step.selector)
		: step.sid && sidSelector(step.sid);
	if (!selector) return undefined;
	const found = frames.length
		? frames
				.slice(1)
				.reduce((frame, next) => frame.frameLocator(next), page.frameLocator(frames[0]))
				.locator(selector)
		: page.locator(selector);
	if (step.chartPoint) return found.locator(ui5ChartPointSelector(step.chartPoint));
	return step.innerText ? found.getByText(step.innerText, { exact: true }) : found;
}

// A string literal in single quotes. A line break inside it would end the line of code, so line
// breaks (a multi-line text field) are written as escapes.
const ESCAPES: Record<string, string> = {
	'\\': '\\\\',
	"'": "\\'",
	'\n': '\\n',
	'\r': '\\r',
	'\u2028': '\\u2028',
	'\u2029': '\\u2029'
};
const quote = (text: string) =>
	`'${text.replace(/[\\'\n\r\u2028\u2029]/g, (character) => ESCAPES[character] ?? character)}'`;

/** The variable a recorded password is read from; whoever cleans up the spec gives it its name. */
const PASSWORD_VARIABLE = 'process.env.RECORDED_PASSWORD';

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
	// A message toast is no UI5 control: stock Playwright finds it by its role and its text.
	if (step.alert)
		return `page${frames}.getByRole('alert').filter({ hasText: ${quote(step.alert)} })`;
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
	if (step.chartPoint)
		return `${found}.locator(ui5ChartPointSelector(${literal(step.chartPoint)}))`;
	return step.innerText ? `${found}.getByText(${quote(step.innerText)}, { exact: true })` : found;
}

// The assertion of a recorded check, Playwright's own web-first matchers: they wait for the value.
function matcher(step: RecordedStep): string {
	if (step.check === 'value') return `.toHaveValue(${quote(step.value ?? '')})`;
	if (step.check === 'text') return `.toHaveText(${quote(step.value ?? '')})`;
	if (step.check === 'checked') return step.checked ? '.toBeChecked()' : '.not.toBeChecked()';
	return '.toBeVisible()';
}

/** What a step acts on, to tell whether two steps use the same element. */
const target = (step: RecordedStep) =>
	JSON.stringify([
		step.selector,
		step.sid,
		step.frames,
		step.innerText,
		step.chartPoint,
		step.alert
	]);

/** The step's lines, and whether they name its element (or a comment before already did). */
function stepLines(step: RecordedStep, alreadyNamed = false): { lines: string[]; named: boolean } {
	const lines: string[] = [];
	// One line: a hint is text from the page and may hold line breaks.
	const hint = step.hint?.replace(/\s+/g, ' ').trim();
	if (step.problem) lines.push(`// FIXME: ${step.problem}${hint ? ` (${hint})` : ''}`);
	const locator = locatorCode(step);
	if (!locator) {
		lines.push(`// ${step.action} was not recorded`);
		return { lines, named: false };
	}
	const said = stepCode(step, locator);
	const shown = shownComment(step.shown);
	// Named only where the code does not say it already (an ID-only selector, a SID) and no comment
	// named it for the steps on the same element before, on the line right above the statement,
	// below a FIXME of its own: the Tests page reads it from there.
	const inCode = !!step.shown && said.some((line) => line.includes(quote(step.shown!.name)));
	const writes = !!shown && !inCode && !alreadyNamed;
	if (writes) {
		const statement = said.findIndex((line) => !line.startsWith('//'));
		said.splice(statement === -1 ? said.length : statement, 0, shown);
	}
	lines.push(...said);
	return { lines, named: writes };
}

// One part of the comment: `the "Supplier" field`.
// A double quote in a name would end it early for whoever reads the comment, the Tests page too.
function phrase(part: { name: string; kind?: string } | undefined): string | undefined {
	const name = part?.name.replace(/\s+/g, ' ').replaceAll('"', "'").trim();
	const kind = part?.kind?.replace(/\s+/g, ' ').trim();
	return name ? `the "${name}"${kind ? ` ${kind}` : ''}` : undefined;
}

/**
 * `// the "Supplier Information" button`, `// the "Show Value Help" icon of the "Supplier" field`:
 * the control as the recording person saw it.
 */
function shownComment(shown: Shown | undefined): string | undefined {
	const own = phrase(shown);
	if (!own) return undefined;
	const of = phrase(shown?.of);
	return `// ${own}${of ? ` of ${of}` : ''}`;
}

function stepCode(step: RecordedStep, locator: string): string[] {
	const lines: string[] = [];
	if (step.action === 'click')
		lines.push(`await ${locator}.click(${step.force ? '{ force: true }' : ''});`);
	if (step.action === 'fill' && step.secret)
		lines.push(
			`// FIXME: a password was typed here. It was not recorded: set ${PASSWORD_VARIABLE.replace('process.env.', '')} or name the variable that holds it.`,
			`await fillSecret(${locator}, ${PASSWORD_VARIABLE}!);`
		);
	else if (step.action === 'fill') lines.push(`await ${locator}.fill(${quote(step.value ?? '')});`);
	// A date or time field takes a filled-in value when it is left, as the picker's change did
	// right away. The app may wait for that change (a wizard's next button). Leaving the field,
	// not Enter: Enter may do more (start the search of a filter bar), and an Enter the user
	// pressed is recorded as a step of its own.
	if (step.action === 'fill' && step.picker) lines.push(`await ${locator}.blur();`);
	if (step.action === 'press') lines.push(`await ${locator}.press(${quote(step.key ?? '')});`);
	if (step.action === 'expect') lines.push(`await expect(${locator})${matcher(step)};`);
	return lines;
}

/** The environment variables of a system's address, user and password (systems.json). */
export type SystemEnv = { url: string; user: string; password: string };

const SAP_ENV: SystemEnv = { url: 'SAP_URL', user: 'SAP_USERNAME', password: 'SAP_PASSWORD' };

export type SpecOptions = {
	/** The test's title. */
	name?: string;
	/** Start with page.SAPLogin and the credentials from the environment instead of page.goto. */
	login?: boolean;
	/** The start page is the system's configured address: read it from the environment as well. */
	urlFromEnv?: boolean;
	/** The variables the spec reads the address and the login from; SAP_URL, … by default. */
	env?: SystemEnv;
};

/** The recorded steps as a spec. `pluginImport` is the path to sap-plugin from the spec's folder. */
export function renderSpec(
	url: string,
	steps: RecordedStep[],
	pluginImport: string,
	options: SpecOptions = {}
): string {
	const env = options.env ?? SAP_ENV;
	const address = options.urlFromEnv ? `process.env.${env.url}` : quote(url);
	const start = options.login
		? `await page.SAPLogin(process.env.${env.user}!, process.env.${env.password}!, ${address});`
		: `await page.goto(${address}${options.urlFromEnv ? '!' : ''});`;
	// fill() focuses the field itself: the click a person makes to get into it adds nothing.
	// The clicks in a date picker around the value it put into the field: the fill of the value
	// stands for them. The calendar sets the value when the mouse button goes up, before the
	// click event, so the last click of a pick comes right after its fill.
	const pickerClicks = new Set<RecordedStep>();
	steps.forEach((step, index) => {
		if (step.action !== 'fill' || !step.picker) return;
		for (const direction of [-1, 1])
			for (let other = index + direction; other >= 0 && other < steps.length; other += direction) {
				const near = steps[other];
				if (near?.action !== 'click' || near.picker !== step.picker) break;
				pickerClicks.add(near);
			}
	});
	const kept = steps.filter((step, index) => {
		const next = steps[index + 1];
		if (pickerClicks.has(step)) return false;
		return !(step.action === 'click' && next?.action === 'fill' && target(step) === target(next));
	});
	// A run of steps on one element is named once: the step that starts it, or the first one whose
	// code does not say the name itself.
	let named: string | undefined;
	const lines = kept.flatMap((step) => {
		const written = stepLines(step, named === target(step));
		named = written.named || named === target(step) ? target(step) : undefined;
		return written.lines;
	});
	const body = [start, ...lines].join('\n');
	const names = [
		'test',
		'expect',
		'fillSecret',
		'ui5ControlSelector',
		'ui5ChartPointSelector',
		'locateSIDSelector'
	].filter((name) => name === 'test' || body.includes(`${name}(`));
	return [
		`import { ${names.join(', ')} } from ${quote(pluginImport)};`,
		'',
		`test(${quote(options.name?.trim() || 'recorded')}, async ({ page }) => {`,
		...body.split('\n').map((line) => `\t${line}`),
		'});',
		''
	].join('\n');
}
