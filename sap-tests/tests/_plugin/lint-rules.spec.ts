// KI-generiert, geprüft von: <Name>
// The lint rules for SAP tests (tools/oxlint/sap-rules and the import rule in .oxlintrc.json) flag
// what they should and nothing else. The fixture files say per line which finding they expect.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '../../sap-plugin';

const root = join(__dirname, '..', '..');
const fixtures = join('tools', 'oxlint', 'sap-rules', 'fixtures');

interface Diagnostic {
	code: string;
	filename: string;
	labels: { span: { line: number } }[];
}

/** `file:line code`, one entry per finding. */
function found(): string[] {
	let output: string;
	try {
		output = execFileSync(
			join(root, 'node_modules', '.bin', 'oxlint'),
			['-c', join(fixtures, 'lint.json'), '--format', 'json', fixtures],
			{ cwd: root, encoding: 'utf8' }
		);
	} catch (error) {
		// oxlint exits with 1 when it reports errors, which is the point here.
		const stdout: unknown = error instanceof Error && 'stdout' in error ? error.stdout : '';
		output = typeof stdout === 'string' ? stdout : '';
	}
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
