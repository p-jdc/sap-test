import { descriptive, objectKey, type Properties, type Repository } from './uft-repository.js';
import {
	bareName,
	literal,
	parseStatement,
	type Expr,
	type Line,
	type Segment,
	type Statement
} from './uft-vbscript.js';

/**
 * Translates the statements of a UFT action into Playwright code for this test project: SAP GUI
 * for Windows (UFT's SAP add-in) into SAP WebGUI with the SID locators and the helpers of
 * helpers/webgui.ts, web and SAPUI5 objects into Fiori with the UI5 locators. WebGUI's SIDs are the
 * IDs of SAP GUI Scripting, which UFT's SAP objects carry, so a field found by its technical name
 * in UFT is the same field in WebGUI. Whatever has no certain counterpart stays in the test as the
 * UFT statement in a comment, marked `TODO UFT`, for a person.
 */

/** The marker of a statement that was not translated: the migration counts these. */
export const OPEN_MARKER = 'TODO UFT';

/** What the translated statements need around them: imports, data, variables. */
export interface Context {
	repo: Repository;
	/** Helpers imported from helpers/webgui.ts and helpers/fiori.ts. */
	webgui: Set<string>;
	fiori: Set<string>;
	/** Data sheets and parameters the script reads, by the constant they become. */
	data: Map<string, Set<string>>;
	/** Script variables (lower case) and their name in the test. */
	vars: Map<string, string>;
	/** Functions of the function libraries in the source (lower case), and their file. */
	functions: Map<string, string>;
	/** The action being translated, for its local data sheet. */
	action: string;
	/** Statements that drive SAP GUI and Fiori: which folder the test goes to. */
	surface: { sapgui: number; fiori: number };
}

export function newContext(repo: Repository, functions: Map<string, string> = new Map()): Context {
	return {
		repo,
		webgui: new Set(),
		fiori: new Set(),
		data: new Map(),
		vars: new Map(),
		functions,
		action: '',
		surface: { sapgui: 0, fiori: 0 }
	};
}

export type Item =
	/** A statement: translated (`code`, maybe empty for one that needs nothing) or `open`. */
	| {
			kind: 'statement';
			line: number;
			source: string;
			code: string[];
			/** Why it was not translated. */
			open?: string;
			/** Translated, but on an assumption a person should check (once, at the first run). */
			check?: string;
			/** For the plan: what the statement does, in words. */
			describe: string;
	  }
	/** `RunAction "Name [Test]", iteration`: the caller puts the action's steps here. */
	| {
			kind: 'runAction';
			line: number;
			source: string;
			name: string;
			test?: string;
			iterations?: string;
	  }
	/** A comment of the script, kept as a comment. */
	| { kind: 'comment'; line: number; text: string };

// ---- Strings -----------------------------------------------------------------------------------

/** A TypeScript string literal in single quotes. */
export const str = (text: string) =>
	`'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n').replaceAll('\r', '\\r')}'`;

/** `DATA.Col` for a name that is an identifier, else `DATA['Order type']`. */
const member = (object: string, key: string) =>
	/^[A-Za-z_$][\w$]*$/.test(key) ? `${object}.${key}` : `${object}[${str(key)}]`;

/** The name a script variable gets in the test: as written, unless it is a reserved word there. */
function varName(name: string): string {
	const reserved =
		/^(?:page|test|expect|await|async|const|let|var|function|class|new|this|default|delete|in|of|return|typeof|void|yield|data)$/i;
	return reserved.test(name) ? `${name}Value` : name;
}

function useData(ctx: Context, constant: string, key: string): string {
	const keys = ctx.data.get(constant) ?? new Set<string>();
	keys.add(key);
	ctx.data.set(constant, keys);
	return member(constant, key);
}

/** The constant of a data sheet: DATA for the global sheet, DATA_<ACTION> for an action's own. */
function sheetConstant(ctx: Context, sheet: Expr | undefined): string | undefined {
	const name = bareName(sheet)?.toLowerCase();
	const text = literal(sheet);
	if (sheet === undefined || name === 'dtglobalsheet' || text?.toLowerCase() === 'global')
		return 'DATA';
	if (name === 'dtlocalsheet') return `DATA_${constantPart(ctx.action)}`;
	if (text) return `DATA_${constantPart(text)}`;
	return undefined;
}

const constantPart = (name: string) =>
	name
		.toUpperCase()
		.replaceAll(/[^A-Z0-9]+/g, '_')
		.replaceAll(/^_|_$/g, '') || 'ACTION';

/**
 * A value of the script as a TypeScript expression of type string, or undefined when it has none:
 * strings and numbers, the data sheet, test and action parameters, environment values, variables
 * the translation knows, and these joined with `&`.
 */
function value(expr: Expr, ctx: Context): string | undefined {
	if (expr.kind === 'string' || expr.kind === 'number') return str(expr.value);
	if (expr.kind === 'concat') {
		const parts = expr.parts.map((p) => value(p, ctx));
		return parts.every((p) => p !== undefined) ? parts.join(' + ') : undefined;
	}
	if (expr.kind === 'path') return pathValue(expr.segments, ctx);
	return undefined;
}

const VB_CONSTANTS: Record<string, string> = {
	vbcrlf: "'\\r\\n'",
	vbnewline: "'\\r\\n'",
	vblf: "'\\n'",
	vbcr: "'\\r'",
	vbtab: "'\\t'"
};

