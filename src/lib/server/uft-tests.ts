import { isRepositoryXml, readRepository, type Repository } from './uft-repository.js';
import {
	newContext,
	OPEN_MARKER,
	str,
	translateLines,
	type Context,
	type Item
} from './uft-translate.js';
import { scriptLines } from './uft-vbscript.js';
import type { UftFile, UftTarget } from '#lib/shared/uft.js';

/**
 * The UFT tests of a source (an uploaded folder or a Git checkout) and their translation into one
 * Playwright test each. A UFT GUI test is a folder with one subfolder per action (Action0 holds
 * the test flow, Action1… the actions it calls), each with its VBScript in Script.mts.
 */

interface UftAction {
	/** The action's folder, e.g. Action1. */
	folder: string;
	/** The name the test flow calls it by, e.g. "Create order"; the folder when it is not known. */
	name: string;
	script: string;
}

export interface UftTest {
	/** The test's folder, relative to the source. */
	path: string;
	/** The folder's name, which UFT uses as the test's name. */
	name: string;
	/** Action0: the order in which the test runs its actions. */
	flow?: string;
	actions: UftAction[];
	notes: string[];
}

const posix = (p: string) => p.replaceAll('\\', '/').replace(/^\.?\//, '');
const baseOf = (p: string) => p.split('/').at(-1) ?? p;
/** The number of an action folder: 0 for Action0, the flow. */
const number = (folder: string) => Number(/\d+/.exec(folder)?.[0] ?? 0);

/** Actions as the flow calls them: `RunAction "Create order [VA01]", oneIteration`. */
const RUN_ACTION = /^\s*RunAction\s+"([^"[]+?)\s*(?:\[([^\]]*)\])?"/gim;

/** The tests of a source: every folder with Action<n>/Script.mts in it. */
export function findTests(files: UftFile[]): UftTest[] {
	const byTest = new Map<string, Map<string, string>>();
	for (const file of files) {
		const path = posix(file.path);
		const m = /^(?:(.*)\/)?(Action\d+)\/Script\.mts$/i.exec(path);
		if (!m) continue;
		const root = m[1] ?? '';
		const actions = byTest.get(root) ?? new Map<string, string>();
		actions.set(m[2] ?? '', file.text);
		byTest.set(root, actions);
	}
	const tests: UftTest[] = [];
	for (const [path, scripts] of byTest) {
		const name = baseOf(path) || 'UFT test';
		const notes: string[] = [];
		const folders = [...scripts.keys()]
			.filter((f) => number(f) !== 0)
			.toSorted((a, b) => number(a) - number(b));
		const flowFolder = [...scripts.keys()].find((f) => number(f) === 0);
		const flow = flowFolder ? scripts.get(flowFolder) : undefined;
		// The names the flow calls its actions by. Which folder holds which name is in the binary
		// Test.tsp: a name that is a folder (Action2) is that folder, the others are taken in order.
		// A call of another test's action ("Login [Common]") names no folder of this test.
		const called = flow
			? [...flow.matchAll(RUN_ACTION)]
					.filter((c) => !c[2] || c[2].trim().toLowerCase() === name.toLowerCase())
					.map((c) => (c[1] ?? '').trim())
			: [];
		const free = folders.filter((f) => !called.some((c) => c.toLowerCase() === f.toLowerCase()));
		const named = new Map<string, string>();
		let guessed = false;
		for (const call of new Set(called)) {
			const folder = folders.find((f) => f.toLowerCase() === call.toLowerCase());
			if (folder) {
				named.set(folder, folder);
				continue;
			}
			const next = free.shift();
			if (next) {
				named.set(next, call);
				guessed = true;
			}
		}
		if (guessed)
			notes.push(
				'The flow calls its actions by name; which folder holds which action is in the binary Test.tsp, so they were matched in the order of their numbers. Check that each step holds the right action.'
			);
		tests.push({
			path,
			name,
			...(flow === undefined ? {} : { flow }),
			actions: folders.map((folder) => ({
				folder,
				name: named.get(folder) ?? folder,
				script: scripts.get(folder) ?? ''
			})),
			notes
		});
	}
	return tests.toSorted((a, b) => a.path.localeCompare(b.path));
}

/** What a whole source holds besides its tests: read once, used for each of them. */
export interface SourceIndex {
	/** Each exported object repository, by its path. */
	repositories: { path: string; repo: Repository }[];
	problems: string[];
	/** The functions of the function libraries (.qfl, .vbs), by lower-case name. */
	functions: Map<string, string>;
}

