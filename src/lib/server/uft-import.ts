import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { playwrightNode } from './node-cli.js';
import { APP_ROOT, TESTS_DIR, TESTS_ROOT, toPosix, within } from './paths.js';
import { PILOT_STREAK, stability } from './runs-store.js';
import { signInSystems, systemsOfFiles } from './systems.js';
import { OPEN_MARKER } from './uft-translate.js';
import {
	findTests,
	indexSource,
	renderPlan,
	renderSpec,
	REVIEW_MARKER,
	translateTest,
	type RenderInput,
	type Translation,
	type UftTest
} from './uft-tests.js';
import { UftSourceError } from './uft-source.js';
import type {
	ImportedFile,
	UftFile,
	UftImportResult,
	UftMigration,
	UftScanResult,
	UftSourceKind,
	UftTarget,
	UftTestSummary
} from '#lib/shared/uft.js';

/**
 * Imports UFT tests into the test project: per test a test file with the translated statements
 * (sap-tests/tests/<folder>/uft-<name>.spec.ts) and a plan in the planner's format
 * (sap-tests/specs/uft-<name>.plan.md) that lists every statement and what became of it. And how
 * far each imported test has come: statements still open, reviewed, passing in a row.
 */

const SPECS_DIR = () => resolve(TESTS_ROOT, 'specs');

export function slug(name: string): string {
	return (
		name
			.replaceAll('ß', 'ss')
			.normalize('NFKD')
			.replaceAll(/[̀-ͯ]/g, '')
			.toLowerCase()
			.replaceAll(/[^a-z0-9]+/g, '-')
			.replaceAll(/^-|-$/g, '')
			.slice(0, 60)
			.replace(/-$/, '') || 'test'
	);
}

/**
 * The file name of each test: `uft-<test folder>`. Where tests of the source share a name, as many
 * of the folders above each as make them differ (`uft-sales-regression-create`). The same UFT test
 * read again, uploaded or from Git, gets the same name, and so finds its earlier import.
 */
function fileNames(tests: UftTest[]): Map<string, string> {
	const names = new Map<string, string>();
	const groups = new Map<string, UftTest[]>();
	for (const t of tests) groups.set(slug(t.name), [...(groups.get(slug(t.name)) ?? []), t]);
	for (const [base, group] of groups) {
		if (group.length === 1) {
			names.set(group[0]?.path ?? '', `uft-${base}`);
			continue;
		}
		const parts = group.map((t) =>
			t.path
				.split('/')
				.slice(0, -1)
				.map((p) => slug(p))
		);
		const longest = Math.max(...parts.map((p) => p.length));
		let depth = 1;
		const named = (i: number) => [...(parts[i] ?? []).slice(-depth), base].join('-');
		while (depth < longest && new Set(group.map((_, i) => named(i))).size < group.length) depth++;
		const taken = new Set<string>();
		group.forEach((t, i) => {
			let name = `uft-${named(i)}`;
			// Same folders all the way up (cannot happen in one source, but cheap to rule out).
			for (let n = 2; taken.has(name); n++) name = `uft-${named(i)}-${n}`;
			taken.add(name);
			names.set(t.path, name);
		});
	}
	return names;
}

/** The folders the import writes to: the WebGUI and the UI5 folder of the SAP system. */
export function importFolders(): { webgui?: string; fiori?: string } {
	const targets = signInSystems()
		.filter((s) => s.method === 'sapLogin')
		.flatMap((s) => s.record);
	const webgui = targets.find((t) => t.recorder === 'webgui')?.folder;
	const fiori = targets.find((t) => t.recorder === 'ui5')?.folder;
	return { ...(webgui ? { webgui } : {}), ...(fiori ? { fiori } : {}) };
}

function folderFor(
	target: UftTarget,
	folders: { webgui?: string; fiori?: string }
): string | undefined {
	return target === 'fiori' ? (folders.fiori ?? folders.webgui) : (folders.webgui ?? folders.fiori);
}

// ---- Imported tests ---------------------------------------------------------------------------

/** The imported test files by their name (`uft-…`), relative to tests/. */
function importedSpecs(): Map<string, string> {
	const found = new Map<string, string>();
	if (!existsSync(TESTS_DIR)) return found;
	for (const entry of readdirSync(TESTS_DIR, { recursive: true, encoding: 'utf8' })) {
		const file = toPosix(entry);
		const name = /(?:^|\/)(uft-[^/]+)\.spec\.ts$/.exec(file)?.[1];
		if (name && !found.has(name)) found.set(name, file);
	}
	return found;
}

