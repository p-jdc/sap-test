import { describe, expect, test } from 'vitest';
import { readRepository, descriptive } from './uft-repository.js';
import { newContext, sendKeyName, sidLocator, translateLines, type Item } from './uft-translate.js';
import { findTests, indexSource, renderPlan, renderSpec, translateTest } from './uft-tests.js';
import { parseStatement, scriptLines } from './uft-vbscript.js';
import { REPOSITORY_XML, SAP_GUI_ACTION, uftSource } from '../../test/uft/fixtures.js';
import { decodeUftFile } from '#lib/shared/uft.js';

type Statement = Extract<Item, { kind: 'statement' }>;
const statements = (items: Item[]) => items.filter((i): i is Statement => i.kind === 'statement');

/** Per statement: its code, else OPEN and its line. */
const outline = (i: Statement) => (i.open ? `OPEN ${i.line}` : i.code.join(' '));
/** Per statement: its code, else why it is open, else what it does. */
const result = (i: Statement) => i.code.join(' ') || i.open || i.describe;

function translate(script: string) {
	const ctx = newContext(readRepository(REPOSITORY_XML));
	ctx.action = 'Create order';
	return { items: statements(translateLines(scriptLines(script), ctx)), ctx };
}

const stepTitles = (body: ReturnType<typeof translateTest>['body']) =>
	body.map((s) => ('title' in s ? s.title : s.kind));

describe('scriptLines', () => {
	test('joins continuation lines, splits comments and colons, resolves With', () => {
		const lines = scriptLines(
			[
				'With A("x")',
				'  .B("y").Set "a:b" \' comment',
				'  .C("z").Set _',
				'     "v" : Wait 1',
				'End With',
				'Rem note'
			].join('\n')
		);
		expect(lines.map((l) => [l.line, l.text, Boolean(l.structure), l.comment])).toEqual([
			[1, 'With A("x")', true, undefined],
			[2, 'A("x").B("y").Set "a:b"', false, undefined],
			[3, 'A("x").C("z").Set "v"', false, undefined],
			[3, 'Wait 1', false, undefined],
			[5, 'End With', true, undefined],
			[6, '', false, 'note']
		]);
	});

	test('marks the statements inside control flow, also a one-line If', () => {
		const lines = scriptLines('If x Then\n  A.B\nElse\n  C.D\nEnd If\nIf y Then E.F\nG.H');
		expect(lines.filter((l) => !l.structure).map((l) => [l.text, l.blocks])).toEqual([
			['A.B', ['If']],
			['C.D', ['If']],
			['If y Then E.F', ['If']],
			['G.H', []]
		]);
	});
});

describe('parseStatement', () => {
	test('reads an object chain, its method and arguments', () => {
		expect(
			parseStatement('SAPGuiSession("S").SAPGuiWindow("W").SAPGuiEdit("E").Set "a ""b"""')
		).toEqual({
			kind: 'call',
			segments: [
				{ name: 'SAPGuiSession', args: [{ kind: 'string', value: 'S' }] },
				{ name: 'SAPGuiWindow', args: [{ kind: 'string', value: 'W' }] },
				{ name: 'SAPGuiEdit', args: [{ kind: 'string', value: 'E' }] }
			],
			method: 'Set',
			args: [{ kind: 'string', value: 'a "b"' }]
		});
		expect(parseStatement('Call Foo(1, x)')).toMatchObject({
			kind: 'call',
			method: 'Foo',
			segments: []
		});
		expect(parseStatement('x = DataTable("A", dtGlobalSheet) & "!"')).toMatchObject({
			kind: 'assign',
			target: 'x'
		});
		expect(parseStatement('If a = b Then')).toEqual({ kind: 'other' });
	});
});

describe('descriptive programming', () => {
	test('reads properties and tells patterns from plain values', () => {
		expect(descriptive(['name:=btn\\[8\\]', 'type:=GuiButton'])).toEqual({
			properties: { name: 'btn[8]', type: 'GuiButton' },
			patterns: []
		});
		expect(descriptive(['text:=Save.*'])?.patterns).toEqual(['text']);
		expect(descriptive(['Save'])).toBeUndefined();
	});
});

