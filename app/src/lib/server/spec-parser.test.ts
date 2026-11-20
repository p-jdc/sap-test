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

/** Sorted rule names found in one test with the given body. */
const rulesOf = (file: string, body: string) =>
	must(parseSpec(file, `test('t', async ({ page }) => {\n${body}\n});`, helpers).tests[0])
		.issues.map((i) => i.rule)
		.toSorted();

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

	test.each([
		['a value assertion that is not awaited', `expect(await page.title()).toBe('Orders');`, 'toBe'],
		['expect.soft', `await expect.soft(page.getByText('Saved')).toBeVisible();`, 'toBeVisible'],
		['expect.poll', `await expect.poll(() => page.title()).not.toBe('');`, 'not.toBe']
	])('counts %s as an assertion', (_name, line, action) => {
		const spec = parseSpec(
			'_demo/a.spec.ts',
			`test('t', async ({ page }) => {\n\tawait page.goto('/x');\n\t${line}\n});`
		);
		const t = must(spec.tests[0]);
		expect(t.steps.at(-1)).toMatchObject({ kind: 'assert', action });
		expect(t.issues).toEqual([]);
	});

	test('an assertion after a save satisfies assert-after-change in every form', () => {
		const rules = rulesOf(
			'_demo/a.spec.ts',
			`await page.getByRole('button', { name: 'Save' }).click();
	expect(await page.title()).toBe('Saved');`
		);
		expect(rules).toEqual([]);
	});

	test('a non-awaited call that is not an assertion is not a step', () => {
		const spec = parseSpec(
			'_demo/a.spec.ts',
			`test('t', async ({ page }) => {\n\tconsole.log('x');\n\tawait expect(page).toHaveURL('/');\n});`
		);
		expect(must(spec.tests[0]).steps.map((s) => s.kind)).toEqual(['assert']);
	});

	test.each([
		[
			'an env value held in a variable',
			`const pw = process.env.SAP_PASSWORD!;\n\tawait page.getByLabel('Password').fill(pw);`
		],
		['a property of an env object', `await page.getByLabel('Password').fill(env.SAP_PASSWORD);`],
		['process.env directly', `await page.getByLabel('Kennwort').fill(process.env.SAP_PASSWORD!);`],
		[
			'SAPLogin with env values',
			`await page.SAPLogin(process.env.SAP_USERNAME!, process.env.SAP_PASSWORD!);`
		]
	])('no-literal-secret accepts %s', (_name, body) => {
		expect(rulesOf('_demo/s.spec.ts', `${body}\n\tawait expect(page).toHaveURL('/');`)).toEqual([]);
	});

	test.each([
		['a string literal', `await page.getByLabel('Password').fill('secret');`],
		['a literal constant', `await page.getByLabel('Password').fill(PASSWORD);`],
		['a literal password in SAPLogin', `await page.SAPLogin(process.env.SAP_USERNAME!, 'secret');`]
	])('no-literal-secret flags %s', (_name, body) => {
		const spec = parseSpec(
			'_demo/s.spec.ts',
			`const PASSWORD = 'secret';\ntest('t', async ({ page }) => {\n\t${body}\n\tawait expect(page).toHaveURL('/');\n});`
		);
		expect(must(spec.tests[0]).issues.map((i) => i.rule)).toEqual(['no-literal-secret']);
	});

	test('applies the rules inside control flow and reports them on the opaque node', () => {
		const spec = parseSpec(
			'webgui/c.spec.ts',
			`test('t', async ({ page }) => {
	if (await page.getByText('Popup').isVisible()) {
		await page.waitForTimeout(3000);
	} else {
		await page.locator('#close').click();
	}
	try {
		await page.getByLabel('Password').fill('secret');
	} catch {
		for (const id of ['a']) await page.locator('//div').click();
	}
	while (false) await page.waitForTimeout(1);
	await expect(page).toHaveURL('/');
});`
		);
		const t = must(spec.tests[0]);
		expect(t.steps.map((s) => [s.kind, s.action])).toEqual([
			['other', 'if'],
			['other', 'try'],
			['other', 'while'],
			['assert', 'toHaveURL']
		]);
		expect(t.steps.map((s) => s.issues.map((i) => [i.rule, i.line]))).toEqual([
			[
				['no-fixed-wait', 3],
				['no-css-xpath', 5]
			],
			[
				['prefer-sap-locator', 8],
				['no-literal-secret', 8],
				['no-css-xpath', 10]
			],
			[['no-fixed-wait', 12]],
			[]
		]);
		expect(t.issues).toHaveLength(6);
	});

	test('an assertion inside control flow counts, and one after it follows the last inner step', () => {
		expect(
			rulesOf(
				'_demo/c.spec.ts',
				`if (x) {\n\t\tawait page.getByRole('button', { name: 'Save' }).click();\n\t}\n\tawait expect(page).toHaveURL('/');`
			)
		).toEqual([]);
		expect(
			rulesOf('_demo/c.spec.ts', `if (x) {\n\t\tawait expect(page).toHaveURL('/');\n\t}`)
		).toEqual([]);
		expect(
			rulesOf(
				'_demo/c.spec.ts',
				`if (x) {\n\t\tawait page.getByRole('button', { name: 'Save' }).click();\n\t}`
			)
		).toEqual(['assert-after-change', 'has-assertion']);
	});

	test('ui5-single-property counts properties, not punctuation in a value', () => {
		const ok = `await expect(page).toHaveURL('/');`;
		expect(
			rulesOf(
				'fiori/u.spec.ts',
				`await page.getByRoleUI5('Button', { text: 'Time: 10,30 at: x' }).click();\n\t${ok}`
			)
		).toEqual([]);
		expect(
			rulesOf(
				'fiori/u.spec.ts',
				`await page.getByRoleUI5('Input', {\n\t\tlabel: 'A',\n\t\tvalue: ''\n\t}).fill('1');\n\t${ok}`
			)
		).toEqual(['ui5-single-property']);
	});

	test('a test.step group does not repeat the findings of the steps inside it', () => {
		const spec = parseSpec(
			'fiori/g.spec.ts',
			`test('t', async ({ page }) => {
	await test.step('open', async () => {
		await page.getByRoleUI5('Button', { text: 'A' }).nth(1).click();
	});
	await expect(page).toHaveURL('/');
});`
		);
		const t = must(spec.tests[0]);
		expect(t.steps.map((s) => s.issues.map((i) => i.rule))).toEqual([[], ['avoid-nth'], []]);
	});

	test('warns on AI-generated tests without a named reviewer', () => {
		const spec = parseSpec(
			'fiori/ai.spec.ts',
			`// KI-generiert, geprüft von: <Name>\ntest('x', async () => {});`
		);
		expect(spec.issues[0]?.rule).toBe('ai-review');
	});
});
