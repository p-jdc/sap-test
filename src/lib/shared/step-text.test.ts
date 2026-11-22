/**
 * The plain-language step text is what a non-technical user reads instead of the code, so a wrong
 * sentence (the wrong control, a leaked setting name) misleads without any error.
 */
import { expect, test } from 'vitest';

import { describeStep, targetText } from './step-text.js';
import type { FlowStep, LocatorInfo } from './types.js';

function step(partial: Partial<FlowStep> & Pick<FlowStep, 'kind' | 'action'>): FlowStep {
	return { id: 's1', line: 1, endLine: 1, code: '', issues: [], ...partial };
}
const loc = (kind: LocatorInfo['kind'], display: string, helper?: string): LocatorInfo => ({
	kind,
	display,
	helper
});

test.each<[LocatorInfo, string | undefined]>([
	[loc('label', `getByLabel('Sold-To Party')`), '“Sold-To Party”'],
	[loc('role', `getByRole('button', { name: 'Save' })`), 'the “Save” button'],
	[loc('role', `getByRole('status')`), 'the status'],
	[loc('ui5', `getByRoleUI5('Button', { text: 'Save' })`), 'the “Save” button'],
	[
		loc('ui5', `getByRoleUI5('Input', { label: 'Sold-To Party', value: '' })`),
		'the “Sold-To Party” input'
	],
	[loc('ui5', `getByRoleUI5('GenericTile', { header: PRODUCTION_TILE })`), 'the generic tile'],
	[loc('ui5', `button("Save")`, 'button'), 'the “Save” button'],
	[loc('sid', `field("VBAK-VBELN")`, 'field'), 'the “VBAK-VBELN” field'],
	[loc('other', 'reviewsTile'), 'the reviews tile'],
	// UI5 control selectors, as the recorder in sap-plugin writes them.
	[
		loc(
			'ui5',
			`locateUI5Control({ controlType: 'sap.m.Button', properties: { text: 'Yes' }, searchOpenDialogs: true })`
		),
		'the “Yes” button'
	],
	[
		loc(
			'ui5',
			`locateUI5Control({ controlType: 'sap.m.TextArea', viewName: 'x.Checkout', labelFor: { text: 'Note' }, interaction: { idSuffix: 'inner' } })`
		),
		'the “Note” text area'
	],
	[
		loc(
			'ui5',
			`locateUI5Control({ controlType: 'sap.m.Button', i18NText: { propertyName: 'text', key: 'addToCartShort' } })`
		),
		'the “add to cart short” button'
	],
	// The row is named, not the list it sits in.
	[
		loc(
			'ui5',
			`locateUI5Control({ controlType: 'sap.m.ObjectListItem', bindingPath: { path: '/Products(\\'HT-1106\\')', propertyPath: 'PictureUrl' }, ancestor: { id: 'container-cart---category--productList' } })`
		),
		`the object list item of “/Products('HT-1106')”`
	],
	[
		loc(
			'ui5',
			`locateUI5Control({ id: 'container-cart---checkoutView--creditCardNumber', interaction: { idSuffix: 'inner' } })`
		),
		'the credit card number'
	],
	[
		loc(
			'ui5',
			`frameLocator('iframe[name="application"]').locator(ui5ControlSelector({ controlType: 'sap.m.Link', properties: { text: 'Compare' } }))`
		),
		'the “Compare” link'
	],
	[loc('css', `locator('#__button3-inner')`), undefined],
	[loc('sid-path', `locateSID('wnd[0]/tbar[1]/btn[8]')`), undefined],
	[loc('ui5-xpath', `locateUI5('//ToolPage//SideNavigation')`), undefined]
])('names the target of %o', (locator, expected) => {
	expect(targetText(locator)).toBe(expected);
});