describe('sidLocator', () => {
	test('writes what the WebGUI recorder writes', () => {
		expect(sidLocator('wnd[0]/usr/ctxtVBAK-AUART')).toBe(
			"page.getByRoleSID('textField', { name: 'VBAK-AUART' })"
		);
		expect(sidLocator('wnd[1]/usr/btnBUTTON_1')).toBe(
			"page.getByRoleSID('button', { name: 'BUTTON_1', wnd: 1 })"
		);
		expect(sidLocator('wnd[0]/tbar[1]/btn[8]')).toBe(
			"page.getByRoleSID('button', { pos: 8, sub: 'tbar[1]' })"
		);
		expect(sidLocator('wnd[0]/usr/subSUB:SAPMV45A:4021/ctxtVBAK-VKORG')).toBe(
			"page.locateSID('wnd[0]/usr/subSUB:SAPMV45A:4021/ctxtVBAK-VKORG')"
		);
		expect(sidLocator('wnd[0]/usr/ctxtp_bukrs')).toBe("page.locateSID('wnd[0]/usr/ctxtp_bukrs')");
	});

	test('maps the SendKey constants', () => {
		expect(
			['ENTER', 'F8', 'F11', 'SHIFT_F3', 'CTRL_F1', 'CTRL_X'].map((k) => sendKeyName(k))
		).toEqual(['Enter', 'F8', 'Control+S', 'Shift+F3', 'Control+F1', undefined]);
	});
});

describe('translateLines (SAP GUI)', () => {
	test('turns the OK code and Enter into runTransaction, fields into SID locators', () => {
		const { items, ctx } = translate(SAP_GUI_ACTION);
		expect(items.map((i) => outline(i))).toEqual([
			"await runTransaction(page, 'VA01');",
			"await page.getByRoleSID('textField', { name: 'VBAK-AUART' }).fill(DATA.OrderType);",
			"await page.getByRoleSID('textField', { name: 'VBAK-VKORG' }).fill('1010');",
			"await pressKey(page, 'Enter');",
			'OPEN 10',
			"await pressKey(page, 'Control+S');",
			"await expectStatusBar(page, 'S');",
			'let orderNo = (await readStatusBar(page)).text;',
			'OPEN 14',
			'OPEN 15',
			''
		]);
		expect(items[2]?.check).toContain('assumed directly on the screen');
		expect(items[2]?.describe).toBe(
			'Enter "1010" in "Sales Organization" (wnd[0]/usr/ctxtVBAK-VKORG)'
		);
		expect([...ctx.webgui].toSorted()).toEqual([
			'expectStatusBar',
			'pressKey',
			'readStatusBar',
			'runTransaction'
		]);
		expect(ctx.data).toEqual(new Map([['DATA', new Set(['OrderType'])]]));
		expect(ctx.surface.fiori).toBe(0);
	});

	test('keeps an object without repository entry open, and names what is missing', () => {
		const { items } = translate(
			'SAPGuiSession("Session").SAPGuiWindow("Other").SAPGuiEdit("Plant").Set "1000"'
		);
		expect(items[0]?.open).toContain('Export to XML');
	});

	test('reads descriptive programming', () => {
		const { items } = translate(
			[
				'SAPGuiSession("guicomponenttype:=12").SAPGuiWindow("name:=wnd\\[1\\]").SAPGuiButton("name:=SPOP-OPTION1", "type:=GuiButton").Click',
				'SAPGuiSession("guicomponenttype:=12").SAPGuiWindow("guicomponenttype:=21").SAPGuiEdit("id:=/app/con\\[0\\]/ses\\[0\\]/wnd\\[0\\]/usr/pwdRSYST-BCODE").Set "x"',
				'SAPGuiSession("Session").SAPGuiWindow("Create Standard Order").SAPGuiButton("name:=btn\\[8\\]").Click'
			].join('\n')
		);
		expect(items.map((i) => result(i))).toEqual([
			"await page.getByRoleSID('button', { name: 'SPOP-OPTION1', wnd: 1 }).click();",
			'The SAP logon screen: page.SAPLogin signs in at the start of the test',
			"await pressKey(page, 'F8');"
		]);
	});

	test('never puts a password into the code', () => {
		const { items } = translate(
			'SAPGuiSession("Session").SAPGuiWindow("name:=wnd\\[0\\]").SAPGuiEdit("id:=/app/con\\[0\\]/ses\\[0\\]/wnd\\[0\\]/usr/pwdNEW-PASSWORD").Set "secret"'
		);
		expect(items[0]?.open).toContain('fillSecret');
		expect(items[0]?.code).toEqual([]);
	});
});

