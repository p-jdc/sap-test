import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { must } from '../../test/must.js';

let root = '';
let clock = 0;

/** Writes a file into the temporary test project. Each write gets a later modification time. */
function write(file: string, source: string) {
	const full = join(root, file);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, source);
	clock += 10;
	const time = new Date(Date.UTC(2026, 0, 1, 0, 0, clock));
	utimesSync(full, time, time);
}

const spec = (title: string, body: string) =>
	`import { test } from '../../sap-plugin';\n// KI-generiert, geprüft von: A. Tester\ntest('${title}', async ({ page }) => {\n${body}\n});\n`;

/** A fresh copy of the module on a fresh test project, with a count of the helper parses. */
async function freshSpecs() {
	root = mkdtempSync(join(tmpdir(), 'specs-'));
	vi.stubEnv('SAP_TESTS_DIR', root);
	vi.resetModules();
	const parser = await import('./spec-parser.js');
	const parseHelpers = vi.spyOn(parser, 'parseHelpers');
	const parseSpec = vi.spyOn(parser, 'parseSpec');
	return { ...(await import('./specs.js')), parseHelpers, parseSpec };
}

beforeEach(() => {
	clock = 0;
	vi.unstubAllEnvs();
});

describe('listSpecs', () => {
	test('is empty without a tests folder', async () => {
		const { listSpecs } = await freshSpecs();
		expect(listSpecs()).toEqual([]);
	});

	test('finds spec and test files in every folder, sorted, and nothing else', async () => {
		const { listSpecs } = await freshSpecs();
		write('tests/webgui/b.spec.ts', spec('b', ''));
		write('tests/fiori/deep/a.test.ts', spec('a', ''));
		write('tests/fiori/fixture.ts', 'export const x = 1;');
		write('tests/node_modules/pkg/c.spec.ts', spec('c', ''));
		write('tests/.hidden/d.spec.ts', spec('d', ''));

		const specs = listSpecs();
		expect(specs.map((s) => s.file)).toEqual(['fiori/deep/a.test.ts', 'webgui/b.spec.ts']);
		expect(specs.map((s) => s.surface)).toEqual(['fiori', 'webgui']);
		expect(must(specs[0]).tests.map((t) => t.title)).toEqual(['a']);
	});

	test('parses a file again only after it changed', async () => {
		const { listSpecs, parseSpec } = await freshSpecs();
		write('tests/fiori/a.spec.ts', spec('first', ''));
		write('tests/fiori/b.spec.ts', spec('other', ''));
		listSpecs();
		listSpecs();
		expect(parseSpec).toHaveBeenCalledTimes(2);

		write('tests/fiori/a.spec.ts', spec('second', ''));
		expect(must(listSpecs()[0]).tests.map((t) => t.title)).toEqual(['second']);
		expect(parseSpec).toHaveBeenCalledTimes(3);
	});

	test('forgets a deleted file', async () => {
		const { listSpecs } = await freshSpecs();
		write('tests/fiori/a.spec.ts', spec('a', ''));
		expect(listSpecs()).toHaveLength(1);
		rmSync(join(root, 'tests/fiori/a.spec.ts'));
		expect(listSpecs()).toEqual([]);
	});

	test('parses the helpers once, and specs again when a helper changed', async () => {
		const { listSpecs, parseHelpers, parseSpec } = await freshSpecs();
		write('helpers/order.ts', 'export async function openOrder(page) { await page.goto("/"); }');
		write('tests/fiori/a.spec.ts', spec('a', '\tawait openOrder(page);'));
		listSpecs();
		listSpecs();
		expect(parseHelpers).toHaveBeenCalledTimes(1);
		expect(parseSpec).toHaveBeenCalledTimes(1);

		write('helpers/order.ts', 'export async function openOrder(page) { await page.reload(); }');
		listSpecs();
		expect(parseHelpers).toHaveBeenCalledTimes(2);
		expect(parseSpec).toHaveBeenCalledTimes(2);

		write('helpers/more.ts', 'export const x = 1;');
		listSpecs();
		expect(parseHelpers).toHaveBeenCalledTimes(3);
	});

	test('reports a file that cannot be parsed instead of failing the list', async () => {
		const { listSpecs, parseSpec } = await freshSpecs();
		parseSpec.mockImplementationOnce(() => {
			throw new Error('broken');
		});
		write('tests/fiori/a.spec.ts', spec('a', ''));
		expect(listSpecs()).toEqual([
			{
				file: 'fiori/a.spec.ts',
				surface: 'other',
				tests: [],
				issues: [],
				parseError: 'Error: broken'
			}
		]);
	});
});

describe('readSpecSource', () => {
	test('returns the source of a spec and null for a missing file or one outside the tests', async () => {
		const { readSpecSource } = await freshSpecs();
		write('tests/fiori/a.spec.ts', 'content');
		write('secret.txt', 'secret');
		expect(readSpecSource('fiori/a.spec.ts')).toBe('content');
		expect(readSpecSource('fiori/missing.spec.ts')).toBeNull();
		expect(readSpecSource('../secret.txt')).toBeNull();
	});
});