function pathValue(segments: Segment[], ctx: Context): string | undefined {
	const [first, second, third] = segments;
	if (!first) return undefined;
	const head = first.name.toLowerCase();
	const args = first.args ?? [];
	// DataTable("Col", dtGlobalSheet), DataTable.Value("Col", "Action1"), DataTable.GetSheet(…).GetParameter("Col")[.Value]
	if (head === 'datatable') {
		if (segments.length === 1 && args.length > 0) {
			const key = literal(args[0]);
			const constant = sheetConstant(ctx, args[1]);
			return key && constant ? useData(ctx, constant, key) : undefined;
		}
		if (second?.name.toLowerCase() === 'value' && segments.length === 2) {
			const key = literal(second.args?.[0]);
			const constant = sheetConstant(ctx, second.args?.[1]);
			return key && constant ? useData(ctx, constant, key) : undefined;
		}
		if (second?.name.toLowerCase() === 'getsheet' && third?.name.toLowerCase() === 'getparameter') {
			const key = literal(third.args?.[0]);
			const constant = sheetConstant(ctx, second.args?.[0]);
			const rest = segments.slice(3);
			if (rest.length > 1 || (rest[0] && rest[0].name.toLowerCase() !== 'value')) return undefined;
			return key && constant ? useData(ctx, constant, key) : undefined;
		}
		return undefined;
	}
	// Parameter("x"), Parameter.Item("x"), TestArgs("x"): the action's or test's input parameters.
	if (head === 'parameter' || head === 'testargs') {
		const key =
			segments.length === 1
				? literal(args[0])
				: second?.name.toLowerCase() === 'item' && segments.length === 2
					? literal(second.args?.[0])
					: undefined;
		return key ? useData(ctx, 'PARAMETERS', key) : undefined;
	}
	// Environment("x"), Environment.Value("x"): UFT's environment variables.
	if (head === 'environment') {
		const key =
			segments.length === 1
				? literal(args[0])
				: second?.name.toLowerCase() === 'value' && segments.length === 2
					? literal(second.args?.[0])
					: undefined;
		return key ? useData(ctx, 'ENVIRONMENT', key) : undefined;
	}
	if (segments.length === 1 && !first.args) {
		const known = ctx.vars.get(head);
		if (known) return known;
		return VB_CONSTANTS[head];
	}
	return undefined;
}

// ---- Objects -----------------------------------------------------------------------------------

/** One object of a chain with what is known about it: from the repository or the script. */
interface TestObject {
	className: string;
	/** The logical name, for a repository object. */
	logical?: string;
	properties: Properties;
	patterns: string[];
	/** Found in an object repository or described in the script. */
	known: boolean;
}

function resolveChain(segments: Segment[], ctx: Context): TestObject[] | undefined {
	const objects: TestObject[] = [];
	const chain: { className: string; name: string }[] = [];
	let logicalPath = true;
	for (const segment of segments) {
		const args = (segment.args ?? []).map((a) => literal(a));
		const texts = args.filter((a) => a !== undefined);
		if (texts.length !== args.length) return undefined;
		const described = descriptive(texts);
		if (described) {
			logicalPath = false;
			objects.push({ className: segment.name, ...described, known: true });
			continue;
		}
		const logical = texts[0] ?? '';
		chain.push({ className: segment.name, name: logical });
		const found = logicalPath ? ctx.repo.get(objectKey(chain)) : undefined;
		objects.push({
			className: segment.name,
			logical,
			properties: found?.properties ?? {},
			patterns: found?.patterns ?? [],
			known: Boolean(found)
		});
	}
	return objects;
}

const isSapGui = (className: string) => /^sapgui/i.test(className);
const WEB_CLASSES =
	/^(?:browser|page|frame|web\w*|link|image|sapui\w*|sapweb\w*|sapedit|sapbutton|sapdropdownmenu|sapframe|saplist|sapcheckbox|sapradiogroup|saptable|saptabstrip|sapnavigationbar|sapcalendar|sapiview|sapportal|sapoaldropdownmenu|sapuibutton)$/i;
const isWeb = (className: string) => WEB_CLASSES.test(className);

// ---- SAP GUI → WebGUI --------------------------------------------------------------------------

/** SAP GUI Scripting's component types (GuiComponentType) as UFT stores them in `guicomponenttype`. */
const COMPONENT_TYPES: Record<string, string> = {
	'21': 'GuiMainWindow',
	'22': 'GuiModalWindow',
	'30': 'GuiLabel',
	'31': 'GuiTextField',
	'32': 'GuiCTextField',
	'33': 'GuiPasswordField',
	'34': 'GuiComboBox',
	'35': 'GuiOkCodeField',
	'40': 'GuiButton',
	'41': 'GuiRadioButton',
	'42': 'GuiCheckBox',
	'50': 'GuiCustomControl',
	'80': 'GuiTableControl',
	'90': 'GuiTabStrip',
	'91': 'GuiTab',
	'103': 'GuiStatusbar',
	'122': 'GuiShell'
};

/** The first part of a SID by component type, as SAP GUI Scripting names its IDs. */
const SID_PREFIX: Record<string, string> = {
	GuiTextField: 'txt',
	GuiCTextField: 'ctxt',
	GuiPasswordField: 'pwd',
	GuiComboBox: 'cmb',
	GuiOkCodeField: 'okcd',
	GuiButton: 'btn',
	GuiRadioButton: 'rad',
	GuiCheckBox: 'chk',
	GuiLabel: 'lbl',
	GuiTab: 'tabp',
	GuiTabStrip: 'tabs',
	GuiTableControl: 'tbl',
	GuiCustomControl: 'cntl'
};

