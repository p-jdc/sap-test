import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { readTestEnv } from './env-file.js';
import {
	octaneConfig,
	octaneLink,
	testKind,
	withOctane,
	type OctaneConfig,
	type OctaneSession,
	type OctaneTest
} from './octane.js';
import { OctaneError } from './octane-error.js';
import {
	htmlToText,
	parseGherkinScript,
	parseManualScript,
	type ParsedScript,
	type PlanScenario,
	type PlanStep
} from './octane-script.js';
import { TESTS_DIR, TESTS_ROOT, toPosix, within } from './paths.js';
import { signInSystems, systemsOfFiles } from './systems.js';
import type {
	ImportedFile,
	OctaneImportResult,
	OctaneSearchResult,
	OctaneTestSummary
} from '#lib/shared/octane.js';

/**
 * Imports Octane test cases into the test project: per test a plan in sap-tests/specs (the format
 * of the planner agent, which a person checks and the generator agent turns into code) and a
 * test file with one empty `test.step` per step, marked `test.fixme` until it is filled in.
 */

const SPECS_DIR = resolve(TESTS_ROOT, 'specs');

/** The start of every file imported from an Octane test: `octane-<id>-`. */
const prefix = (id: string) => `octane-${id}-`;

export function slug(name: string): string {
	return (
		name
			.replaceAll('ß', 'ss')
			.normalize('NFKD')
			.replaceAll(/[\u0300-\u036F]/g, '')
			.toLowerCase()
			.replaceAll(/[^a-z0-9]+/g, '-')
			.replaceAll(/^-|-$/g, '')
			.slice(0, 60)
			.replace(/-$/, '') || 'test'
	);
}

/** The files already imported from each test, relative to sap-tests, found by their prefix. */
function importedFiles(): Map<string, { plan?: string; spec?: string }> {
	const found = new Map<string, { plan?: string; spec?: string }>();
	const note = (file: string, kind: 'plan' | 'spec') => {
		const id = /(?:^|\/)octane-(\d+)-[^/]*$/.exec(file)?.[1];
		if (!id) return;
		const entry = found.get(id) ?? {};
		entry[kind] ??= file;
		found.set(id, entry);
	};
	if (existsSync(SPECS_DIR))
		for (const name of readdirSync(SPECS_DIR))
			if (name.endsWith('.plan.md')) note(`specs/${name}`, 'plan');
	if (existsSync(TESTS_DIR))
		for (const name of readdirSync(TESTS_DIR, { recursive: true, encoding: 'utf8' }))
			if (name.endsWith('.spec.ts')) note(`tests/${toPosix(name)}`, 'spec');
	return found;
}

/** The importer's settings, or an error that names those missing. */
async function config(): Promise<OctaneConfig> {
	const result = octaneConfig(await readTestEnv());
	if (result.missing)
		throw new OctaneError(
			`Octane is not set up yet. Set ${result.missing.join(', ')} on the Settings page.`
		);
	return result.config;
}

const names = (list: OctaneTest['product_areas']) =>
	(list?.data ?? []).map((n) => n.name ?? '').filter(Boolean);

function summary(
	cfg: OctaneConfig,
	test: OctaneTest,
	files: Map<string, { plan?: string; spec?: string }>
): OctaneTestSummary | undefined {
	const kind = testKind(test);
	if (!kind) return undefined;
	const out: OctaneTestSummary = {
		id: test.id,
		name: test.name,
		kind,
		productAreas: names(test.product_areas),
		tags: names(test.user_tags),
		link: octaneLink(cfg, test.id)
	};
	if (test.phase?.name) out.phase = test.phase.name;
	const owner = test.owner?.full_name || test.owner?.name;
	if (owner) out.owner = owner;
	const imported = files.get(test.id);
	if (imported?.plan) out.plan = imported.plan;
	if (imported?.spec) out.spec = imported.spec;
	return out;
}

/** One page of the manual and Gherkin tests matching `text`, with what was imported from each. */
export async function searchOctane(text: string, offset = 0): Promise<OctaneSearchResult> {
	const cfg = await config();
	const { tests, total } = await withOctane(cfg, (s) => s.search(text, offset));
	const files = importedFiles();
	return {
		tests: tests.flatMap((t) => summary(cfg, t, files) ?? []),
		total,
		offset
	};
}

/** The folders a test can be imported into: those the systems record into (systems.json). */
export function importFolders(): string[] {
	return signInSystems().flatMap((s) => s.record.map((t) => t.folder));
}

// ---- Rendering --------------------------------------------------------------------------------

/** One line: Octane texts may hold line breaks, which would break a list item or a comment. */
const oneLine = (text: string) => text.replaceAll(/\s+/g, ' ').trim();

function planStep(step: PlanStep, n: number): string {
	const action = oneLine(step.action) || 'Check';
	const checks = step.expect.map((e) => ` - expect: ${oneLine(e)}`).join('');
	return `${n}. ${action}${checks}`;
}