export function indexSource(files: UftFile[]): SourceIndex {
	const repositories: SourceIndex['repositories'] = [];
	const problems: string[] = [];
	const xml = files.filter((f) => /\.xml$/i.test(f.path) && isRepositoryXml(f.text));
	for (const file of xml.toSorted((a, b) => a.path.localeCompare(b.path))) {
		try {
			repositories.push({ path: posix(file.path), repo: readRepository(file.text) });
		} catch (e) {
			problems.push(`${posix(file.path)}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	return { repositories, problems, functions: libraryFunctions(files) };
}

/** The objects a test looks up: its own repositories first, they win over shared ones. */
function repositoryFor(index: SourceIndex, test: UftTest): { repo: Repository; used: string[] } {
	const own = (path: string) => (test.path && path.startsWith(`${test.path}/`) ? 0 : 1);
	const ordered = index.repositories.toSorted((a, b) => own(a.path) - own(b.path));
	const repo: Repository = new Map();
	for (const { repo: objects } of ordered)
		for (const [key, object] of objects) if (!repo.has(key)) repo.set(key, object);
	return { repo, used: ordered.map((r) => r.path) };
}

/** The functions defined in the function libraries of a source (.qfl, .vbs), by lower-case name. */
function libraryFunctions(files: UftFile[]): Map<string, string> {
	const functions = new Map<string, string>();
	for (const file of files) {
		if (!/\.(qfl|vbs)$/i.test(file.path)) continue;
		for (const m of file.text.matchAll(/^\s*(?:(?:public|private)\s+)?(?:function|sub)\s+(\w+)/gim))
			if (m[1]) functions.set(m[1].toLowerCase(), posix(file.path));
	}
	return functions;
}

// ---- Translating a whole test ------------------------------------------------------------------

/** A test.step: an action and what it holds. */
interface Step {
	title: string;
	items: (Item | Step)[];
}

export interface Translation {
	test: UftTest;
	body: (Item | Step)[];
	ctx: Context;
	statements: number;
	translated: number;
	target: UftTarget;
	notes: string[];
	repositories: string[];
}

const isStep = (x: Item | Step): x is Step => 'title' in x;

function count(items: (Item | Step)[]): { statements: number; translated: number } {
	let statements = 0;
	let translated = 0;
	for (const item of items) {
		if (isStep(item)) {
			const inner = count(item.items);
			statements += inner.statements;
			translated += inner.translated;
		} else if (item.kind === 'statement') {
			statements++;
			if (!item.open) translated++;
		}
	}
	return { statements, translated };
}

const MAX_DEPTH = 8;

/** Translates one test: its flow with each called action as a step, or its actions in order. */
export function translateTest(test: UftTest, all: UftTest[], index: SourceIndex): Translation {
	const { repo, used } = repositoryFor(index, test);
	const ctx = newContext(repo, index.functions);
	const notes = [...test.notes, ...index.problems.map((p) => `Object repository not read: ${p}`)];
	const iterationNotes = new Set<string>();

	const actionItems = (
		owner: UftTest,
		action: UftAction,
		depth: number,
		seen: Set<string>
	): (Item | Step)[] => {
		// Each action has its own variables (as in UFT) and becomes a test.step of its own: a
		// variable of one is no variable of the other.
		const outer = { action: ctx.action, vars: ctx.vars };
		ctx.action = action.name;
		ctx.vars = new Map();
		const items = expand(translateLines(scriptLines(action.script), ctx), owner, depth, seen);
		ctx.action = outer.action;
		ctx.vars = outer.vars;
		return items;
	};

	function expand(
		items: Item[],
		owner: UftTest,
		depth: number,
		seen: Set<string>
	): (Item | Step)[] {
		return items.map((item): Item | Step => {
			if (item.kind !== 'runAction') return item;
			const unresolved = (reason: string): Item => ({
				kind: 'statement',
				line: item.line,
				source: item.source,
				code: [],
				open: reason,
				describe: `Run the action "${item.name}" (not found)`
			});
			const testOf = item.test
				? all.find((t) => t.name.toLowerCase() === item.test?.toLowerCase())
				: owner;
			if (!testOf)
				return unresolved(
					`calls the action "${item.name}" of the test "${item.test}", which was not part of the import`
				);
			const action = testOf.actions.find(
				(a) =>
					a.name.toLowerCase() === item.name.toLowerCase() ||
					a.folder.toLowerCase() === item.name.toLowerCase()
			);
			if (!action)
				return unresolved(
					`calls the action "${item.name}", which the import did not find in ${testOf.name}`
				);
			const key = `${testOf.path}/${action.folder}`;
			if (seen.has(key) || depth >= MAX_DEPTH)
				return unresolved(`calls the action "${item.name}" again from inside itself`);
			if (item.iterations)
				iterationNotes.add(
					`UFT runs the action "${item.name}" for the rows ${item.iterations} of its data sheet; the test runs it once.`
				);
			const title = testOf === test ? action.name : `${action.name} (from ${testOf.name})`;
			return { title, items: actionItems(testOf, action, depth + 1, new Set([...seen, key])) };
		});
	}

	let body: (Item | Step)[];
	if (test.flow === undefined) {
		body = test.actions.map((a) => ({
			title: a.name,
			items: actionItems(test, a, 1, new Set([`${test.path}/${a.folder}`]))
		}));
	} else {
		ctx.action = 'Action0';
		body = expand(translateLines(scriptLines(test.flow), ctx), test, 0, new Set());
	}
	notes.push(...iterationNotes);
	if (ctx.data.has('DATA'))
		notes.push(
			'UFT runs a test once per row of its global data sheet (unless set to one iteration); the test file runs it once, with the values in DATA.'
		);
	const { statements, translated } = count(body);
	const { sapgui, fiori } = ctx.surface;
	const target: UftTarget =
		sapgui && fiori ? 'mixed' : sapgui ? 'sapgui' : fiori ? 'fiori' : 'other';
	return { test, body, ctx, statements, translated, target, notes, repositories: used };
}

// ---- Rendering --------------------------------------------------------------------------------

export interface RenderInput {
	translation: Translation;
	title: string;
	/** `@uft-<slug>`: finds the test file again on the next import. */
	tag: string;
	/** The source, for the comment: "upload" or "github.com/org/repo@main". */
	origin: string;
	/** Relative to the repository root. */
	specFile: string;
	planFile: string;
	/** Imports of the test file, relative to its folder. */
	pluginImport: string;
	helpersImport: string;
	seed: { file: string; project?: string };
	importedOn: string;
}

/** The marker of the person who checked a translated test, which the Tests page reads. */
export const REVIEW_MARKER = 'Aus UFT übersetzt, geprüft von:';

const oneLine = (text: string) => text.replaceAll(/\s+/g, ' ').trim();

function renderItems(items: (Item | Step)[], indent: string, out: string[]) {
	for (const item of items) {
		if (isStep(item)) {
			out.push(`${indent}await test.step(${str(oneLine(item.title))}, async () => {`);
			renderItems(item.items, `${indent}\t`, out);
			out.push(`${indent}});`);
			continue;
		}
		if (item.kind === 'comment') {
			out.push(`${indent}// ${oneLine(item.text)}`);
			continue;
		}
		if (item.kind !== 'statement') continue;
		if (item.open) {
			out.push(
				`${indent}// ${OPEN_MARKER} (line ${item.line}): ${oneLine(item.open)}`,
				`${indent}// ${oneLine(item.source)}`
			);
			continue;
		}
		item.code.forEach((code, i) => {
			const last = i === item.code.length - 1;
			out.push(`${indent}${code}${last && item.check ? ` // check: ${oneLine(item.check)}` : ''}`);
		});
	}
}

const isCode = (l: string) => !l.trimStart().startsWith('//');

/** Whether the rendered code (not its comments) uses `name`. */
function uses(lines: string[], name: string) {
	const word = new RegExp(`\\b${name}\\b`);
	return lines.some((l) => isCode(l) && word.test(l));
}

/**
 * Variables as the linter wants them: `const` unless assigned again. One that only statements
 * still to be translated read stays a comment until those are written: unused, it would fail lint.
 */
function tidyVariables(lines: string[]): string[] {
	return lines.map((l, i) => {
		const name = /^\s*let (\w+) = /.exec(l)?.[1];
		if (!name) return l;
		const others = lines.filter((_, j) => j !== i);
		const assigned = new RegExp(`^\\s*${name} = `);
		const out = others.some((o) => assigned.test(o)) ? l : l.replace(/\blet /, 'const ');
		if (uses(others, name)) return out;
		const indent = /^\s*/.exec(out)?.[0] ?? '';
		return `${indent}// ${out.trimStart()} (used only by statements still to be translated)`;
	});
}

export function renderSpec(input: RenderInput): string {
	const { translation: t } = input;
	const rendered: string[] = [];
	renderItems(t.body, '\t', rendered);
	const body = tidyVariables(rendered);
	const dataLines: string[] = [];
	// Only those the translated code reads: the statements still to do keep theirs in the comment.
	const data = [...t.ctx.data].filter(([constant]) => uses(body, constant));
	for (const [constant, keys] of data) {
		const what =
			constant === 'DATA'
				? 'the global data sheet (Default.xls)'
				: constant === 'PARAMETERS'
					? 'the test and action parameters'
					: constant === 'ENVIRONMENT'
						? "UFT's environment variables"
						: `the data sheet of the action ${constant.slice('DATA_'.length).toLowerCase()}`;
		dataLines.push(
			`// ${OPEN_MARKER}: the values of ${what}, which the import cannot read. Fill them in.`,
			`const ${constant} = {`,
			...[...keys].map((k) => `\t${/^[A-Za-z_$][\w$]*$/.test(k) ? k : str(k)}: '',`),
			'};',
			''
		);
	}
	const open = t.statements - t.translated + data.length;
	const webgui = [...t.ctx.webgui].filter((h) => uses(body, h)).toSorted();
	const fiori = [...t.ctx.fiori].filter((h) => uses(body, h)).toSorted();
	const lines = [
		`// ${REVIEW_MARKER}`,
		`// Translated from the UFT test ${oneLine(t.test.path || t.test.name)} (${oneLine(input.origin)}) on ${input.importedOn}: ${t.translated} of ${t.statements} statements.`,
		`// Plan: ${input.planFile}. The UFT statements still to be written by hand are marked as to do;`,
		'// once there are none left and the test has passed, change test.fixme to test.',
		`import { test${uses(body, 'expect') ? ', expect' : ''} } from ${str(input.pluginImport)};`,
		...(webgui.length > 0
			? [`import { ${webgui.join(', ')} } from ${str(`${input.helpersImport}/webgui`)};`]
			: []),
		...(fiori.length > 0
			? [`import { ${fiori.join(', ')} } from ${str(`${input.helpersImport}/fiori`)};`]
			: []),
		`import { requireEnv } from ${str(`${input.helpersImport}/env`)};`,
		'',
		...dataLines,
		`test${open > 0 ? '.fixme' : ''}(${str(input.title)}, { tag: ['@uft', ${str(input.tag)}] }, async ({ page }) => {`,
		"\trequireEnv('SAP_URL', 'SAP_USERNAME', 'SAP_PASSWORD');",
		'\tawait page.SAPLogin(process.env.SAP_USERNAME!, process.env.SAP_PASSWORD!, process.env.SAP_URL);',
		...body,
		'});'
	];
	return `${lines.join('\n')}\n`;
}

const TARGET_TEXT: Record<UftTarget, string> = {
	sapgui:
		'It drives SAP GUI for Windows. The translation runs in SAP WebGUI (SAP GUI for HTML): the same transactions and screens, with the fields found by the IDs of SAP GUI Scripting, which UFT recorded.',
	fiori:
		'It drives a browser (Fiori, SAPUI5 or web pages). The translation uses the UI5 locators of sap-plugin.',
	mixed:
		'It drives SAP GUI for Windows and a browser. The SAP GUI part runs in SAP WebGUI, the browser part with the UI5 locators.',
	other: 'The import found no SAP GUI or browser objects in it.'
};

function planSteps(items: (Item | Step)[], out: string[], prefix: string) {
	let n = 0;
	for (const item of items) {
		if (isStep(item)) {
			out.push('', `**${prefix}${oneLine(item.title)}**`, '');
			planSteps(item.items, out, `${prefix}${oneLine(item.title)} › `);
			out.push('');
			continue;
		}
		if (item.kind !== 'statement') continue;
		if (!item.open && item.code.length === 0) continue;
		n++;
		const what = item.open
			? `Not translated (line ${item.line}): \`${oneLine(item.source)}\` – ${oneLine(item.open)}`
			: oneLine(item.describe);
		out.push(`${n}. ${what}${item.check ? ` – check: ${oneLine(item.check)}` : ''}`);
	}
}

export function renderPlan(input: RenderInput): string {
	const { translation: t } = input;
	const lines = [
		`# ${oneLine(input.title)}`,
		'',
		'## Application Overview',
		'',
		`Translated from the UFT test \`${oneLine(t.test.path || t.test.name)}\` (${oneLine(input.origin)}) on ${input.importedOn}. ${TARGET_TEXT[t.target]}`,
		'',
		`**${t.translated} of ${t.statements} statements translated.** The others are in the test file as comments marked \`${OPEN_MARKER}\`, with the reason, and listed below as "Not translated". Write them by hand, record those steps once, or let the generator agent fill them in from this plan; then run the test and check each step marked "check" once.`,
		''
	];
	if (t.repositories.length > 0)
		lines.push(`**Object repositories:** ${t.repositories.map((r) => `\`${r}\``).join(', ')}.`, '');
	else
		lines.push(
			'**No object repository** was read (only exported XML can be): objects known only by their logical name could not be translated.',
			''
		);
	for (const note of t.notes) lines.push(`- ${note}`);
	if (t.notes.length > 0) lines.push('');
	lines.push(
		'## Test Scenarios',
		'',
		`### 1. ${oneLine(input.title)}`,
		'',
		`**Seed:** \`${input.seed.file}\`${input.seed.project ? ` (project \`${input.seed.project}\`)` : ''}`,
		'',
		`#### 1.1. ${oneLine(input.title)}`,
		'',
		`**File:** \`${input.specFile}\``,
		'',
		'**Steps:**',
		''
	);
	planSteps(t.body, lines, '');
	return `${lines
		.join('\n')
		.replaceAll(/\n{3,}/g, '\n\n')
		.trimEnd()}\n`;
}