/** The component type of a UFT SAP class when the object's properties do not name one. */
const CLASS_TYPE: Record<string, string> = {
	sapguibutton: 'GuiButton',
	sapguicheckbox: 'GuiCheckBox',
	sapguiradiobutton: 'GuiRadioButton',
	sapguicombobox: 'GuiComboBox',
	sapguiokcode: 'GuiOkCodeField',
	sapguilabel: 'GuiLabel',
	sapguitabstrip: 'GuiTabStrip',
	sapguitable: 'GuiTableControl'
};

/** The SID role names of the Playwright-SAP fork, by SID prefix (its isomorphic/sidPrefixMapping). */
const SID_ROLES: Record<string, string> = {
	box: 'box',
	btn: 'button',
	chk: 'checkBox',
	cntl: 'customControl',
	wnd: 'window',
	lbl: 'label',
	menu: 'menu',
	okcd: 'okCode',
	pwd: 'password',
	rad: 'radioButton',
	ssub: 'scrollContainer',
	ses: 'session',
	sub: 'simpleContainer',
	sbar: 'statusBar',
	tabp: 'tab',
	tbl: 'table',
	tabs: 'tabStrip',
	txt: 'text',
	cmb: 'comboBox',
	con: 'connection',
	shellcont: 'shellContainer',
	ctxt: 'textField',
	mbar: 'menuBar',
	shell: 'shell',
	titl: 'titleBar',
	tbar: 'toolbar'
};

/**
 * The locator for a SID, written as the WebGUI recorder writes it (the fork's
 * javascriptSIDLocatorGenerator): `getByRoleSID(role, { name, pos, sub, wnd })` where that names
 * exactly this SID, else `locateSID(sid)`.
 */
export function sidLocator(sid: string): string {
	const fallback = `page.locateSID(${str(sid)})`;
	const parts = sid.split('/');
	if (parts.length !== 3) return fallback;
	const [wnd = '', sub = '', type = ''] = parts;
	const wndIndex = /^wnd\[(\d+)\]$/.exec(wnd)?.[1];
	if (wndIndex === undefined) return fallback;
	let role: string | undefined;
	let name: string | undefined;
	let pos: number | undefined;
	const split = /^([^A-Z]*)(.*)$/.exec(type);
	if (split && !type.includes(':') && SID_ROLES[split[1] ?? ''] && split[2]) {
		role = SID_ROLES[split[1] ?? ''];
		name = split[2];
	}
	const indexed = /^([a-z]+)\[(\d+)\]$/.exec(type);
	if (!role && indexed && SID_ROLES[indexed[1] ?? '']) {
		role = SID_ROLES[indexed[1] ?? ''];
		pos = Number(indexed[2]);
	}
	if (!role) return fallback;
	const prefix = Object.entries(SID_ROLES).find(([, r]) => r === role)?.[0] ?? '';
	const rebuilt = `wnd[${wndIndex}]/${sub}/${prefix}${name ?? ''}${pos === undefined ? '' : `[${pos}]`}`;
	if (rebuilt !== sid) return fallback;
	const options: string[] = [];
	if (pos !== undefined) options.push(`pos: ${pos}`);
	if (name) options.push(`name: ${str(name)}`);
	if (sub !== 'usr') options.push(`sub: ${str(sub)}`);
	if (wndIndex !== '0') options.push(`wnd: ${wndIndex}`);
	return `page.getByRoleSID(${str(role)}, { ${options.join(', ')} })`;
}

/** The window index of a SAPGuiWindow object: from its id or name, or its type (main window: 0). */
function windowIndex(window: TestObject | undefined): number | undefined {
	if (!window) return undefined;
	const { properties: p } = window;
	const fromId = /wnd\[(\d+)\]$/.exec(p.id ?? '')?.[1] ?? /^wnd\[(\d+)\]$/.exec(p.name ?? '')?.[1];
	if (fromId !== undefined) return Number(fromId);
	if (p.guicomponenttype === '21' || p.type === 'GuiMainWindow') return 0;
	return undefined;
}

type SapTarget =
	| { kind: 'sid'; sid: string; type: string; assumed?: string }
	/** A toolbar button known only by `btn[n]`: the function key it stands for. */
	| { kind: 'vkey'; vkey: number; type: string }
	| { kind: 'unknown'; reason: string; type: string };