/** How far the imported test in `spec` (relative to tests/) has come. */
const OPEN_LINE = new RegExp(`^\\s*// ${OPEN_MARKER}[ :(]`, 'gm');

function migration(
	spec: string,
	streaks: Map<string, { lastStatus?: string; streak: number }>
): UftMigration {
	const full = within(TESTS_DIR, spec);
	const source = full && existsSync(full) ? readFileSync(full, 'utf8') : '';
	const reviewer = new RegExp(`${REVIEW_MARKER}[ \\t]*(.*)`).exec(source)?.[1]?.trim() ?? '';
	const run = streaks.get(spec);
	const out: UftMigration = {
		spec: `tests/${spec}`,
		// The marker lines the translation wrote, not the word anywhere else in the file.
		open: source.match(OPEN_LINE)?.length ?? 0,
		fixme: /\btest\.fixme\(/.test(source),
		reviewer: /<name>/i.test(reviewer) ? '' : reviewer,
		streak: run?.streak ?? 0,
		target: PILOT_STREAK
	};
	if (run?.lastStatus) out.lastStatus = run.lastStatus;
	return out;
}

/** The newest result and the streak of passes of each spec file's test (the lowest, for several). */
function streaksByFile(): Map<string, { lastStatus?: string; streak: number }> {
	const out = new Map<string, { lastStatus?: string; streak: number }>();
	let rows: ReturnType<typeof stability>;
	try {
		rows = stability();
	} catch {
		return out;
	}
	for (const row of rows) {
		const file = row.file.replace(/^(?:sap-tests\/)?tests\//, '');
		const before = out.get(file);
		if (!before || row.streak < before.streak) {
			const entry: { lastStatus?: string; streak: number } = { streak: row.streak };
			if (row.lastStatus) entry.lastStatus = row.lastStatus;
			out.set(file, entry);
		}
	}
	return out;
}

// ---- Scan -------------------------------------------------------------------------------------

interface Planned {
	translation: Translation;
	name: string;
	plan: string;
	spec: string;
	existing?: string;
}

/** What the import makes of each test of the source, or of those in `only`. */
function plan(files: UftFile[], only?: Set<string>): { planned: Planned[]; tests: UftTest[] } {
	const tests = findTests(files);
	const names = fileNames(tests);
	const folders = importFolders();
	const existing = importedSpecs();
	const index = indexSource(files);
	const chosen = only ? tests.filter((t) => only.has(t.path)) : tests;
	const planned = chosen.map((test): Planned => {
		const translation = translateTest(test, tests, index);
		const name = names.get(test.path) ?? `uft-${slug(test.name)}`;
		const before = existing.get(name);
		const folder = folderFor(translation.target, folders) ?? 'webgui';
		const out: Planned = {
			translation,
			name,
			plan: `specs/${name}.plan.md`,
			spec: before ? `tests/${before}` : `tests/${folder}/${name}.spec.ts`
		};
		if (before) out.existing = before;
		return out;
	});
	return { planned, tests };
}

/** The tests of a source, with what the import would make of each and how far each has come. */
export function scan(files: UftFile[], source: UftSourceKind, origin?: string): UftScanResult {
	const { planned } = plan(files);
	const streaks = streaksByFile();
	const notes: string[] = [];
	if (files.some((f) => /\.mts$/i.test(f.path)) && planned.length === 0)
		notes.push(
			'No UFT test found: a test is a folder with Action0, Action1, … folders, each with a Script.mts.'
		);
	const repositories = [...new Set(planned.flatMap((p) => p.translation.repositories))];
	if (planned.length > 0 && repositories.length === 0)
		notes.push(
			'No object repository in XML found. UFT keeps them in binary files (ObjectRepository.bdb, *.tsr) that the import cannot read: export them in UFT (Object Repository Manager › File › Export to XML) next to the tests, then the import knows the technical names of the fields.'
		);
	const tests = planned.map((p): UftTestSummary => {
		const t = p.translation;
		const summary: UftTestSummary = {
			path: t.test.path,
			name: t.test.name,
			target: t.target,
			actions: t.test.actions.map((a) => a.name),
			statements: t.statements,
			translated: t.translated,
			plan: p.plan,
			spec: p.spec
		};
		if (p.existing) summary.imported = migration(p.existing, streaks);
		return summary;
	});
	return { source, ...(origin ? { origin } : {}), tests, repositories, notes };
}

// ---- Import -----------------------------------------------------------------------------------

function seedFor(specUnderTests: string): RenderInput['seed'] {
	const system = systemsOfFiles([specUnderTests]).get(specUnderTests);
	return system
		? { file: 'sap-tests/tests/_agents/seed-signed-in.spec.ts', project: system.id }
		: { file: 'sap-tests/tests/_agents/seed.spec.ts' };
}

async function write(full: string, content: string) {
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, await formatted(content, full));
}

/**
 * The file laid out by the project's formatter (oxfmt, with the repository's .oxfmtrc.json), so
 * that it passes `bun run format:check` as it is written. Where the formatter is not installed (an
 * app built without its development packages) or fails, the file stays as rendered: it runs the
 * same. A child process of its own, waited for without holding up the server.
 */
function formatted(content: string, file: string): Promise<string> {
	const bin = resolve(APP_ROOT, 'node_modules/oxfmt/bin/oxfmt');
	const config = resolve(APP_ROOT, '.oxfmtrc.json');
	if (!existsSync(bin) || !existsSync(config)) return Promise.resolve(content);
	return new Promise((done) => {
		const child = execFile(
			playwrightNode().path,
			[bin, `--stdin-filepath=${file}`, '-c', config],
			{ encoding: 'utf8', timeout: 30_000, maxBuffer: 20_000_000 },
			(error, stdout) => {
				done(error || !stdout ? content : stdout);
			}
		);
		child.stdin?.end(content);
	});
}

export interface ImportInput {
	/** The tests' folders in the source (UftTestSummary.path). */
	paths: string[];
	/** Replace a plan imported before. A test file is never replaced: it may be worked on by now. */
	replacePlans: boolean;
	/** Folders under tests/ instead of the system's WebGUI and UI5 folders. */
	folders?: { webgui?: string; fiori?: string };
}

export async function importTests(
	files: UftFile[],
	input: ImportInput,
	origin: string,
	now: Date = new Date()
): Promise<UftImportResult[]> {
	const { planned } = plan(files, new Set(input.paths));
	const allowed = new Set(
		signInSystems()
			.filter((s) => s.method === 'sapLogin')
			.flatMap((s) => s.record.map((t) => t.folder))
	);
	const folders = { ...importFolders(), ...input.folders };
	for (const folder of Object.values(input.folders ?? {}))
		if (folder && !allowed.has(folder))
			throw new UftSourceError(`No SAP system in systems.json records into tests/${folder}.`);
	const chosen = input.paths.map((path) => {
		const p = planned.find((x) => x.translation.test.path === path);
		if (!p) throw new UftSourceError(`The source has no UFT test ${path || '(its root folder)'}.`);
		return p;
	});
	const importedOn = now.toISOString().slice(0, 10);
	const results: UftImportResult[] = [];
	for (const p of chosen) {
		const t = p.translation;
		const folder = folderFor(t.target, folders) ?? 'webgui';
		const specRel = p.existing ? `tests/${p.existing}` : `tests/${folder}/${p.name}.spec.ts`;
		const planFull = within(SPECS_DIR(), `${p.name}.plan.md`);
		const specFull = within(TESTS_ROOT, specRel);
		if (!planFull || !specFull) throw new UftSourceError('Invalid file name.');
		const render: RenderInput = {
			translation: t,
			title: t.test.name,
			tag: `@${p.name}`,
			origin,
			specFile: `sap-tests/${specRel}`,
			planFile: `sap-tests/${p.plan}`,
			pluginImport: toPosix(relative(dirname(specFull), resolve(TESTS_ROOT, 'sap-plugin'))),
			helpersImport: toPosix(relative(dirname(specFull), resolve(TESTS_ROOT, 'helpers'))),
			seed: seedFor(specRel.slice('tests/'.length)),
			importedOn
		};
		const notes = [...t.notes];
		let planOutcome: ImportedFile = 'kept';
		if (!existsSync(planFull) || input.replacePlans) {
			planOutcome = existsSync(planFull) ? 'replaced' : 'written';
			// oxlint-disable-next-line no-await-in-loop -- one formatter at a time, not hundreds at once
			await write(planFull, renderPlan(render));
		}
		let specOutcome: ImportedFile = 'kept';
		if (existsSync(specFull)) {
			notes.push(`The test file was imported before and is kept as it is: ${specRel}.`);
		} else {
			specOutcome = 'written';
			// oxlint-disable-next-line no-await-in-loop -- as above
			await write(specFull, renderSpec(render));
		}
		results.push({
			path: t.test.path,
			name: t.test.name,
			plan: { file: p.plan, outcome: planOutcome },
			spec: { file: specRel, outcome: specOutcome },
			translated: t.translated,
			statements: t.statements,
			notes
		});
	}
	return results;
}
