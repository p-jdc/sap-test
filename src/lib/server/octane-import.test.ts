import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { FAKE_KEY, fakeOctane, type FakeOctane } from '../../test/fake-octane.js';
import { must } from '../../test/must.js';
import { copySystems } from '../../test/systems.js';

// The importer's settings: a stand-in for what the app reads from its settings. Vitest hoists both.
const settings = vi.hoisted((): { values: Record<string, string> } => ({ values: {} }));
vi.mock('./env-file.js', () => ({ readTestEnv: () => Promise.resolve(settings.values) }));

const SETTINGS = {
	OCTANE_URL: 'https://octane.example.com',
	OCTANE_SHARED_SPACE: '1001',
	OCTANE_WORKSPACE: '1002',
	OCTANE_CLIENT_ID: FAKE_KEY.clientId,
	OCTANE_CLIENT_SECRET: FAKE_KEY.clientSecret
};

const MANUAL = {
	id: '1501',
	name: 'Create sales order (VA01)',
	subtype: 'test_manual',
	phase: 'Ready',
	description: '<p>Standard order for <b>domestic</b> customers</p><h1>not a heading</h1>',
	script:
		"- Start VA01\n- ?The initial screen shows\n- Enter order type 'OR'\n- @1600 Log in\n- Save"
};
const GHERKIN = {
	id: '1502',
	name: 'Blocked customer',
	subtype: 'gherkin_test',
	script:
		'Feature: x\nScenario: Order\nWhen I order\nThen I see an error\nScenario: Order\nWhen again\n'
};

let root = '';
let octane: FakeOctane;

function importer() {
	vi.resetModules();
	return import('./octane-import.js');
}

beforeEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	root = mkdtempSync(join(tmpdir(), 'octane-'));
	copySystems(root);
	vi.stubEnv('SAP_TESTS_DIR', root);
	settings.values = { ...SETTINGS };
	octane = fakeOctane([
		MANUAL,
		GHERKIN,
		{ id: '1503', name: 'Automated', subtype: 'test_automated' }
	]);
	vi.stubGlobal('fetch', octane.fetch);
});

const read = (file: string) => readFileSync(join(root, file), 'utf8');