function sapTarget(objects: TestObject[]): SapTarget {
	const control = objects.at(-1);
	if (!control) return { kind: 'unknown', reason: 'no object', type: '' };
	const p = control.properties;
	const type =
		p.type ||
		COMPONENT_TYPES[p.guicomponenttype ?? ''] ||
		CLASS_TYPE[control.className.toLowerCase()] ||
		'';
	const label = control.logical ? `"${control.logical}"` : control.className;
	if (p.id && !control.patterns.includes('id')) {
		const sid = p.id.replace(/^\/?app\/con\[\d+\]\/ses\[\d+\]\//i, '');
		if (/^wnd\[\d+\]\//.test(sid)) return { kind: 'sid', sid, type };
	}
	const name = p.name;
	if (!name || control.patterns.includes('name')) {
		return {
			kind: 'unknown',
			type,
			reason: control.known
				? `${label} has no technical name in the object repository`
				: `${label} is not in an object repository the import could read: export the test's object repository to XML (Object Repository Manager › File › Export to XML) and import again`
		};
	}
	const prefix = SID_PREFIX[type];
	const vkey = /^btn\[(\d+)\]$/.exec(name)?.[1];
	if (vkey !== undefined) return { kind: 'vkey', vkey: Number(vkey), type: 'GuiButton' };
	if (name.includes('['))
		return {
			kind: 'unknown',
			type,
			reason: `${label} (${name}) is a cell of a table or an indexed control: its full ID (id in the object repository) is needed`
		};
	if (!prefix)
		return {
			kind: 'unknown',
			type,
			reason: `the kind of field ${label} (${name}) is not known: its repository entry has no type or guicomponenttype`
		};
	const window = windowIndex(objects.findLast((o) => /^sapguiwindow$/i.test(o.className)));
	const sid = `wnd[${window ?? 0}]/usr/${prefix}${name}`;
	const assumed =
		window === undefined
			? `UFT ${label} is ${prefix}${name}, assumed in the main window directly on the screen (wnd[0]/usr)`
			: `UFT ${label} is ${prefix}${name}, assumed directly on the screen (wnd[${window}]/usr), not in a subscreen`;
	return { kind: 'sid', sid, type, assumed };
}

/**
 * Function keys by SAP's virtual key number, as WebGUI takes them from the keyboard. VKey 11 is
 * Save, Ctrl+S in WebGUI.
 */
function vkeyName(vkey: number): string | undefined {
	if (vkey === 0) return 'Enter';
	if (vkey === 11) return 'Control+S';
	if (vkey >= 1 && vkey <= 12) return `F${vkey}`;
	if (vkey >= 13 && vkey <= 24) return `Shift+F${vkey - 12}`;
	if (vkey >= 25 && vkey <= 36) return `Control+F${vkey - 24}`;
	if (vkey >= 37 && vkey <= 48) return `Control+Shift+F${vkey - 36}`;
	return {
		71: 'Control+F',
		80: 'Control+PageUp',
		81: 'PageUp',
		82: 'PageDown',
		83: 'Control+PageDown',
		86: 'Control+P'
	}[vkey];
}

/** UFT's SendKey constants (ENTER, F8, SHIFT_F3, CTRL_S, …) as keys for pressKey. */
export function sendKeyName(key: string): string | undefined {
	const k = key.toUpperCase();
	if (k === 'ENTER') return 'Enter';
	if (k === 'CTRL_S' || k === 'F11') return 'Control+S';
	const f = /^(SHIFT_|CTRL_|CTRL_SHIFT_)?F(\d{1,2})$/.exec(k);
	if (f) {
		const n = Number(f[2]);
		if (n < 1 || n > 12) return undefined;
		const mod =
			{ SHIFT_: 'Shift+', CTRL_: 'Control+', CTRL_SHIFT_: 'Control+Shift+' }[f[1] ?? ''] ?? '';
		return `${mod}F${n}`;
	}
	return {
		PAGEUP: 'PageUp',
		PAGEDOWN: 'PageDown',
		CTRL_PAGEUP: 'Control+PageUp',
		CTRL_PAGEDOWN: 'Control+PageDown',
		CTRL_F: 'Control+F',
		CTRL_P: 'Control+P'
	}[k];
}

/** The fields of the SAP GUI logon screen (S000): page.SAPLogin signs in instead. */
const LOGON_FIELDS = /^(?:RSYST-(?:BNAME|BCODE|MANDT|LANGU|NEWCODE))$/i;

// ---- Statements --------------------------------------------------------------------------------

const done = (line: Line, code: string[], describe: string, check?: string): Item => {
	const item: Item = { kind: 'statement', line: line.line, source: line.source, code, describe };
	if (check) item.check = check;
	return item;
};
const open = (line: Line, reason: string): Item => ({
	kind: 'statement',
	line: line.line,
	source: line.source,
	code: [],
	open: reason,
	describe: `Not translated: \`${line.source}\``
});

/** UFT methods that only wait or tidy up: nothing to do in Playwright, which waits for each control. */
const NOTHING_TO_DO =
	/^(?:sync|maximize|minimize|restore|activate|resize|move|highlight|refreshobject|init)$/i;

/** Translates the lines of one action. `next` lets a statement take the one after it (OK code + Enter). */
export function translateLines(lines: Line[], ctx: Context): Item[] {
	const items: Item[] = [];
	const statements = lines.filter((l) => !l.comment && !l.structure);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line) continue;
		if (line.comment !== undefined) {
			if (line.blocks.length === 0 && line.comment)
				items.push({ kind: 'comment', line: line.line, text: line.comment });
			continue;
		}
		if (line.structure) {
			// The lines that open a block are what a person has to translate by hand, with what is inside.
			if (/^(?:if|for|do|while|select)\b/i.test(line.source) && line.blocks.length === 0)
				items.push(
					open(
						line,
						'control flow (conditions and loops) is translated by hand, with the statements inside'
					)
				);
			else if (/^(?:function|sub)\b/i.test(line.source) && line.blocks.length === 0)
				items.push(
					open(line, 'a function of the action: write it as a helper in sap-tests/helpers')
				);
			continue;
		}
		if (line.blocks.length > 0) {
			const block = line.blocks.at(-1) ?? 'a block';
			items.push({
				kind: 'statement',
				line: line.line,
				source: line.source,
				code: [],
				open: `inside ${block}`,
				describe: `(inside ${block}) \`${line.source}\``
			});
			continue;
		}
		const statement = parseStatement(line.text);
		const nextLine = statements[statements.indexOf(line) + 1];
		const result = translateStatement(line, statement, ctx, nextLine);
		items.push(result.item);
		if (result.consumedNext && nextLine) i = lines.indexOf(nextLine);
	}
	return items;
}

