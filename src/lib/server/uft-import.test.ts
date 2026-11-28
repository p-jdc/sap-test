import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { copySystems } from '../../test/systems.js';
import { uftSource } from '../../test/uft/fixtures.js';

// The run history: a stand-in, so that a test can say how often an imported test has passed.
const history = vi.hoisted(
	(): { rows: { file: string; streak: number; lastStatus?: string }[] } => ({
		rows: []
	})
);
vi.mock('./runs-store.js', () => ({
	PILOT_STREAK: 10,
	stability: () => history.rows.map((r) => ({ key: `${r.file}::x`, title: 'x', history: [], ...r }))
}));

let root = '';

function importer() {
	vi.resetModules();
	return import('./uft-import.js');
}

beforeEach(() => {
	vi.unstubAllEnvs();
	root = mkdtempSync(join(tmpdir(), 'uft-'));
	copySystems(root);
	vi.stubEnv('SAP_TESTS_DIR', root);
	history.rows = [];
});

const read = (file: string) => readFileSync(join(root, file), 'utf8');

describe('scan', () => {
	test('lists each test with what it drives and how much translates', async () => {
		const { scan } = await importer();
		const result = scan(uftSource(), 'upload', 'uploaded');
		expect(result.tests).toEqual([
			{
				path: 'UFT/Sales/VA01_Create',
				name: 'VA01_Create',
				target: 'mixed',
				actions: ['Create order', 'Check in Fiori'],
				statements: 15,
				translated: 10,
				plan: 'specs/uft-va01-create.plan.md',
				spec: 'tests/webgui/uft-va01-create.spec.ts'
			}
		]);
		expect(result.repositories).toEqual(['UFT/Sales/VA01_Create/ObjectRepository.xml']);
		expect(result.notes).toEqual([]);
	});

	test('says so when no repository could be read', async () => {
		const { scan } = await importer();
		const result = scan(
			uftSource().filter((f) => !f.path.endsWith('.xml')),
			'upload'
		);
		expect(result.notes.join(' ')).toContain('Export to XML');
	});
});

describe('importTests', () => {
	test('writes the test file and plan, formatted, and keeps the test file on the next import', async () => {
		const { importTests, scan } = await importer();
		const results = await importTests(
			uftSource(),
			{ paths: ['UFT/Sales/VA01_Create'], replacePlans: false },
			'uploaded',
			new Date('2026-11-27T10:00:00Z')
		);
		expect(results).toMatchObject([
			{
				name: 'VA01_Create',
				plan: { file: 'specs/uft-va01-create.plan.md', outcome: 'written' },
				spec: { file: 'tests/webgui/uft-va01-create.spec.ts', outcome: 'written' },
				translated: 10,
				statements: 15
			}
		]);
		const spec = read('tests/webgui/uft-va01-create.spec.ts');
		expect(spec.split('\n').slice(0, 2)).toEqual([
			'// Aus UFT übersetzt, geprüft von:',
			'// Translated from the UFT test UFT/Sales/VA01_Create (uploaded) on 2026-11-27: 10 of 15 statements.'
		]);
		// oxfmt laid it out: the long locator call is wrapped, trailing commas are gone.
		expect(spec).toContain("const DATA = {\n\tOrderType: ''\n};");
		expect(spec).toContain(
			"test.fixme('VA01_Create', { tag: ['@uft', '@uft-va01-create'] }, async ({ page }) => {"
		);
		expect(read('specs/uft-va01-create.plan.md')).toContain('#### 1.1. VA01_Create');

		// Someone worked on the test: importing again keeps it, and the scan shows how far it is.
		writeFileSync(
			join(root, 'tests/webgui/uft-va01-create.spec.ts'),
			"// Aus UFT übersetzt, geprüft von: A. Tester\ntest('VA01_Create', async () => {});\n"
		);
		history.rows = [{ file: 'webgui/uft-va01-create.spec.ts', streak: 10, lastStatus: 'passed' }];
		const again = await importTests(
			uftSource(),
			{ paths: ['UFT/Sales/VA01_Create'], replacePlans: true },
			'uploaded'
		);
		expect(again[0]).toMatchObject({ plan: { outcome: 'replaced' }, spec: { outcome: 'kept' } });
		expect(read('tests/webgui/uft-va01-create.spec.ts')).toContain('A. Tester');
		expect(scan(uftSource(), 'upload').tests[0]?.imported).toEqual({
			spec: 'tests/webgui/uft-va01-create.spec.ts',
			open: 0,
			fixme: false,
			reviewer: 'A. Tester',
			lastStatus: 'passed',
			streak: 10,
			target: 10
		});
	});

	test('a SAP GUI test goes to the WebGUI folder, a Fiori test to the Fiori folder', async () => {
		const { importTests } = await importer();
		// The Fiori action as a test of its own, without a flow.
		const files = uftSource().map((f) =>
			Object.assign({}, f, { path: f.path.replace('VA01_Create/Action2', 'Fiori_Check/Action2') })
		);
		const results = await importTests(
			files,
			{ paths: ['UFT/Sales/Fiori_Check'], replacePlans: false },
			'uploaded'
		);
		expect(results[0]?.spec.file).toBe('tests/fiori/uft-fiori-check.spec.ts');
	});

	test('refuses a folder no SAP system records into, and a test that is not in the source', async () => {
		const { importTests } = await importer();
		await expect(
			importTests(
				uftSource(),
				{ paths: ['UFT/Sales/VA01_Create'], replacePlans: false, folders: { webgui: 'ariba' } },
				'x'
			)
		).rejects.toThrow('No SAP system in systems.json records into tests/ariba');
		await expect(
			importTests(uftSource(), { paths: ['nope'], replacePlans: false }, 'x')
		).rejects.toThrow('The source has no UFT test nope');
	});

	test('a test with nothing left to do counts no open step, header and all', async () => {
		const { importTests, scan } = await importer();
		const files = [{ path: 'Done/Action1/Script.mts', text: 'Wait 1' }];
		await importTests(files, { paths: ['Done'], replacePlans: false }, 'uploaded');
		expect(read('tests/webgui/uft-done.spec.ts')).toContain("test('Done',");
		expect(scan(files, 'upload').tests[0]?.imported).toMatchObject({ open: 0, fixme: false });
	});

	test('tests of the same name get as many folders above them as make them differ', async () => {
		const { scan } = await importer();
		const files = ['Sales/Regression/Create', 'Purchasing/Regression/Create', 'Login'].map(
			(path) => ({ path: `${path}/Action1/Script.mts`, text: 'Wait 1' })
		);
		expect(scan(files, 'upload').tests.map((t) => t.spec)).toEqual([
			'tests/webgui/uft-login.spec.ts',
			'tests/webgui/uft-purchasing-regression-create.spec.ts',
			'tests/webgui/uft-sales-regression-create.spec.ts'
		]);
	});
});
