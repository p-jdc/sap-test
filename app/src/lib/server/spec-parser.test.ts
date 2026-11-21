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

	test('reads the locators of the UI5 recorder as SAP locators, also inside an iframe', () => {
		const spec = parseSpec(
			'fiori/recorded.spec.ts',
			`import { test, ui5ControlSelector, locateSIDSelector } from '../../sap-plugin';
test('recorded', async ({ page }) => {
	await page.SAPLogin(process.env.SAP_USERNAME!, process.env.SAP_PASSWORD!, process.env.SAP_URL);
	await page.locateUI5Control({ controlType: 'sap.m.Input', labelFor: { text: 'Sold-To Party' } }).fill('1000');
	await page.locateUI5Control({ id: 'app--calendar', interaction: 'root' }).getByText('15', { exact: true }).click();
	await page.frameLocator('iframe[name="application"]').locator(ui5ControlSelector({ controlType: 'sap.m.Button', properties: { text: 'Go' } })).click();
	await page.frameLocator('iframe[name="application"]').locator(locateSIDSelector('wnd[0]/tbar[1]/btn[8]')).click();
});`,
			helpers
		);
		const t = must(spec.tests[0]);
		expect(t.steps.map((s) => [s.action, s.locator?.kind])).toEqual([
			['SAPLogin', undefined],
			['fill', 'ui5'],
			['click', 'text'],
			['click', 'ui5'],
			['click', 'sid-path']
		]);
		// No CSS finding for the selector strings; only the calendar day is a standard locator.
		expect(t.issues.map((i) => i.rule).toSorted()).toEqual(['has-assertion', 'prefer-sap-locator']);
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

	test('expands tests generated in a loop over literal values', () => {
		const spec = parseSpec(
			'_demo/loop.spec.ts',
			`const PLANTS = ['1000', '2000'] as const;
for (const plant of PLANTS) {
	test(\`stock in \${plant}\`, async ({ page }) => {
		await page.getByLabel('Plant').fill(plant);
		await expect(page).toHaveURL('/');
	});
}
['a', 'b'].forEach((n) => test('item ' + n, async ({ page }) => { await expect(page).toHaveURL('/'); }));`
		);
		expect(spec.tests.map((t) => [t.key, t.line, t.dynamic])).toEqual([
			['_demo/loop.spec.ts::stock in 1000', 3, undefined],
			['_demo/loop.spec.ts::stock in 2000', 3, undefined],
			['_demo/loop.spec.ts::item a', 8, undefined],
			['_demo/loop.spec.ts::item b', 8, undefined]
		]);
		expect(spec.tests.map((t) => t.steps[0]?.value).slice(0, 2)).toEqual(['1000', '2000']);
		expect(new Set(spec.tests.flatMap((t) => t.steps.map((s) => s.id))).size).toBe(6);
	});

	test('lists a test whose title is only known at run time once, marked dynamic', () => {
		const spec = parseSpec(
			'_demo/dyn.spec.ts',
			`const KIND = 'order';
for (const c of loadCases()) {
	test(\`\${KIND} \${c.name}\`, async ({ page }) => { await expect(page).toHaveURL('/'); });
}
for (let i = 0; i < 3; i++) test('round ' + i, async () => {});
test.describe(\`suite \${process.env.SYSTEM}\`, () => {
	test('inside', async () => {});
});
test(\`plain \${KIND}\`, async () => {});`
		);
		expect(spec.tests.map((t) => [t.title, t.line, t.dynamic])).toEqual([
			['order ${c.name}', 3, true],
			['round ${i}', 5, true],
			['inside', 7, true],
			['plain order', 9, undefined]
		]);
		expect(spec.tests[2]?.titlePath).toEqual(['suite ${process.env.SYSTEM}', 'inside']);
	});

	test('a loop variable hides a constant of the same name, and is restored after the loop', () => {
		const spec = parseSpec(
			'_demo/shadow.spec.ts',
			`const n = 'outer';
for (const n of ['x']) test('in ' + n, async () => {});
for (const n of cases()) test('dyn ' + n, async () => {});
test('after ' + n, async () => {});`
		);
		expect(spec.tests.map((t) => t.title)).toEqual(['in x', 'dyn ${n}', 'after outer']);
	});

	test('conditional skips and annotations are not tests', () => {
		const spec = parseSpec(
			'_demo/skip.spec.ts',
			`test.skip(({ browserName }) => browserName !== 'chromium', 'chromium only');
test.describe(() => {
	test('real', async ({ page }) => {
		test.skip(!process.env.SAP_URL, 'no system');
		test.slow();
		await expect(page).toHaveURL('/');
	});
	test.fixme('later', { tag: '@wip' }, async () => {});
});`
		);
		expect(spec.tests.map((t) => t.titlePath)).toEqual([['real'], ['later']]);
	});

	test('warns on AI-generated tests without a named reviewer', () => {
		const spec = parseSpec(
			'fiori/ai.spec.ts',
			`// KI-generiert, geprüft von: <Name>\ntest('x', async () => {});`
		);
		expect(spec.issues[0]?.rule).toBe('ai-review');
	});
});
