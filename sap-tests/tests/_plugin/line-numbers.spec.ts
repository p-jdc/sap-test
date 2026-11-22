// KI-generiert, geprüft von: <Name>
// The specs load as ES modules. Playwright once reported transpiled line numbers for them (with the
// Playwright-SAP fork on Node 26), so `file:line` runs found no tests and the app's flow view put
// the run's steps on the wrong lines. This runs the offline demo spec and checks that the lines
// Playwright gives the test and its steps are the lines in the source.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '../../sap-plugin';

const root = join(import.meta.dirname, '..', '..');
const SPEC = 'tests/_demo/order-form.spec.ts';

/**
 * The numbers of the source lines that start a step (an awaited page action or assertion) before
 * line `to`: the beforeEach hook's and the test's.
 */
function stepLines(source: string, to: number): number[] {
	return source
		.split('\n')
		.map((text, index) => ({ text, line: index + 1 }))
		.filter(({ text, line }) => line < to && /^\s*await (page|expect)\b/.test(text))
		.map(({ line }) => line);
}

test('test and step line numbers are the lines in the source', () => {
	const source = readFileSync(join(root, SPEC), 'utf8');
	const lines = source.split('\n');
	const first = lines.findIndex((text) => text.startsWith('test(')) + 1;
	const next = lines.findIndex((text, index) => index >= first && text.startsWith('test(')) + 1;

	const output = execFileSync(
		process.execPath,
		[
			join(root, '..', 'node_modules', '@playwright', 'test', 'cli.js'),
			'test',
			`${SPEC}:${first}`,
			'--reporter',
			join(import.meta.dirname, 'fixtures', 'step-lines-reporter.mjs'),
			// Its own output folder: the default one belongs to the run this test is part of.
			'--output',
			mkdtempSync(join(tmpdir(), 'line-numbers-'))
		],
		{ cwd: root, encoding: 'utf8' }
	);

	const reported = output.split('\n');
	expect(reported).toContain(`test ${first}`);
	const steps = reported
		.filter((text) => text.startsWith('step '))
		.map((text) => Number(text.split(' ')[1]));
	expect(steps).toEqual(stepLines(source, next));
});
