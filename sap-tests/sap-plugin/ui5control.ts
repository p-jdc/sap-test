// SPIKE. A locator that takes a UI5 control selector, the format OPA5 and wdi5 use and that UI5's
// own sap.ui.test.RecordReplay generates. Unlike getByRoleUI5 it can say "the control inside the
// list item bound to /Products('HT-2001')", so it needs no position. UI5 resolves the selector
// itself; nothing here is from the Playwright-SAP fork.

/** A UI5 control selector, as documented for sap.ui.test.RecordReplay and OPA5's waitFor. */
export type UI5ControlSelector = {
	id?: string;
	controlType?: string;
	viewName?: string;
	viewId?: string;
	properties?: Record<string, unknown>;
	bindingPath?: { path?: string; propertyPath?: string; modelName?: string };
	i18NText?: { propertyName: string; key: string; modelName?: string };
	labelFor?: { text?: string; key?: string; modelName?: string };
	ancestor?: UI5ControlSelector;
	descendant?: UI5ControlSelector;
	/** A control next to it: its selector, then options such as `{ level: 0 }`. */
	sibling?:
		| UI5ControlSelector
		| [UI5ControlSelector, { level?: number; prev?: boolean; next?: boolean }?];
	/** Which part of the control to act on, e.g. `{ idSuffix: 'inner' }`; 'root' is all of it. */
	interaction?: 'root' | 'focus' | 'press' | 'auto' | { idSuffix?: string };
	searchOpenDialogs?: boolean;
};

export const UI5_CONTROL_ENGINE = 'ui5control';

/** The selector string for page.locator(). The JSON is the engine's whole body. */
export const ui5ControlSelector = (selector: UI5ControlSelector) =>
	`${UI5_CONTROL_ENGINE}=${JSON.stringify(selector)}`;

type ControlFinder = { _findElements(selector: unknown): Element[] };
type AutoWaiter = { hasToWait(): boolean };
type Ui5Require = {
	(module: 'sap/ui/test/_ControlFinder'): ControlFinder | undefined;
	(module: 'sap/ui/test/autowaiter/_autoWaiter'): AutoWaiter | undefined;
	(modules: string[]): void;
};

/**
 * The engine, for selectors.register(). Runs in the page. Selector engines must answer
 * synchronously, and UI5's public RecordReplay.findAllDOMElementsByControlSelector is async, so
 * this calls the finder behind it (sap/ui/test/_ControlFinder, private API).
 *
 * Like OPA5 it finds nothing while UI5 is busy (open request, timer, rendering) or the modules are
 * still loading. Playwright retries, so a locator waits for the app to come to rest: without that,
 * a step right after page load acts on a control that UI5 is about to render again, and typed
 * text is lost.
 */
export function ui5ControlEngine() {
	return {
		queryAll(root: Node, body: string): Element[] {
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- UI5's loader is a global of the page; ui5.ts declares it without these two modules
			const require = (window as unknown as { sap?: { ui?: { require?: Ui5Require } } }).sap?.ui
				?.require;
			if (!require) throw new Error('SAP UI5 not found in page');
			const finder = require('sap/ui/test/_ControlFinder');
			const autoWaiter = require('sap/ui/test/autowaiter/_autoWaiter');
			if (!finder || !autoWaiter) {
				require(['sap/ui/test/_ControlFinder', 'sap/ui/test/autowaiter/_autoWaiter']);
				return [];
			}
			if (!document.querySelector('[data-sap-ui-area] > *') || autoWaiter.hasToWait()) return [];
			// oxlint-disable-next-line no-underscore-dangle -- UI5's name
			const found = finder._findElements(JSON.parse(body));
			return found.filter((element) => root === element || root.contains(element));
		}
	};
}
