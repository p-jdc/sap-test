import type { FlowStep, LocatorInfo } from './types';

/** `GenericTile`, `reviewsTile`, `SAP_USERNAME` → `generic tile`, `reviews tile`, `sap username`. */
function words(name: string): string {
	return name
		.replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replaceAll(/[_.-]+/g, ' ')
		.trim()
		.toLowerCase();
}

function sentence(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

const quote = (text: string) => `“${text}”`;

/** Settings the tests read at run time; the parser shows them as `$NAME`. */
const SAVED: Record<string, string> = {
	SAP_URL: 'the SAP address',
	SAP_USERNAME: 'the SAP user',
	SAP_PASSWORD: 'the SAP password',
	ARIBA_URL: 'the Ariba address',
	ARIBA_USER: 'the Ariba user',
	ARIBA_PASS: 'the Ariba password',
	SAP_API_URL: 'the SAP services address',
	SAP_API_USERNAME: 'the SAP services user',
	SAP_API_PASSWORD: 'the SAP services password',
	SAP_CLIENT: 'the SAP client'
};

/** A step's value in words: saved settings by what they are, everything else quoted. */
function valueText(value: string | undefined): string {
	if (value === undefined) return 'a value';
	const saved = /^\$([A-Z0-9_]+)$/.exec(value);
	if (saved) return SAVED[saved[1] ?? ''] ?? 'a saved value';
	return quote(value);
}

const STRING = String.raw`(?<q>['"\`])(?<text>(?:\\.|(?!\k<q>).)*?)\k<q>`;
const FIRST_ARG = new RegExp(String.raw`^(\w+)\(\s*(?:${STRING})?`);
const PROPERTY = new RegExp(String.raw`\b\w+\s*:\s*${STRING}`, 'g');
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** Helper functions whose name says what kind of control they find. */
const HELPER_NOUN: Record<string, string> = { button: 'button', input: 'field', field: 'field' };

/** `sap.m.Button` → `button`. */
const typeNoun = (controlType: string | undefined) =>
	controlType ? words(controlType.slice(controlType.lastIndexOf('.') + 1)) : 'element';

const CONTROL_SELECTOR = /(?:locateUI5Control|ui5ControlSelector)\((?<selector>.*)/s;
const quoted = (key: string) => new RegExp(String.raw`\b${key}\s*:\s*${STRING}`);
const inObject = (key: string, inner: string) =>
	new RegExp(String.raw`\b${key}\s*:\s*\{[^}]*?\b${inner}\s*:\s*${STRING}`);

/**
 * A UI5 control selector (locateUI5Control, as the recorder writes it) in words. The control is
 * named by what a person sees of it where the selector says so (its label, a text), otherwise by
 * its text key, the record it shows or its ID. What it sits in (`ancestor`) is left out.
 */
function controlTarget(selector: string): string {
	const own = selector.split(/\b(?:ancestor|sibling|descendant)\s*:/)[0] ?? selector;
	const text = (pattern: RegExp) => pattern.exec(own)?.groups?.text?.replaceAll(/\\(.)/g, '$1');
	const noun = typeNoun(text(quoted('controlType')));

	const label = text(inObject('labelFor', 'text'));
	if (label) return `the ${quote(label)} ${noun}`;
	const properties = /\bproperties\s*:\s*\{(?<body>.*)/s.exec(own)?.groups?.body ?? '';
	const shown = [...properties.matchAll(PROPERTY)].map((m) => m.groups?.text).find(Boolean);
	if (shown) return `the ${quote(shown)} ${noun}`;
	const key = text(inObject('i18NText', 'key'));
	if (key) return `the ${quote(words(key))} ${noun}`;
	const record = text(inObject('bindingPath', 'path'));
	if (record) return `the ${noun} of ${quote(record)}`;
	const id = text(quoted('id'));
	// `container-cart---checkoutView--creditCardNumber` → the credit card number
	if (id) return `the ${words(id.slice(id.lastIndexOf('--') + 2))}`;
	return `the ${noun}`;
}

/**
 * What a locator points at, in words: `the “Save” button`, `“Material”`, `the table`. Undefined
 * when only code identifies the element (CSS, XPath, an SAP screen path, a test id).
 */
export function targetText(locator: LocatorInfo | undefined): string | undefined {
	if (!locator) return undefined;
	// What the recording person saw, as the recorder noted it: `the "Go" button`.
	if (locator.shown)
		return locator.shown.replaceAll(/"([^"]*)"/g, (_, text: string) => quote(text));
	const { kind, display } = locator;
	if (
		kind === 'css' ||
		kind === 'xpath' ||
		kind === 'ui5-xpath' ||
		kind === 'sid-path' ||
		kind === 'testid'
	) {
		return undefined;
	}
	// A variable that holds a locator: `reviewsTile` → the reviews tile.
	if (IDENTIFIER.test(display)) return `the ${words(display)}`;

	const control = CONTROL_SELECTOR.exec(display)?.groups?.selector;
	if (control) return controlTarget(control);

	const call = FIRST_ARG.exec(display);
	if (!call) return undefined;
	const method = call[1] ?? '';
	const first = call.groups?.text;

	if (method === 'getByRole' || method === 'getByRoleUI5' || method === 'getByRoleSID') {
		// The first non-empty text property names the control: { name: 'Save' }, { text: 'Save' }.
		const name = [...display.matchAll(PROPERTY)].map((m) => m.groups?.text).find(Boolean);
		const role = first ? words(first) : 'element';
		return name ? `the ${quote(name)} ${role}` : `the ${role}`;
	}
	if (!first) return undefined;
	const noun = locator.helper ? HELPER_NOUN[locator.helper] : undefined;
	return noun ? `the ${quote(first)} ${noun}` : quote(first);
}

const ELEMENT = 'an element on the screen';

function navigateText(step: FlowStep): string {
	switch (step.action) {
		case 'setContent':
			return 'Open the built-in demo page';
		case 'reload':
			return 'Reload the page';
		case 'goBack':
			return 'Go back one page';
		case 'goForward':
			return 'Go forward one page';
		default: {
			const { value } = step;
			if (!value) return 'Open a page';
			try {
				return `Open ${new URL(value).host}`;
			} catch {
				// Not a full address: a saved setting ($SAP_URL) or a path inside the system.
				return `Open ${valueText(value)}`;
			}
		}
	}
}

function waitText(step: FlowStep): string {
	const ms = Number(step.value);
	if (step.action === 'waitForTimeout' && Number.isFinite(ms) && ms > 0) {
		const s = ms / 1000;
		return `Wait ${s} second${s === 1 ? '' : 's'}`;
	}
	return 'Wait until the page is ready';
}

function actionText(step: FlowStep): string {
	const target = targetText(step.locator) ?? ELEMENT;
	const value = valueText(step.value);
	switch (step.action) {
		case 'click':
		case 'tap':
			return `Click ${target}`;
		case 'dblclick':
			return `Double-click ${target}`;
		case 'fill':
		case 'fillSecret':
		case 'type':
		case 'pressSequentially':
			return step.value === '' ? `Clear ${target}` : `Enter ${value} in ${target}`;
		case 'clear':
			return `Clear ${target}`;
		case 'check':
			return `Tick ${target}`;
		case 'uncheck':
			return `Untick ${target}`;
		case 'selectOption':
			return `Choose ${value} in ${target}`;
		case 'hover':
			return `Point at ${target}`;
		case 'focus':
			return `Go to ${target}`;
		case 'blur':
			return `Leave ${target}`;
		case 'setInputFiles':
			return `Upload a file to ${target}`;
		case 'dragTo':
			return `Drag ${target}`;
		case 'press':
		case 'keyboard.press':
			return `Press the ${step.value ?? ''} key`.replace('  ', ' ');
		case 'keyboard.type':
			return `Type ${value}`;
		default:
			return sentence(`${words(step.action)} ${target}`);
	}
}

/** Per matcher: what is true about the target when the check passes, and its opposite. */
const CHECKS: Record<string, [string, string]> = {
	toBeVisible: ['is shown', 'is not shown'],
	toBeHidden: ['is not shown', 'is shown'],
	toBeAttached: ['exists', 'does not exist'],
	toBeEnabled: ['can be used', 'cannot be used'],
	toBeDisabled: ['cannot be used', 'can be used'],
	toBeEditable: ['can be edited', 'cannot be edited'],
	toBeChecked: ['is ticked', 'is not ticked'],
	toBeFocused: ['is selected', 'is not selected'],
	toBeEmpty: ['is empty', 'is not empty']
};
const CHECKS_WITH_VALUE: Record<string, [string, string]> = {
	toHaveText: ['says', 'does not say'],
	toContainText: ['contains', 'does not contain'],
	toHaveValue: ['has the value', 'does not have the value'],
	toHaveCount: ['appears this many times:', 'does not appear this many times:']
};

const PROPERTY_PATH = /^([A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)*$/;

/** A checked value in words: `products.length` → `the products`; an expression → `a result`. */
function valueSubject(display: string): string {
	const name = PROPERTY_PATH.exec(display)?.[1];
	return name ? `the ${words(name)}` : 'a result';
}

function assertText(step: FlowStep): string {
	const negated = step.action.startsWith('not.');
	const matcher = negated ? step.action.slice(4) : step.action;
	const pick = (pair: [string, string]) => pair[negated ? 1 : 0];
	const target = targetText(step.locator) ?? ELEMENT;

	if (matcher === 'toHaveURL')
		return `Check that the right page ${negated ? 'did not open' : 'opened'}`;
	if (matcher === 'toHaveTitle') {
		return `Check that the page title ${negated ? 'is not' : 'is'} ${valueText(step.value)}`;
	}
	if (matcher === 'toHaveValue' && step.value === '') {
		return `Check that ${target} ${pick(['is empty', 'is not empty'])}`;
	}
	const plain = CHECKS[matcher];
	if (plain) return `Check that ${target} ${pick(plain)}`;
	const withValue = CHECKS_WITH_VALUE[matcher];
	if (withValue) {
		const value = matcher === 'toHaveCount' ? (step.value ?? '') : valueText(step.value);
		return `Check that ${target} ${pick(withValue)} ${value}`.trimEnd();
	}
	// Any other matcher on something that is not a locator checks a value the test read or computed.
	if (step.locator?.kind === 'other') {
		return `Check ${targetText(step.locator) ?? valueSubject(step.locator.display)}`;
	}
	return `Check ${target}`;
}

/** Requests to an SAP service (OData), by what they do; the parser names them `odata.<operation>`. */
const SERVICE_CALLS: Record<string, string> = {
	'odata.getAll': 'Read data from the SAP service',
	'odata.getByKey': 'Read one entry from the SAP service',
	'odata.create': 'Create an entry in the SAP service',
	'odata.update': 'Change an entry in the SAP service',
	'odata.delete': 'Delete an entry in the SAP service',
	'odata.batch': 'Send several requests to the SAP service at once',
	'odata.request': 'Call the SAP service'
};

function otherText(step: FlowStep): string {
	const call = SERVICE_CALLS[step.action];
	if (call) return step.value ? `${call}: ${words(step.value)}` : call;
	switch (step.action) {
		case 'ui5BoundData':
			return `Read the entries loaded in ${targetText(step.locator) ?? 'a list'}`;
		case 'ui5ModelProperty':
			return `Read a value behind ${targetText(step.locator) ?? ELEMENT}`;
		case 'ui5HasPendingChanges':
			return 'Look for unsaved changes';
		case 'for':
		case 'while':
		case 'do':
			return 'Repeat the next steps';
		case 'if':
		case 'switch':
			return 'Depending on the situation';
		case 'try':
			return 'Try the next steps';
		default:
			return sentence(words(step.action)) || 'Other step';
	}
}

const TEXT: Record<FlowStep['kind'], (step: FlowStep) => string> = {
	navigate: navigateText,
	login: () => 'Log in to SAP',
	wait: waitText,
	action: actionText,
	assert: assertText,
	group: (step) => step.value ?? 'Group of steps',
	helper: (step) => sentence(words(step.action)) + (step.value ? `: ${step.value}` : ''),
	other: otherText
};

/** One test step as a sentence a person who does not read code can follow. */
export function describeStep(step: FlowStep): string {
	return TEXT[step.kind](step);
}