describe('importOctane', () => {
	test('writes a plan in the planner format and a test file with a step per step', async () => {
		const { importOctane } = await importer();
		const results = await importOctane(
			{ ids: ['1501'], folder: 'webgui', replacePlans: false },
			new Date('2026-11-27T10:00:00Z')
		);
		expect(results).toEqual([
			{
				id: '1501',
				name: 'Create sales order (VA01)',
				plan: { file: 'specs/octane-1501-create-sales-order-va01.plan.md', outcome: 'written' },
				spec: {
					file: 'tests/webgui/octane-1501-create-sales-order-va01.spec.ts',
					outcome: 'written'
				},
				notes: ['Calls 1600 Log in: those steps are not imported.']
			}
		]);
		expect(read('specs/octane-1501-create-sales-order-va01.plan.md'))
			.toBe(`# Create sales order (VA01)

## Application Overview

Imported from OpenText Octane on 2026-11-27: manual test [1501](https://octane.example.com/ui/entity-navigation?p=1001/1002&entityType=test&id=1501) (phase Ready; owner Alex Example; product areas Sales).

**Description in Octane:**

> Standard order for domestic customers
> not a heading

**Not explored yet.** The steps are the test case as it is written in Octane. They name no controls or locators: explore the running application (planner agent, or by hand) to add them, and check the plan before code is written from it. Edit the plan here, not in Octane: importing the test again replaces this file only when asked to.

**Calls other tests:** 1600 Log in. Their steps are not part of this plan: import those tests as well, or write their steps in here.

## Test Scenarios

### 1. Create sales order (VA01)

**Seed:** \`sap-tests/tests/_agents/seed-signed-in.spec.ts\` (project \`sap\`)

#### 1.1. Create sales order (VA01)

**File:** \`sap-tests/tests/webgui/octane-1501-create-sales-order-va01.spec.ts\`

**Steps:**

1. Start VA01 - expect: The initial screen shows
2. Enter order type 'OR'
3. Run the steps of the called Octane test 1600 Log in
4. Save
`);
		expect(read('tests/webgui/octane-1501-create-sales-order-va01.spec.ts'))
			.toBe(`// Imported from OpenText Octane: test 1501, https://octane.example.com/ui/entity-navigation?p=1001/1002&entityType=test&id=1501
// Plan: sap-tests/specs/octane-1501-create-sales-order-va01.plan.md.
// Each step is the test case as written in Octane, with its checks as comments. Fill the steps
// in (or have the generator agent do it from the plan), then change test.fixme to test.
import { test } from '../../sap-plugin';

test.fixme('Create sales order (VA01)', { tag: '@octane-1501' }, async () => {
	await test.step('1. Start VA01', async () => {
		// expect: The initial screen shows
	});
	await test.step("2. Enter order type 'OR'", async () => {
		// to do
	});
	await test.step('3. Run the steps of the called Octane test 1600 Log in', async () => {
		// to do
	});
	await test.step('4. Save', async () => {
		// to do
	});
});
`);
	});

	test('a Gherkin test becomes one test per scenario, with titles that differ', async () => {
		const { importOctane } = await importer();
		await importOctane({ ids: ['1502'], folder: 'ariba', replacePlans: false });
		const plan = read('specs/octane-1502-blocked-customer.plan.md');
		expect(plan).toContain('Gherkin test [1502]');
		// Ariba starts signed in to its own system.
		expect(plan).toContain('(project `ariba`)');
		expect(plan).toContain('#### 1.1. Order\n');
		expect(plan).toContain('#### 1.2. Order (2)\n');
		expect(plan).toContain('1. When I order - expect: Then I see an error');
		const spec = read('tests/ariba/octane-1502-blocked-customer.spec.ts');
		expect(spec).toContain("test.fixme('Order', ");
		expect(spec).toContain("test.fixme('Order (2)', ");
	});

	test('importing again keeps a filled-in test file, and replaces the plan only when asked', async () => {
		const { importOctane, searchOctane } = await importer();
		await importOctane({ ids: ['1501'], folder: 'webgui', replacePlans: false });
		const specFile = 'tests/webgui/octane-1501-create-sales-order-va01.spec.ts';
		const planFile = 'specs/octane-1501-create-sales-order-va01.plan.md';
		writeFileSync(join(root, specFile), '// filled in\n');
		writeFileSync(join(root, planFile), '# checked by a person\n');

		// Renamed in Octane: the files are still found by the id.
		MANUAL.name = 'Create standard order';
		const again = await importOctane({ ids: ['1501'], folder: 'fiori', replacePlans: false });
		expect(again[0]?.plan).toEqual({ file: planFile, outcome: 'kept' });
		expect(again[0]?.spec).toEqual({ file: specFile, outcome: 'kept' });
		expect(again[0]?.notes).toContain(`Its test file was imported before: ${specFile}.`);
		expect(read(planFile)).toBe('# checked by a person\n');

		const replaced = await importOctane({ ids: ['1501'], folder: 'webgui', replacePlans: true });
		expect(replaced[0]?.plan.outcome).toBe('replaced');
		expect(read(planFile)).toContain('# Create standard order');
		expect(read(specFile)).toBe('// filled in\n');

		const found = await searchOctane('create');
		expect(found.tests).toEqual([
			expect.objectContaining({ id: '1501', kind: 'manual', plan: planFile, spec: specFile })
		]);
		MANUAL.name = 'Create sales order (VA01)';
	});

	test('refuses a folder no system records into, tests of another kind and unknown ids', async () => {
		const { importOctane } = await importer();
		await expect(
			importOctane({ ids: ['1501'], folder: '../x', replacePlans: false })
		).rejects.toThrow('No system in systems.json records into tests/../x.');
		await expect(
			importOctane({ ids: ['1503'], folder: 'webgui', replacePlans: false })
		).rejects.toThrow(
			'Only manual and Gherkin tests have steps to import, not 1503 (test_automated).'
		);
		await expect(
			importOctane({ ids: ['1599'], folder: 'webgui', replacePlans: false })
		).rejects.toThrow('Octane has no test 1599 in this workspace.');
	});

	test('imports only the tests asked for, whatever else Octane answers', async () => {
		const { importOctane } = await importer();
		const asked = octane.fetch;
		// Octane (or a proxy) answers the id query with one more test.
		vi.stubGlobal('fetch', (input: string, init?: RequestInit) =>
			asked(input.replace('id%20IN%201501', 'id%20IN%201501%2C1502'), init)
		);
		const results = await importOctane({ ids: ['1501'], folder: 'webgui', replacePlans: false });
		expect(results.map((r) => r.id)).toEqual(['1501']);
	});

	test('names the settings missing before it calls Octane', async () => {
		settings.values = { OCTANE_URL: SETTINGS.OCTANE_URL };
		const { searchOctane } = await importer();
		await expect(searchOctane('')).rejects.toThrow(
			'Octane is not set up yet. Set OCTANE_SHARED_SPACE, OCTANE_WORKSPACE, OCTANE_CLIENT_ID, OCTANE_CLIENT_SECRET on the Settings page.'
		);
		expect(octane.requests).toEqual([]);
	});
});