function translateStatement(
	line: Line,
	statement: Statement,
	ctx: Context,
	next: Line | undefined
): { item: Item; consumedNext?: boolean } {
	if (statement.kind === 'other') {
		if (/^on\s+error\s+resume\s+next$/i.test(line.text))
			return {
				item: open(
					line,
					'UFT went on after errors from here on; a Playwright test stops at the first one. Remove this once the steps below are checked'
				)
			};
		if (/^on\s+error\s+goto\s+0$/i.test(line.text))
			return { item: done(line, [], 'Errors stop the test again (as in Playwright)') };
		return { item: open(line, 'not understood by the import') };
	}
	if (statement.kind === 'assign') return { item: translateAssign(line, statement, ctx) };
	const { segments, method, args } = statement;
	const m = method.toLowerCase();

	// Statements without an object.
	if (segments.length === 0) {
		if (m === 'runaction') {
			const name = literal(args[0]);
			if (!name)
				return { item: open(line, 'RunAction with an action name that is not a plain string') };
			const ref = /^(.*?)\s*\[(.+)\]\s*$/.exec(name);
			const item: Item = {
				kind: 'runAction',
				line: line.line,
				source: line.source,
				name: (ref?.[1] ?? name).trim()
			};
			if (ref?.[2]) item.test = ref[2].trim();
			const iterations = args[1] ? (bareName(args[1]) ?? literal(args[1])) : undefined;
			if (iterations && iterations.toLowerCase() !== 'oneiteration') item.iterations = iterations;
			return { item };
		}
		if (m === 'wait')
			return {
				item: done(line, [], 'A fixed wait in UFT: not needed, Playwright waits for each control')
			};
		if (m === 'msgbox' || m === 'print')
			return {
				item: done(line, [], `${method}: shows a text while UFT runs, not needed in a test`)
			};
		if (/^(?:exittest|exitaction|exitactioniteration|exittestiteration)$/.test(m))
			return {
				item: open(
					line,
					`${method} ends the test or action early: translate it with the condition around it`
				)
			};
		const library = ctx.functions.get(m);
		if (library)
			return {
				item: open(
					line,
					`calls ${method} from the function library ${library}: translate the function into a helper in sap-tests/helpers and call that`
				)
			};
		return {
			item: open(
				line,
				`calls ${method}, which the import does not know (a function from a library that was not part of the import?)`
			)
		};
	}

	const root = segments[0]?.name.toLowerCase() ?? '';
	if (root === 'reporter') {
		if (m === 'reportevent') {
			const step = args[1] ? value(args[1], ctx) : undefined;
			const status = bareName(args[0])?.toLowerCase();
			if (status === 'micfail')
				return {
					item: open(line, 'reports a failure: write the check that should fail here with expect')
				};
			return {
				item: done(
					line,
					step
						? [
								`// UFT reported: ${args
									.slice(1)
									.map((a) => literal(a) ?? '…')
									.join(' – ')}`
							]
						: [],
					'A report line of UFT (kept as a comment)'
				)
			};
		}
		return { item: done(line, [], `Reporter.${method}: reporting settings of UFT, not needed`) };
	}
	if (root === 'datatable')
		return {
			item: open(
				line,
				'works on the data sheet itself: write the data the test needs into the DATA constant, or one test per row'
			)
		};
	if (root === 'systemutil') {
		const program = literal(args[0])?.toLowerCase() ?? '';
		if (m === 'run' && /(?:iexplore|chrome|msedge|firefox)(?:\.exe)?$/.test(program)) {
			const url = literal(args[1]);
			if (url) return { item: navigate(line, url, ctx) };
		}
		if (m === 'run' && program.includes('saplogon'))
			return {
				item: done(
					line,
					[],
					'Starts SAP Logon: the test signs in to WebGUI with page.SAPLogin instead'
				)
			};
		if (m.startsWith('closeprocessby') || m === 'closedescendentprocesses')
			return {
				item: done(line, [], 'Closes programs after UFT: Playwright closes its browser itself')
			};
		return {
			item: open(line, `SystemUtil.${method} starts or stops programs on the UFT computer`)
		};
	}
	if (root === 'sapguiutil') {
		if (/^autologon/i.test(m))
			return {
				item: done(line, [], 'Signs in to SAP: done by page.SAPLogin at the start of the test')
			};
		if (/^close/i.test(m))
			return { item: done(line, [], 'Closes the SAP GUI connections: not needed in the browser') };
		return { item: open(line, `SAPGuiUtil.${method} has no counterpart in WebGUI`) };
	}

	const objects = resolveChain(segments, ctx);
	if (!objects)
		return { item: open(line, 'an object is named with something other than a plain string') };
	const classes = objects.map((o) => o.className);
	if (classes.some((c) => isSapGui(c))) {
		ctx.surface.sapgui++;
		return translateSapGui(line, objects, method, args, ctx, next);
	}
	if (classes.some((c) => isWeb(c))) {
		ctx.surface.fiori++;
		return { item: translateWeb(line, objects, method, args, ctx) };
	}
	return { item: open(line, `${classes.join('.')} is not an SAP GUI or web object`) };
}