describe('translateTest', () => {
	test('runs the flow with each action as a step and counts what was translated', () => {
		const files = uftSource();
		const [uft] = findTests(files);
		expect(uft).toMatchObject({ path: 'UFT/Sales/VA01_Create', name: 'VA01_Create' });
		expect(uft?.actions.map((a) => [a.folder, a.name])).toEqual([
			['Action1', 'Create order'],
			['Action2', 'Check in Fiori']
		]);
		const t = translateTest(uft!, [uft!], indexSource(files));
		expect(t.target).toBe('mixed');
		expect([t.translated, t.statements]).toEqual([10, 15]);
		expect(t.repositories).toEqual(['UFT/Sales/VA01_Create/ObjectRepository.xml']);
		expect(t.notes.join(' ')).toContain('matched in the order of their numbers');

		const spec = renderSpec({
			translation: t,
			title: 'VA01_Create',
			tag: '@uft-va01-create',
			origin: 'upload',
			specFile: 'sap-tests/tests/webgui/uft-va01-create.spec.ts',
			planFile: 'sap-tests/specs/uft-va01-create.plan.md',
			pluginImport: '../../sap-plugin',
			helpersImport: '../../helpers',
			seed: { file: 'sap-tests/tests/_agents/seed-signed-in.spec.ts', project: 'sap' },
			importedOn: '2026-11-27'
		});
		expect(spec).toContain("import { test } from '../../sap-plugin';");
		expect(spec).toContain(
			'// const orderNo = (await readStatusBar(page)).text; (used only by statements still to be translated)'
		);
		expect(spec).toContain(
			"import { expectStatusBar, pressKey, runTransaction } from '../../helpers/webgui';"
		);
		expect(spec).toContain("import { button } from '../../helpers/fiori';");
		expect(spec).toContain(
			"test.fixme('VA01_Create', { tag: ['@uft', '@uft-va01-create'] }, async ({ page }) => {"
		);
		expect(spec).toContain(
			"\tawait test.step('Create order', async () => {\n\t\t// Create a standard order\n\t\tawait runTransaction(page, 'VA01');"
		);
		expect(spec).toContain(
			"\t\tawait page.goto(new URL('/sap/bc/ui2/flp#SalesOrder-manage', process.env.SAP_URL).href); // check:"
		);
		expect(spec).toContain(
			'\t\tawait button(page, \'Go\').click(); // check: the text "Go" is the logical name'
		);
		expect(spec).toContain(
			'\t\t// TODO UFT (line 4): calls CheckOrder from the function library UFT/Libraries/orders.qfl'
		);
		expect(spec).not.toContain('const PARAMETERS');
		expect(spec).toContain("const DATA = {\n\tOrderType: '',\n};");

		const plan = renderPlan({
			translation: t,
			title: 'VA01_Create',
			tag: '@uft-va01-create',
			origin: 'upload',
			specFile: 'sap-tests/tests/webgui/uft-va01-create.spec.ts',
			planFile: 'sap-tests/specs/uft-va01-create.plan.md',
			pluginImport: '../../sap-plugin',
			helpersImport: '../../helpers',
			seed: { file: 'sap-tests/tests/_agents/seed-signed-in.spec.ts', project: 'sap' },
			importedOn: '2026-11-27'
		});
		expect(plan).toContain('**10 of 15 statements translated.**');
		expect(plan).toContain(
			'**Create order**\n\n1. Start transaction VA01\n2. Enter the data sheet value "OrderType" in "Order Type" (wnd[0]/usr/ctxtVBAK-AUART)\n'
		);
		expect(plan).toContain(
			'5. Not translated (line 10): `SAPGuiSession("Session").SAPGuiWindow("Create Standard Order").SAPGuiComboBox("Shipping Conditions").Select "01"`'
		);
	});

	test('a test without a flow runs its actions in order', () => {
		const files = uftSource().filter((f) => !f.path.includes('Action0'));
		const [uft] = findTests(files);
		const t = translateTest(uft!, [uft!], indexSource(files));
		expect(stepTitles(t.body)).toEqual(['Action1', 'Action2']);
	});
});

