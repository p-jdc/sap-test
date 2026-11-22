// KI-generiert, geprüft von: <Name>
// The lint rules for SAP tests (tools/oxlint/sap-rules and the import rule) flag what they should
// and nothing else, and the project's own configuration has them switched on. The fixture files
// say per line which finding they expect; they are linted with fixtures/lint.json.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../../sap-plugin';

const root = join(import.meta.dirname, '..', '..');
const fixtures = join('tools', 'oxlint', 'sap-rules', 'fixtures');

interface Diagnostic {
	code: string;
	filename: string;
	labels: { span: { line: number } }[];
}

/** What oxlint prints. It exits with 1 when it reports errors, which is the point here. */
function oxlint(args: string[]): string {
	try {
		return execFileSync(join(root, '..', 'node_modules', '.bin', 'oxlint'), args, {
			cwd: root,
			encoding: 'utf8'
		});
	} catch (error) {
		const stdout: unknown = error instanceof Error && 'stdout' in error ? error.stdout : '';
		return typeof stdout === 'string' ? stdout : '';
	}
}

/** `file:line code`, one entry per finding. */
function found(): string[] {
	const output = oxlint(['-c', join(fixtures, 'lint.json'), '--format', 'json', fixtures]);
	const report: { diagnostics: Diagnostic[] } = JSON.parse(output.slice(output.indexOf('{')));
	return report.diagnostics.map(
		(d) => `${d.filename.split('/').at(-1)}:${d.labels[0]?.span.line} ${d.code}`
	);
}

/** The same list, read from the `// expect: <code> …` comments of the fixture files. */
function expected(): string[] {
	return readdirSync(join(root, fixtures))
		.filter((name) => name.endsWith('.ts'))
		.flatMap((name) =>
			readFileSync(join(root, fixtures, name), 'utf8')
				.split('\n')
				.flatMap((text, index) => {
					const codes = /\/\/ expect: (.+)$/.exec(text)?.[1]?.split(' ') ?? [];
					return codes.map((code) => `${name}:${index + 1} ${code}`);
				})
		);
}

test('the SAP lint rules flag the marked fixture lines and no others', () => {
	const wanted = expected();
	// Guards the comparison itself: an unreadable fixture folder would compare two empty lists.
	expect(wanted.length).toBeGreaterThan(5);
	const actual = found();
	expect(actual).toEqual(expect.arrayContaining(wanted));
	expect(wanted).toEqual(expect.arrayContaining(actual));
	expect(actual).toHaveLength(wanted.length);
});

interface Config {
	rules: Record<string, unknown>;
	overrides?: { files: string[]; rules?: Record<string, unknown> }[];
}

test('the project configuration applies the rules to the tests', () => {
	// What oxlint resolves for a real test file, so a rule dropped from .oxlintrc.json shows here.
	const output = oxlint(['--print-config', 'tests/fiori/create-order.spec.ts']);
	const real: Config = JSON.parse(output.slice(output.indexOf('{')));
	const tried: Config = JSON.parse(readFileSync(join(root, fixtures, 'lint.json'), 'utf8'));

	expect(real.rules['sap/no-secret-fill']).toBe('deny');
	expect(real.rules['sap/no-literal-secret']).toBe('deny');

	// The import rule is configuration only: the fixtures must have tried the options in use.
	const imports = real.overrides
		?.filter((o) => o.files.includes('tests/**'))
		.map((o) => o.rules?.['no-restricted-imports'])
		.find((rule) => rule !== undefined);
	expect(imports).toEqual(['deny', expect.anything()]);
	expect(imports).toEqual([
		expect.anything(),
		...[tried.rules['no-restricted-imports']].flat().slice(1)
	]);
});
