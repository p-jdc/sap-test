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
	ARIBA_PASS: 'the Ariba password'
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

/**
 * What a locator points at, in words: `the “Save” button`, `“Material”`, `the table`. Undefined
 * when only code identifies the element (CSS, XPath, an SAP screen path, a test id).
 */
export function targetText(locator: LocatorInfo | undefined): string | undefined {
	if (!locator) return undefined;
	const { kind, display } = locator;
	if (kind === 'css' || kind === 'xpath' || kind === 'sid-path' || kind === 'testid') {
		return undefined;
	}
	// A variable that holds a locator: `reviewsTile` → the reviews tile.
	if (IDENTIFIER.test(display)) return `the ${words(display)}`;

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
	return `Check ${target}`;
}

function otherText(step: FlowStep): string {
	switch (step.action) {
		case 'for':
		case 'while':
		case 'do':
			return 'Repeat the next steps';
		case 'if':
		case 'switch':
			return 'Depending on the screen';
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