describe('what the translation must not do', () => {
	test('a variable name that is not a plain identifier never reaches the code', () => {
		const { items } = translate(
			'[x=1;await fetch(String.fromCharCode(104)+process.env.SAP_PASSWORD)//] = 1'
		);
		expect(items[0]?.code).toEqual([]);
		expect(items[0]?.open).toContain('not a plain identifier');
	});

	test('a reserved word or a name the test uses is renamed', () => {
		const { items } = translate('package = "1"\nprocess = "2"');
		expect(items.map((i) => i.code.join(' '))).toEqual([
			"let packageValue = '1';",
			"let processValue = '2';"
		]);
	});

	test('every part of a one-line If after a colon is inside the If', () => {
		const { items } = translate(
			'If x = 1 Then Wait 1 : SAPGuiSession("Session").SAPGuiWindow("SAP Easy Access").SendKey ENTER'
		);
		expect(items.map((i) => i.open)).toEqual(['inside If', 'inside If']);
	});

	test('a web password field is never filled with its value', () => {
		const { items } = translate(
			'Browser("B").Page("P").WebEdit("placeholder:=Password").Set "Secret1"'
		);
		expect(items[0]?.open).toContain('fillSecret');
		expect(items[0]?.code).toEqual([]);
	});

	test('a line break in a report text stays in its comment', () => {
		const { items } = translate('Reporter.ReportEvent micPass, "Step", "a\u2028b"');
		expect(items[0]?.code).toEqual(['// UFT reported: Step – a b']);
	});
});

describe('actions', () => {
	test('each action has its own variables', () => {
		const files = [
			{ path: 'T/Action1/Script.mts', text: 'sOrder = "1"' },
			{ path: 'T/Action2/Script.mts', text: 'sOrder = "2"' }
		];
		const [uft] = findTests(files);
		const t = translateTest(uft!, [uft!], indexSource(files));
		expect(t.body).toMatchObject([
			{ title: 'Action1', items: [{ code: ["let sOrder = '1';"] }] },
			{ title: 'Action2', items: [{ code: ["let sOrder = '2';"] }] }
		]);
	});

	test("a call of another test's action does not take a folder of this one", () => {
		const files = [
			{
				path: 'T/Action0/Script.mts',
				text: 'RunAction "Login [Common]", oneIteration\nRunAction "Create order", oneIteration'
			},
			{ path: 'T/Action1/Script.mts', text: 'Wait 1' }
		];
		const [uft] = findTests(files);
		expect(uft?.actions.map((a) => a.name)).toEqual(['Create order']);
	});
});

describe('decodeUftFile', () => {
	test('reads UTF-16 with a byte order mark, UTF-8, and Windows-1252', () => {
		const utf16 = new Uint8Array([0xff, 0xfe, ...Buffer.from('Größe', 'utf16le')]);
		expect(decodeUftFile(utf16)).toBe('Größe');
		expect(decodeUftFile(new TextEncoder().encode('Größe'))).toBe('Größe');
		expect(decodeUftFile(new Uint8Array([0x47, 0x72, 0xf6, 0xdf, 0x65]))).toBe('Größe');
	});
});