export interface RenderInput {
	test: OctaneTest;
	parsed: ParsedScript;
	link: string;
	/** The test file, relative to the repository root (`sap-tests/tests/…`). */
	specFile: string;
	/** The plan, relative to the repository root (`sap-tests/specs/…`). */
	planFile: string;
	/** `sap-plugin` as the test file imports it, relative to the file's folder. */
	pluginImport: string;
	/** The seed the agents start from, and the project it belongs to. */
	seed: { file: string; project?: string };
	importedOn: string;
}

/** The scenarios with names that differ: Playwright refuses two tests of the same title in a file. */
function distinct(scenarios: PlanScenario[]): PlanScenario[] {
	const seen = new Map<string, number>();
	return scenarios.map((s) => {
		const name = oneLine(s.name) || 'test';
		const count = (seen.get(name) ?? 0) + 1;
		seen.set(name, count);
		return count === 1 ? { ...s, name } : { ...s, name: `${name} (${count})` };
	});
}

export function renderPlan(input: RenderInput): string {
	const { test, parsed, link } = input;
	const kind = testKind(test) === 'gherkin' ? 'Gherkin test' : 'manual test';
	const owner = test.owner?.full_name || test.owner?.name;
	const facts = [
		test.phase?.name && `phase ${test.phase.name}`,
		owner && `owner ${owner}`,
		names(test.product_areas).length > 0 && `product areas ${names(test.product_areas).join(', ')}`,
		names(test.user_tags).length > 0 && `tags ${names(test.user_tags).join(', ')}`
	].filter(Boolean);
	const description = htmlToText(test.description ?? '');
	const lines = [
		`# ${oneLine(test.name) || `Octane test ${test.id}`}`,
		'',
		'## Application Overview',
		'',
		`Imported from OpenText Octane on ${input.importedOn}: ${kind} [${test.id}](${link})${facts.length > 0 ? ` (${facts.join('; ')})` : ''}.`,
		''
	];
	if (description)
		lines.push(
			'**Description in Octane:**',
			'',
			...description.split('\n').map((l) => (l ? `> ${l}` : '>')),
			''
		);
	lines.push(
		'**Not explored yet.** The steps are the test case as it is written in Octane. They name no controls or locators: explore the running application (planner agent, or by hand) to add them, and check the plan before code is written from it. Edit the plan here, not in Octane: importing the test again replaces this file only when asked to.',
		''
	);
	if (parsed.calls.length > 0)
		lines.push(
			`**Calls other tests:** ${parsed.calls.map((c) => oneLine(c)).join(', ')}. Their steps are not part of this plan: import those tests as well, or write their steps in here.`,
			''
		);
	lines.push(
		'## Test Scenarios',
		'',
		`### 1. ${oneLine(test.name) || `Octane test ${test.id}`}`,
		'',
		`**Seed:** \`${input.seed.file}\`${input.seed.project ? ` (project \`${input.seed.project}\`)` : ''}`,
		''
	);
	const scenarios = distinct(parsed.scenarios);
	if (scenarios.length === 0) lines.push('The test has no steps in Octane.', '');
	scenarios.forEach((scenario, i) => {
		lines.push(
			`#### 1.${i + 1}. ${scenario.name}`,
			'',
			`**File:** \`${input.specFile}\``,
			'',
			'**Steps:**',
			''
		);
		if (scenario.steps.length === 0) lines.push('(none in Octane)');
		for (const [n, step] of scenario.steps.entries()) lines.push(planStep(step, n + 1));
		lines.push('');
		// As written in the feature file: a code block, which the formatter leaves alone.
		if (scenario.examples.length > 0)
			lines.push('**Examples:**', '', '```', ...scenario.examples, '```', '');
	});
	return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * A TypeScript string literal as the project's formatter (oxfmt) writes it: single quotes, or
 * double quotes when the text holds more single quotes than double ones.
 */
function tsString(text: string): string {
	const plain = text.replaceAll(/[\u2028\u2029]/g, ' ');
	const quote = plain.split("'").length > plain.split('"').length ? '"' : "'";
	const escaped = plain.replaceAll('\\', '\\\\').replaceAll(quote, `\\${quote}`);
	return `${quote}${escaped}${quote}`;
}

/** The formatter's line width (.oxfmtrc.json). */
const PRINT_WIDTH = 100;

/**
 * The test file, laid out as the project's formatter would lay it out, so that it passes
 * `bun run format:check` as it is written.
 */