test.each<[FlowStep, string]>([
	[
		step({ kind: 'navigate', action: 'setContent', value: 'inline HTML' }),
		'Open the built-in demo page'
	],
	[
		step({ kind: 'navigate', action: 'goto', value: 'https://ui5.sap.com/test/index.html?x=1' }),
		'Open ui5.sap.com'
	],
	[step({ kind: 'navigate', action: 'goto', value: '$ARIBA_URL' }), 'Open the Ariba address'],
	[
		step({ kind: 'navigate', action: 'goto', value: '$SAP_API_URL' }),
		'Open the SAP services address'
	],
	[step({ kind: 'login', action: 'SAPLogin', value: '$SAP_USERNAME' }), 'Log in to SAP'],
	[
		step({
			kind: 'action',
			action: 'fill',
			locator: loc('label', `getByLabel('Material')`),
			value: 'TG11'
		}),
		'Enter “TG11” in “Material”'
	],
	[
		step({
			kind: 'action',
			action: 'fill',
			locator: loc('label', `getByLabel('Password')`),
			value: '$ARIBA_PASS'
		}),
		'Enter the Ariba password in “Password”'
	],
	[
		step({
			kind: 'action',
			action: 'fillSecret',
			locator: loc('label', `getByLabel('Password')`),
			value: '$SAP_PASSWORD'
		}),
		'Enter the SAP password in “Password”'
	],
	[
		step({ kind: 'action', action: 'click', locator: loc('css', `locator('#__button3-inner')`) }),
		'Click an element on the screen'
	],
	[step({ kind: 'action', action: 'keyboard.press', value: 'Enter' }), 'Press the Enter key'],
	[step({ kind: 'wait', action: 'waitForTimeout', value: '3000' }), 'Wait 3 seconds'],
	[step({ kind: 'wait', action: 'waitForLoadState' }), 'Wait until the page is ready'],
	[step({ kind: 'helper', action: 'runTransaction', value: 'VA03' }), 'Run transaction: VA03'],
	[step({ kind: 'group', action: 'test.step', value: 'Create the order' }), 'Create the order'],
	[step({ kind: 'wait', action: 'waitForUI5' }), 'Wait until the page is ready'],
	[step({ kind: 'other', action: 'for' }), 'Repeat the next steps'],
	[step({ kind: 'other', action: 'if' }), 'Depending on the situation'],
	[
		step({ kind: 'other', action: 'ui5BoundData', locator: loc('other', 'table') }),
		'Read the entries loaded in the table'
	],
	[
		step({
			kind: 'other',
			action: 'ui5ModelProperty',
			locator: loc('ui5', `getByRoleUI5('Input', { label: 'Price' })`)
		}),
		'Read a value behind the “Price” input'
	],
	[step({ kind: 'other', action: 'ui5HasPendingChanges' }), 'Look for unsaved changes'],
	[
		step({ kind: 'other', action: 'odata.getAll', value: 'salesOrders' }),
		'Read data from the SAP service: sales orders'
	],
	[
		step({ kind: 'other', action: 'odata.batch' }),
		'Send several requests to the SAP service at once'
	],
	[
		step({ kind: 'assert', action: 'toBeGreaterThan', locator: loc('other', 'products.length') }),
		'Check the products'
	],
	[
		step({
			kind: 'assert',
			action: 'toBe',
			locator: loc('other', 'created.price?.toNumber()'),
			value: '9.99'
		}),
		'Check a result'
	],
	[
		step({ kind: 'assert', action: 'toBeVisible', locator: loc('other', 'rows.first()') }),
		'Check that an element on the screen is shown'
	],
	[
		step({
			kind: 'assert',
			action: 'toHaveText',
			locator: loc('role', `getByRole('status')`),
			value: 'Sales order 4711 created'
		}),
		'Check that the status says “Sales order 4711 created”'
	],
	[
		step({ kind: 'assert', action: 'not.toBeVisible', locator: loc('text', `getByText('Error')`) }),
		'Check that “Error” is not shown'
	],
	[
		step({
			kind: 'assert',
			action: 'toHaveValue',
			locator: loc('ui5', `getByRoleUI5('Input', { placeholder: 'Your name' })`),
			value: ''
		}),
		'Check that the “Your name” input is empty'
	],
	[
		step({
			kind: 'assert',
			action: 'toHaveCount',
			locator: loc('ui5', `getByRoleUI5('ColumnListItem')`),
			value: '8'
		}),
		'Check that the column list item appears this many times: 8'
	],
	[
		step({ kind: 'assert', action: 'toHaveURL', value: '/orders' }),
		'Check that the right page opened'
	],
	// The recorder leaves a date field after filling in a picked date.
	[
		step({
			kind: 'action',
			action: 'blur',
			locator: loc('ui5', `getByRoleUI5('DatePicker', { placeholder: 'Delivery date' })`)
		}),
		'Leave the “Delivery date” date picker'
	]
])('describes %o', (s, expected) => {
	expect(describeStep(s)).toBe(expected);
});
