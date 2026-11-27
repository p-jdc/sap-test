import { describe, expect, test } from 'vitest';
import { htmlToText, parseGherkinScript, parseManualScript } from './octane-script.js';

describe('parseManualScript', () => {
	test('a validation checks the step before it; a call names the test it runs', () => {
		const script = [
			'- Start transaction VA01',
			'- Enter order type OR',
			'  and sales organisation 1010',
			'- ?The overview screen shows',
			'- ? Sold-to party is empty',
			'- @1234 Log in as sales clerk',
			'- Save'
		].join('\n');
		expect(parseManualScript('Create order', script)).toEqual({
			scenarios: [
				{
					name: 'Create order',
					examples: [],
					steps: [
						{ action: 'Start transaction VA01', expect: [] },
						{
							action: 'Enter order type OR and sales organisation 1010',
							expect: ['The overview screen shows', 'Sold-to party is empty']
						},
						{
							action: 'Run the steps of the called Octane test 1234 Log in as sales clerk',
							expect: []
						},
						{ action: 'Save', expect: [] }
					]
				}
			],
			calls: ['1234 Log in as sales clerk']
		});
	});

	test('a validation first is a step of its own, and a long check continues on the next line', () => {
		const { scenarios } = parseManualScript(
			't',
			'- ?Launchpad is shown\nwith the tile Sales\n\r\n'
		);
		expect(scenarios[0]?.steps).toEqual([
			{ action: '', expect: ['Launchpad is shown with the tile Sales'] }
		]);
	});

	test('an empty script has no steps', () => {
		expect(parseManualScript('t', '').scenarios).toEqual([{ name: 't', steps: [], examples: [] }]);
	});
});

describe('parseGherkinScript', () => {
	const feature = `@sales
Feature: Sales orders
  # a comment
  Background:
    Given I am signed in to the launchpad

  Scenario: Create a standard order
    When I create an order for customer 1000
    And I save it
    Then the status bar shows "Standard Order saved"
    And the order number is shown

  Scenario Outline: Blocked customers
    When I create an order for customer <customer>
      """
      free text
      """
    Then I see the error <message>
    Examples:
      | customer | message |
      | 2000     | blocked |
`;

	test('each scenario starts with the background; Then and the And after it are checks', () => {
		const { scenarios, calls } = parseGherkinScript('Sales', feature);
		expect(calls).toEqual([]);
		expect(scenarios).toEqual([
			{
				name: 'Create a standard order',
				examples: [],
				steps: [
					{ action: 'Given I am signed in to the launchpad', expect: [] },
					{ action: 'When I create an order for customer 1000', expect: [] },
					{
						action: 'And I save it',
						expect: [
							'Then the status bar shows "Standard Order saved"',
							'And the order number is shown'
						]
					}
				]
			},
			{
				name: 'Blocked customers',
				examples: ['| customer | message |', '| 2000     | blocked |'],
				steps: [
					{ action: 'Given I am signed in to the launchpad', expect: [] },
					{
						action: 'When I create an order for customer <customer> free text',
						expect: ['Then I see the error <message>']
					}
				]
			}
		]);
	});

	test("a Rule's background is for that Rule's scenarios only", () => {
		const script = [
			'Feature: x',
			'Background:',
			'Given f',
			'Rule: A',
			'Background:',
			'Given a',
			'Scenario: one',
			'When 1',
			'Rule: B',
			'Scenario: two',
			'When 2'
		].join('\n');
		const { scenarios } = parseGherkinScript('Rules', script);
		expect(scenarios.map((s) => s.steps.map((step) => step.action))).toEqual([
			['Given f', 'Given a', 'When 1'],
			['Given f', 'When 2']
		]);
	});

	test('a feature with only a background is one test', () => {
		const { scenarios } = parseGherkinScript('Only', 'Feature: x\nBackground:\n Given a\n');
		expect(scenarios).toEqual([
			{ name: 'Only', examples: [], steps: [{ action: 'Given a', expect: [] }] }
		]);
	});
});

describe('htmlToText', () => {
	test('keeps paragraphs and list items apart, and decodes entities', () => {
		expect(
			htmlToText(
				'<html><body><p>Order &amp; delivery&nbsp;check</p><ul><li>one</li><li>two &#8364; &#x41;</li></ul><p>a<br/>b &bogus; &constructor;</p></body></html>'
			)
		).toBe('Order & delivery check\n\n- one\n- two € A\na\nb &bogus; &constructor;');
	});

	test('leaves a code point out of range as it was', () => {
		expect(htmlToText('&#9999999999;')).toBe('&#9999999999;');
	});
});