function translateAssign(
	line: Line,
	statement: Extract<Statement, { kind: 'assign' }>,
	ctx: Context
): Item {
	const target = statement.target;
	const known = ctx.vars.get(target.toLowerCase());
	const declare = (expression: string, describe: string) => {
		if (known) return done(line, [`${known} = ${expression};`], describe);
		const name = varName(target);
		ctx.vars.set(target.toLowerCase(), name);
		return done(line, [`let ${name} = ${expression};`], describe);
	};
	const direct = value(statement.value, ctx);
	if (direct !== undefined) return declare(direct, `Remember ${target}`);
	// x = <object>.GetROProperty("…"): a value read from the screen.
	if (statement.value.kind === 'path') {
		const segments = [...statement.value.segments];
		const last = segments.pop();
		if (last?.name.toLowerCase() === 'getroproperty') {
			const property = literal(last.args?.[0])?.toLowerCase();
			const objects = resolveChain(segments, ctx);
			if (property && objects) {
				const read = readProperty(objects, property, ctx);
				if (read) return declare(read.expression, `Read ${read.describe} into ${target}`);
			}
		}
	}
	return open(line, 'a value the import cannot translate');
}

/** An expression that reads a property of a screen object, as GetROProperty does. */
function readProperty(
	objects: TestObject[],
	property: string,
	ctx: Context
): { expression: string; describe: string } | undefined {
	const control = objects.at(-1);
	if (!control) return undefined;
	if (/^sapguistatusbar$/i.test(control.className)) {
		ctx.surface.sapgui++;
		ctx.webgui.add('readStatusBar');
		if (property === 'text')
			return { expression: '(await readStatusBar(page)).text', describe: 'the status bar text' };
		if (property === 'messagetype')
			return {
				expression: '(await readStatusBar(page)).type',
				describe: 'the status bar message type'
			};
		return undefined;
	}
	if (objects.some((o) => isSapGui(o.className))) {
		ctx.surface.sapgui++;
		const target = sapTarget(objects);
		if (target.kind !== 'sid' || target.assumed) return undefined;
		const locator = sidLocator(target.sid);
		if (property === 'value' || property === 'text')
			return {
				expression: `await ${locator}.inputValue()`,
				describe: `the value of ${target.sid}`
			};
	}
	return undefined;
}