describe('the files', () => {
	test('need no change by the formatter (bun run format:check)', async () => {
		const { importOctane } = await importer();
		const long = {
			id: '1504',
			name: `A test with a name long enough that the call no longer fits on one line, isn't it`,
			subtype: 'gherkin_test',
			description: '<p>Intro</p><ul><li>one</li><li>two</li></ul>',
			script:
				"Scenario Outline: s\nGiven a \"b\" and 'c' and 'd'\nThen e\nExamples:\n| a | long b |\n| 1 | 2 |\n"
		};
		// A test without steps, and a Gherkin test without scenarios, still give a test to fill in.
		const empty = { id: '1505', name: 'No steps yet', subtype: 'test_manual', script: '' };
		const bare = {
			id: '1506',
			name: 'Bare feature',
			subtype: 'gherkin_test',
			script: 'Feature: x'
		};
		octane = fakeOctane([MANUAL, long, empty, bare]);
		vi.stubGlobal('fetch', octane.fetch);
		const results = await importOctane({
			ids: ['1501', '1504', '1505', '1506'],
			folder: 'webgui',
			replacePlans: false
		});
		const files = results.flatMap((r) => [r.plan.file, r.spec.file]).map((f) => join(root, f));
		const repo = resolve(import.meta.dirname, '../../..');
		const check = spawnSync(
			join(repo, 'node_modules/.bin/oxfmt'),
			['--check', '--config', join(repo, '.oxfmtrc.json'), ...files],
			{ encoding: 'utf8' }
		);
		expect(check.stdout + check.stderr).toContain('All matched files use the correct format.');
		const specs = results.map((r) => join(root, r.spec.file));
		expect(read(must(results[3]).spec.file)).toContain(
			"test.fixme('Bare feature', { tag: '@octane-1506' }, async () => {\n\t// No steps in Octane yet.\n});"
		);
		// oxlint's default rules (no-unused-vars among them), run where the repository's type-aware
		// configuration is not found: it cannot resolve the plugin from this temporary folder.
		const lint = spawnSync(join(repo, 'node_modules/.bin/oxlint'), ['--deny-warnings', ...specs], {
			cwd: root,
			encoding: 'utf8'
		});
		// A finding reads `warning eslint(no-unused-vars): …`; in CI a clean run still prints a
		// summary line, so the output is checked for findings, then the exit status.
		expect(lint.stdout + lint.stderr).not.toMatch(/\b(warning|error) [\w-]+\(/);
		expect(lint.status).toBe(0);
	});
});

describe('slug', () => {
	test('is plain ASCII and not too long', async () => {
		const { slug } = await importer();
		expect(slug('Bestellung ändern – Größe')).toBe('bestellung-andern-grosse');
		expect(slug('***')).toBe('test');
		expect(slug('a'.repeat(80))).toHaveLength(60);
	});
});