export function renderSpec(input: RenderInput): string {
	const { test, parsed, link } = input;
	const lines = [
		`// Imported from OpenText Octane: test ${test.id}, ${link}`,
		`// Plan: ${input.planFile}.`,
		'// Each step is the test case as written in Octane, with its checks as comments. Fill the steps',
		'// in (or have the generator agent do it from the plan), then change test.fixme to test.',
		`import { test } from ${tsString(input.pluginImport)};`
	];
	for (const scenario of distinct(parsed.scenarios)) {
		const title = tsString(scenario.name);
		const tag = `{ tag: ${tsString(`@octane-${test.id}`)} }`;
		const head = `test.fixme(${title}, ${tag}, async () => {`;
		// A call too long for one line gets one argument per line, and its body one more tab.
		const wrapped = head.length > PRINT_WIDTH;
		const indent = wrapped ? '\t\t' : '\t';
		lines.push(
			'',
			...(wrapped ? ['test.fixme(', `\t${title},`, `\t${tag},`, '\tasync () => {'] : [head])
		);
		for (const [n, step] of scenario.steps.entries()) {
			const name = `${n + 1}. ${oneLine(step.action) || 'Check'}`;
			lines.push(`${indent}await test.step(${tsString(name)}, async () => {`);
			for (const check of step.expect) lines.push(`${indent}\t// expect: ${oneLine(check)}`);
			if (step.expect.length === 0) lines.push(`${indent}\t// to do`);
			lines.push(`${indent}});`);
		}
		lines.push(...(wrapped ? ['\t}', ');'] : ['});']));
	}
	return `${lines.join('\n')}\n`;
}

// ---- Importing --------------------------------------------------------------------------------

export interface ImportInput {
	ids: string[];
	/** A folder under tests/ that a system records into. */
	folder: string;
	/** Replace a plan imported before. A test file is never replaced: it may be filled in by now. */
	replacePlans: boolean;
}

function seedFor(specUnderTests: string): RenderInput['seed'] {
	const system = systemsOfFiles([specUnderTests]).get(specUnderTests);
	return system
		? { file: 'sap-tests/tests/_agents/seed-signed-in.spec.ts', project: system.id }
		: { file: 'sap-tests/tests/_agents/seed.spec.ts' };
}

function write(full: string, content: string) {
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, content);
}

/** Imports each test: reads it and its script from Octane, then writes its plan and test file. */
export async function importOctane(
	input: ImportInput,
	now: Date = new Date()
): Promise<OctaneImportResult[]> {
	if (!importFolders().includes(input.folder))
		throw new OctaneError(`No system in systems.json records into tests/${input.folder}.`);
	const cfg = await config();
	const fetched = await withOctane(cfg, async (session: OctaneSession) => {
		const tests = await session.byIds(input.ids);
		const missing = input.ids.filter((id) => !tests.some((t) => t.id === id));
		if (missing.length > 0)
			throw new OctaneError(`Octane has no test ${missing.join(', ')} in this workspace.`);
		const other = tests.filter((t) => !testKind(t));
		if (other.length > 0)
			throw new OctaneError(
				`Only manual and Gherkin tests have steps to import, not ${other.map((t) => `${t.id} (${t.subtype ?? 'unknown'})`).join(', ')}.`
			);
		// One after the other: a few dozen small requests, and Octane is a shared server.
		const scripts: string[] = [];
		for (const test of tests) {
			// oxlint-disable-next-line no-await-in-loop
			scripts.push(await session.script(test.id));
		}
		return tests.map((test, i) => ({ test, script: scripts[i] ?? '' }));
	});
	const files = importedFiles();
	const importedOn = now.toISOString().slice(0, 10);
	return fetched.map(({ test, script }) => {
		const notes: string[] = [];
		const parsed =
			testKind(test) === 'gherkin'
				? parseGherkinScript(test.name, script)
				: parseManualScript(test.name, script);
		if (parsed.calls.length > 0)
			notes.push(`Calls ${parsed.calls.join(', ')}: those steps are not imported.`);
		if (parsed.scenarios.every((s) => s.steps.length === 0))
			notes.push('The test has no steps in Octane.');

		const existing = files.get(test.id);
		const name = `${prefix(test.id)}${slug(test.name)}`;
		const planRel = existing?.plan ?? `specs/${name}.plan.md`;
		const specRel = existing?.spec ?? `tests/${input.folder}/${name}.spec.ts`;
		const planFull = within(TESTS_ROOT, planRel);
		const specFull = within(TESTS_ROOT, specRel);
		if (!planFull || !specFull) throw new OctaneError('Invalid file name.');
		const render: RenderInput = {
			test,
			parsed,
			link: octaneLink(cfg, test.id),
			specFile: `sap-tests/${specRel}`,
			planFile: `sap-tests/${planRel}`,
			pluginImport: toPosix(relative(dirname(specFull), resolve(TESTS_ROOT, 'sap-plugin'))),
			seed: seedFor(specRel.slice('tests/'.length)),
			importedOn
		};

		let plan: ImportedFile = 'kept';
		if (!existsSync(planFull) || input.replacePlans) {
			plan = existsSync(planFull) ? 'replaced' : 'written';
			write(planFull, renderPlan(render));
		}
		let spec: ImportedFile = 'kept';
		if (!existsSync(specFull)) {
			spec = 'written';
			write(specFull, renderSpec(render));
		} else if (existing?.spec && existing.spec !== `tests/${input.folder}/${name}.spec.ts`) {
			notes.push(`Its test file was imported before: ${existing.spec}.`);
		}
		return {
			id: test.id,
			name: test.name,
			plan: { file: planRel, outcome: plan },
			spec: { file: specRel, outcome: spec },
			notes
		};
	});
}