function translateSapGui(
	line: Line,
	objects: TestObject[],
	method: string,
	args: Expr[],
	ctx: Context,
	next: Line | undefined
): { item: Item; consumedNext?: boolean } {
	const m = method.toLowerCase();
	const control = objects.at(-1);
	const cls = control?.className.toLowerCase() ?? '';
	if (NOTHING_TO_DO.test(m))
		return { item: done(line, [], `${method}: not needed, Playwright waits for each control`) };

	if (cls === 'sapguisession') {
		if (m === 'reset')
			return {
				item: done(line, [], 'Back to the start: each Playwright test starts on its own anyway')
			};
		return { item: open(line, `SAPGuiSession.${method} has no counterpart in WebGUI`) };
	}
	if (cls === 'sapguiwindow') {
		if (m === 'sendkey') {
			const key = bareName(args[0]) ?? literal(args[0]);
			const name = key ? sendKeyName(key) : undefined;
			if (!name)
				return { item: open(line, `the key ${key ?? '?'} has no counterpart the import knows`) };
			ctx.webgui.add('pressKey');
			return { item: done(line, [`await pressKey(page, ${str(name)});`], `Press ${name}`) };
		}
		if (m === 'close')
			return {
				item: open(
					line,
					'closes an SAP GUI window: in WebGUI, use the button or key that closes it (often F12 or F3)'
				)
			};
		return { item: open(line, `SAPGuiWindow.${method} has no counterpart the import knows`) };
	}
	if (cls === 'sapguistatusbar') {
		if (m === 'checkproperty') {
			const property = literal(args[0])?.toLowerCase();
			const expected = args[1] ? value(args[1], ctx) : undefined;
			if (property === 'messagetype' && args[1]) {
				const type = literal(args[1])?.toUpperCase();
				if (type && /^[SWEAI]$/.test(type)) {
					ctx.webgui.add('expectStatusBar');
					return {
						item: done(
							line,
							[`await expectStatusBar(page, ${str(type)});`],
							`The status bar shows a message of type ${type}`
						)
					};
				}
			}
			if (property === 'text' && expected) {
				ctx.webgui.add('readStatusBar');
				return {
					item: done(
						line,
						[`await expect.poll(async () => (await readStatusBar(page)).text).toBe(${expected});`],
						'The status bar shows the text'
					)
				};
			}
		}
		if (m === 'check')
			return {
				item: open(
					line,
					'a checkpoint: what it checks is in the binary Resource.mtr. Write it with expectStatusBar(page, type, text)'
				)
			};
		return { item: open(line, `SAPGuiStatusBar.${method} has no counterpart the import knows`) };
	}

	// OK code: `/nVA01` with Enter right after is a transaction start.
	if (cls === 'sapguiokcode' && m === 'set') {
		const code = literal(args[0]);
		const tcode =
			code === undefined ? undefined : /^(?:\/n)?([A-Za-z]\w*)$/i.exec(code.trim())?.[1];
		const nextStatement = next ? parseStatement(next.text) : undefined;
		const enterNext =
			nextStatement?.kind === 'call' &&
			nextStatement.method.toLowerCase() === 'sendkey' &&
			/^enter$/i.test(bareName(nextStatement.args[0]) ?? literal(nextStatement.args[0]) ?? '') &&
			next?.blocks.length === 0;
		if (tcode && enterNext) {
			ctx.webgui.add('runTransaction');
			return {
				item: done(
					line,
					[`await runTransaction(page, ${str(tcode.toUpperCase())});`],
					`Start transaction ${tcode.toUpperCase()}`
				),
				consumedNext: true
			};
		}
		const v = args[0] ? value(args[0], ctx) : undefined;
		if (!v) return { item: open(line, 'a value the import cannot translate') };
		return {
			item: done(
				line,
				[`await page.getByRoleSID('okCode', {}).fill(${v});`],
				'Type into the command field'
			)
		};
	}

	const target = sapTarget(objects);
	if (target.kind === 'unknown') return { item: open(line, target.reason) };
	if (target.kind === 'vkey') {
		const key = vkeyName(target.vkey);
		if (!key || !/^(?:click|press)$/.test(m))
			return {
				item: open(
					line,
					`the toolbar button btn[${target.vkey}] without its full ID: give its id in the object repository`
				)
			};
		ctx.webgui.add('pressKey');
		return {
			item: done(
				line,
				[`await pressKey(page, ${str(key)});`],
				`Press toolbar button btn[${target.vkey}] (${key})`,
				`UFT ${control?.logical ? `"${control.logical}"` : 'button'} is btn[${target.vkey}]; pressed as its function key ${key}`
			)
		};
	}
	const name = target.sid.split('/').at(-1) ?? '';
	if (LOGON_FIELDS.test(name.replace(/^[a-z]+/, '')))
		return {
			item: done(line, [], 'The SAP logon screen: page.SAPLogin signs in at the start of the test')
		};
	const locator = sidLocator(target.sid);
	const what = control?.logical ? `"${control.logical}" (${target.sid})` : target.sid;
	const isPassword = target.type === 'GuiPasswordField' || target.sid.includes('/pwd');

	if (target.type === 'GuiComboBox' && (m === 'set' || m === 'select'))
		return {
			item: open(
				line,
				'a combo box: in WebGUI it is a list to open and pick from; record this step once to see how'
			)
		};
	if (m === 'set') {
		if (isPassword)
			return {
				item: open(
					line,
					'a password field: use fillSecret(locator, process.env.<SETTING>!) with the password from a setting, never a value in the code'
				)
			};
		const type = target.type;
		if (type === 'GuiCheckBox') {
			const on = (literal(args[0]) ?? '').toUpperCase();
			if (on !== 'ON' && on !== 'OFF')
				return { item: open(line, 'a check box set to a value that is not ON or OFF') };
			return {
				item: done(
					line,
					[`await ${locator}.${on === 'ON' ? 'check' : 'uncheck'}();`],
					`${on === 'ON' ? 'Tick' : 'Untick'} ${what}`,
					target.assumed
				)
			};
		}
		if (type === 'GuiRadioButton')
			return { item: done(line, [`await ${locator}.click();`], `Choose ${what}`, target.assumed) };
		const v = args[0] ? value(args[0], ctx) : undefined;
		if (!v) return { item: open(line, 'a value the import cannot translate') };
		return {
			item: done(
				line,
				[`await ${locator}.fill(${v});`],
				`Enter ${describeValue(args[0])} in ${what}`,
				target.assumed
			)
		};
	}
	if (m === 'setsecure')
		return {
			item: open(
				line,
				'an encrypted value (SetSecure): put it into a setting and use fillSecret(locator, process.env.<SETTING>!)'
			)
		};
	if (m === 'select' && target.type === 'GuiRadioButton')
		return { item: done(line, [`await ${locator}.click();`], `Choose ${what}`, target.assumed) };
	if (m === 'select' && target.type === 'GuiTab')
		return {
			item: done(line, [`await ${locator}.click();`], `Open the tab ${what}`, target.assumed)
		};
	if (/^(?:click|press)$/.test(m))
		return { item: done(line, [`await ${locator}.click();`], `Click ${what}`, target.assumed) };
	if (m === 'setfocus')
		return {
			item: done(line, [`await ${locator}.focus();`], `Put the cursor in ${what}`, target.assumed)
		};
	if (m === 'checkproperty') {
		const property = literal(args[0])?.toLowerCase();
		const expected = args[1] ? value(args[1], ctx) : undefined;
		if ((property === 'value' || property === 'text') && expected)
			return {
				item: done(
					line,
					[`await expect(${locator}).toHaveValue(${expected});`],
					`${what} shows ${describeValue(args[1])}`,
					target.assumed
				)
			};
		if (property === 'enabled' || property === 'changeable') {
			const on = (bareName(args[1]) ?? literal(args[1]) ?? '').toLowerCase();
			if (on === 'true' || on === 'false')
				return {
					item: done(
						line,
						[`await expect(${locator}).${on === 'true' ? 'toBeEditable' : 'not.toBeEditable'}();`],
						`${what} is ${on === 'true' ? '' : 'not '}changeable`,
						target.assumed
					)
				};
		}
		return {
			item: open(
				line,
				`checks the property ${property ?? '?'}, which the import does not translate`
			)
		};
	}
	if (m === 'check')
		return {
			item: open(
				line,
				'a checkpoint: what it checks is in the binary Resource.mtr. Write it with expect'
			)
		};
	if (m === 'output')
		return {
			item: open(
				line,
				'an output value into the data sheet: read the value into a variable instead'
			)
		};
	return {
		item: open(
			line,
			`${control?.className ?? 'SAPGui'}.${method} has no counterpart the import knows`
		)
	};
}

