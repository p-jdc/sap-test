// UI5 state that the DOM does not show: whether the framework is still busy, and what its models
// hold. Everything here runs in the page against UI5's own API; a page without UI5 gets an error.
import type { Locator, Page } from '@playwright/test';

export type WaitForUI5Options = {
	/** Milliseconds to wait for UI5 to come to rest. Default 30 000. */
	timeout?: number;
};

// The few parts of UI5's API used below.
interface Ui5Context {
	getObject(): unknown;
	getProperty(path: string): unknown;
}
interface Ui5Model {
	getProperty?(path: string): unknown;
	hasPendingChanges?(): boolean;
}
interface Ui5Control {
	getBinding(name: string): { getCurrentContexts(): (Ui5Context | undefined)[] } | undefined;
	getBindingContext(model?: string): Ui5Context | null | undefined;
	getModel(name?: string): Ui5Model | undefined;
	getParent(): Ui5Control | null | undefined;
}
interface Ui5Global {
	ui: {
		// With a module name, `require` returns the module if it is already loaded; with a list it
		// starts loading.
		require: {
			(module: 'sap/ui/test/autowaiter/_autoWaiter'): { hasToWait(): boolean } | undefined;
			(
				module: 'sap/ui/core/Element'
			): { closestTo?(element: Element): Ui5Control | undefined } | undefined;
			(modules: string[]): void;
		};
		getCore?(): { byId(id: string): Ui5Control | undefined };
	};
}
declare global {
	interface Window {
		sap?: Partial<Ui5Global>;
	}
}

type ModelRequest =
	| { read: 'boundData'; aggregation: string }
	| { read: 'property'; path: string; model?: string }
	| { read: 'pendingChanges'; model?: string };

// Runs in the page. UI5 counts as at rest when it has rendered something and its own test
// autowaiter (the one OPA5 uses) sees no open request, timer, promise or pending rendering.
function ui5IsAtRest(): boolean {
	const { sap } = window;
	if (!sap?.ui?.require) return false;
	const autoWaiter = sap.ui.require('sap/ui/test/autowaiter/_autoWaiter');
	if (!autoWaiter) {
		sap.ui.require(['sap/ui/test/autowaiter/_autoWaiter']);
		return false;
	}
	// The autowaiter only sees work that started after it was loaded, which during the first page
	// load is not everything. Nothing rendered yet means the app is still starting.
	if (!document.querySelector('[data-sap-ui-area] > *')) return false;
	return !autoWaiter.hasToWait();
}

// Runs in the page, on the element a locator resolved to.
function readFromControl(element: Element, request: ModelRequest): unknown {
	const { sap } = window;
	if (!sap?.ui?.require) throw new Error('SAP UI5 not found in page');
	const core = sap.ui.getCore?.();
	let control = sap.ui.require('sap/ui/core/Element')?.closestTo?.(element);
	// UI5 before 1.106 has no closestTo: walk up to the first element that is a control's root.
	for (let node: Element | null = element; !control && node; node = node.parentElement)
		control = node.id ? core?.byId(node.id) : undefined;
	if (!control) throw new Error('No UI5 control found at this element');

	if (request.read === 'boundData') {
		// The nearest control that has this binding, so a locator may also point into the list:
		// the fork's engine resolves a sap.m.Table to a field in its toolbar, for example.
		let binding = control.getBinding(request.aggregation);
		for (let parent = control.getParent(); !binding && parent; parent = parent.getParent())
			binding = parent.getBinding(request.aggregation);
		if (!binding)
			throw new Error(
				`Neither the control nor a control around it has "${request.aggregation}" bound to a model`
			);
		return binding
			.getCurrentContexts()
			.filter((context) => !!context)
			.map((context) => context.getObject());
	}

	const modelName = request.model ? `model "${request.model}"` : 'default model';
	const model = control.getModel(request.model);
	if (!model) throw new Error(`The control has no ${modelName}`);
	if (request.read === 'pendingChanges') {
		if (!model.hasPendingChanges)
			throw new Error(`The ${modelName} does not track pending changes (only OData models do)`);
		return model.hasPendingChanges();
	}
	if (!request.path.startsWith('/')) {
		const context = control.getBindingContext(request.model);
		if (!context)
			throw new Error(
				`"${request.path}" is a relative path, but the control has no binding context`
			);
		return context.getProperty(request.path);
	}
	if (!model.getProperty)
		throw new Error(
			`The ${modelName} cannot read absolute paths; use a path relative to the control`
		);
	return model.getProperty(request.path);
}

/**
 * Waits until UI5 has rendered and is at rest: no open request, timer, promise or rendering.
 * Use it after a navigation or an action that loads data, before reading state that does not
 * retry (a model read, a count, a screenshot). Before a click or an `expect` on a locator it is
 * not needed: those wait on their own.
 */
export async function waitForUI5(page: Page, options: WaitForUI5Options = {}): Promise<void> {
	const timeout = options.timeout ?? 30_000;
	try {
		await page.waitForFunction(ui5IsAtRest, undefined, { timeout });
	} catch (error) {
		if (!(error instanceof Error) || error.name !== 'TimeoutError') throw error;
		throw new Error(
			`waitForUI5: UI5 did not come to rest within ${timeout} ms. Either the page has no UI5 ` +
				'(or a version before 1.48), or the app keeps working, e.g. by polling its backend.',
			{ cause: error }
		);
	}
}

/**
 * The entries a list or table has loaded from its model: one object per loaded row, also rows
 * that are scrolled out of view. The locator may point at the list or at anything inside it. `aggregation` is 'items' for sap.m lists and tables, 'rows' for
 * sap.ui.table.
 */
export function ui5BoundData(control: Locator, aggregation = 'items'): Promise<unknown[]> {
	return read(control, { read: 'boundData', aggregation }).then(asArray);
}

/**
 * A value from the control's model. A path starting with '/' is read from the model's root, any
 * other path relative to the control's binding context (the entity a form or row shows).
 */
export function ui5ModelProperty(control: Locator, path: string, model?: string): Promise<unknown> {
	return read(control, { read: 'property', path, model });
}

/** Whether the control's OData model holds changes that are not saved to the backend yet. */
export async function ui5HasPendingChanges(control: Locator, model?: string): Promise<boolean> {
	return (await read(control, { read: 'pendingChanges', model })) === true;
}

const read = (control: Locator, request: ModelRequest) =>
	control.evaluate(readFromControl, request);

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
