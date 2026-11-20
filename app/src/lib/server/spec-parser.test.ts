import { describe, expect, test } from 'vitest';
import { must } from '../../test/must.js';
import { parseHelpers, parseSpec } from './spec-parser.js';

const helpers = parseHelpers([
	{
		file: 'fiori.ts',
		source: `export const button = (page, text) => page.getByRoleUI5('Button', { text });`
	},
	{
		file: 'webgui.ts',
		source: `export async function runTransaction(page, tcode) { await page.getByRoleSID('okCode').fill('/n' + tcode); }`
	}
]);

describe('parseSpec', () => {
	test('turns a Fiori test into steps with resolved constants, helpers and env vars', () => {
		const spec = parseSpec(
			'fiori/order.spec.ts',
			`import { test, expect } from '@playwright/test';
const PARTY = '1000';
test('create order', async ({ page }) => {
	await page.SAPLogin(process.env.SAP_USERNAME!, process.env.SAP_PASSWORD!, process.env.SAP_URL!);
	await page.getByRoleUI5('Input', { label: 'Sold-To Party' }).fill(PARTY);
	await button(page, 'Save').click();
	await expect(page.getByText('Sales order')).toBeVisible();
});`,
			helpers
		);
		const t = must(spec.tests[0]);
		expect(t.key).toBe('fiori/order.spec.ts::create order');
		expect(t.surface).toBe('fiori');
		expect(t.steps.map((s) => [s.kind, s.action, s.locator?.kind, s.value])).toEqual([
			['login', 'SAPLogin', undefined, '$SAP_USERNAME'],
			['action', 'fill', 'ui5', '1000'],
			['action', 'click', 'ui5', undefined],
			['assert', 'toBeVisible', 'text', undefined]
		]);
		expect(t.steps[2]?.locator?.helper).toBe('button');
		expect(t.issues).toEqual([]);
	});

	test('applies beforeEach steps and describe titles', () => {
		const spec = parseSpec(
			'_demo/x.spec.ts',
			`test.describe('group', () => {
	test.beforeEach(async ({ page }) => { await page.goto('/start'); });
	test('a', async ({ page }) => { await expect(page.getByRole('heading')).toBeVisible(); });
});`
		);
		const t = must(spec.tests[0]);
		expect(t.titlePath).toEqual(['group', 'a']);
		expect(t.steps[0]).toMatchObject({ kind: 'navigate', hook: true, value: '/start' });
	});

	test('flags the guide rules on SAP screens', () => {
		const spec = parseSpec(
			'webgui/bad.spec.ts',
			`test('bad', async ({ page }) => {
	await page.locator('#btn-1').click();
	await page.getByRoleUI5('Input', { label: 'A', value: '' }).fill('1');
	await page.waitForTimeout(1000);
	await page.getByLabel('Password').fill('secret');
	await page.getByRoleUI5('Button', { text: 'Save' }).click();
});`
		);
		const rules = must(spec.tests[0])
			.issues.map((i) => i.rule)
			.toSorted();
		expect(rules).toEqual(
			[
				'assert-after-change',
				'has-assertion',
				'no-css-xpath',
				'no-fixed-wait',
				'no-literal-secret',
				'prefer-sap-locator',
				'ui5-single-property'
			].toSorted()
		);
	});

	test('bare helper calls become helper steps', () => {
		const spec = parseSpec(
			'webgui/t.spec.ts',
			`test('t', async ({ page }) => { await runTransaction(page, 'VA03'); });`,
			helpers
		);
		const step = must(must(spec.tests[0]).steps[0]);
		expect(step).toMatchObject({
			kind: 'helper',
			action: 'runTransaction',
			value: 'VA03'
		});
		expect(step.locator?.kind).toBe('sid');
	});

	test('warns on AI-generated tests without a named reviewer', () => {
		const spec = parseSpec(
			'fiori/ai.spec.ts',
			`// KI-generiert, geprüft von: <Name>\ntest('x', async () => {});`
		);
		expect(spec.issues[0]?.rule).toBe('ai-review');
	});
});