function describeValue(expr: Expr | undefined): string {
	if (!expr) return 'a value';
	if (expr.kind === 'string' || expr.kind === 'number') return `"${expr.value}"`;
	if (expr.kind === 'concat') return expr.parts.map(describeValue).join(' and ');
	if (expr.kind !== 'path') return 'a value';
	const [first, second] = expr.segments;
	const head = first?.name.toLowerCase();
	const key = literal(first?.args?.[0]) ?? literal(second?.args?.[0]);
	if (head === 'datatable' && key) return `the data sheet value "${key}"`;
	if ((head === 'parameter' || head === 'testargs') && key) return `the parameter "${key}"`;
	if (head === 'environment' && key) return `the environment value "${key}"`;
	return expr.segments.map((s) => s.name).join('.');
}

// ---- Web and SAPUI5 → Fiori --------------------------------------------------------------------

function navigate(line: Line, url: string, ctx: Context): Item {
	ctx.surface.fiori++;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return open(line, 'an address the import cannot read');
	}
	const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
	return done(
		line,
		[`await page.goto(new URL(${str(path)}, process.env.SAP_URL).href);`],
		`Open ${path}`,
		`UFT opened ${parsed.origin}; the test opens the same path on SAP_URL`
	);
}

/** The text a web or UI5 object shows, from the properties UFT keeps for it. */
function shownText(o: TestObject): { text: string; assumed?: string } | undefined {
	const p = o.properties;
	for (const key of ['text', 'innertext', 'name', 'value', 'title']) {
		const v = p[key];
		if (v && !o.patterns.includes(key)) return { text: v.trim() };
	}
	if (o.logical && !o.known)
		return {
			text: o.logical,
			assumed: `the text "${o.logical}" is the logical name in UFT; no object repository named the control's text`
		};
	return undefined;
}

function translateWeb(
	line: Line,
	objects: TestObject[],
	method: string,
	args: Expr[],
	ctx: Context
): Item {
	const m = method.toLowerCase();
	const control = objects.at(-1);
	const cls = control?.className.toLowerCase() ?? '';
	if (NOTHING_TO_DO.test(m))
		return done(line, [], `${method}: not needed, Playwright waits for each control`);
	if (cls === 'browser') {
		if (m === 'navigate' || m === 'openurl') {
			const url = literal(args[0]);
			return url ? navigate(line, url, ctx) : open(line, 'an address the import cannot translate');
		}
		if (/^(?:close|closealltabs)$/.test(m))
			return done(line, [], 'Closes the browser: Playwright closes it after the test');
		if (m === 'back') return done(line, ['await page.goBack();'], 'Go back in the browser');
		if (m === 'refresh') return done(line, ['await page.reload();'], 'Reload the page');
		return open(line, `Browser.${method} has no counterpart the import knows`);
	}
	if (cls === 'page' || cls === 'frame') {
		if (m === 'checkproperty' && literal(args[0])?.toLowerCase() === 'title' && args[1]) {
			const expected = value(args[1], ctx);
			if (expected)
				return done(
					line,
					[`await expect(page).toHaveTitle(${expected});`],
					'The page has the title'
				);
		}
		return open(line, `${control?.className}.${method} has no counterpart the import knows`);
	}
	if (!control) return open(line, 'no object');
	const shown = shownText(control);

	const isButton = /^(?:webbutton|sapuibutton|sapbutton)$/.test(cls);
	const isLink = cls === 'link' || cls === 'sapuilink';
	if ((isButton || isLink) && m === 'click') {
		if (!shown) return open(line, 'a button or link the import knows no text of');
		if (isButton) {
			ctx.fiori.add('button');
			return done(
				line,
				[`await button(page, ${str(shown.text)}).click();`],
				`Click the button "${shown.text}"`,
				shown.assumed
			);
		}
		return done(
			line,
			[`await page.getByRoleUI5('Link', { text: ${str(shown.text)} }).click();`],
			`Click the link "${shown.text}"`,
			shown.assumed
		);
	}
	if (cls === 'sapuitile' && m === 'click') {
		const header = control.properties.header || control.properties.title || shown?.text;
		if (!header) return open(line, 'a tile the import knows no header of');
		ctx.fiori.add('tile');
		return done(
			line,
			[`await tile(page, ${str(header)}).click();`],
			`Open the tile "${header}"`,
			control.properties.header || control.properties.title ? undefined : shown?.assumed
		);
	}
	if (/^(?:webedit|sapuiedit|sapuitextedit|sapedit|sapuitextarea)$/.test(cls) && m === 'set') {
		const placeholder = control.properties.placeholder;
		const v = args[0] ? value(args[0], ctx) : undefined;
		if (!v) return open(line, 'a value the import cannot translate');
		if (placeholder)
			return done(
				line,
				[`await page.getByRoleUI5('Input', { placeholder: ${str(placeholder)} }).fill(${v});`],
				`Enter ${describeValue(args[0])} in the field "${placeholder}"`
			);
		return open(
			line,
			'an input field without a placeholder in the object repository: record this step once to get its UI5 locator (label, binding path)'
		);
	}
	if (m === 'setsecure')
		return open(
			line,
			'an encrypted value (SetSecure): put it into a setting and use fillSecret(locator, process.env.<SETTING>!)'
		);
	return open(line, `${control.className}.${method}: record this step once to get its UI5 locator`);
}
