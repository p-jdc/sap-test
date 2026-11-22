import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { readSystems, systemsOfFiles } from './systems.js';
import { copySystems } from '../../test/systems.js';

/** This repository's systems.json, in a folder of its own. */
function repoSystems() {
	const dir = mkdtempSync(join(tmpdir(), 'systems-'));
	copySystems(dir);
	return join(dir, 'systems.json');
}

describe('record targets', () => {
	test("each system's folders, with the recorder that fits and where a page without login goes", () => {
		const { systems } = readSystems(repoSystems());
		expect(systems.map((s) => [s.id, s.record])).toEqual([
			[
				'sap',
				[
					{ folder: 'fiori', recorder: 'ui5', noLoginFolder: 'fiori/demokit' },
					{ folder: 'webgui', recorder: 'webgui' }
				]
			],
			['ariba', [{ folder: 'ariba', recorder: 'web' }]]
		]);
	});

	test('a system signing in through IAS or a form records web pages, in every folder of its own', () => {
		const file = join(mkdtempSync(join(tmpdir(), 'systems-')), 'systems.json');
		writeFileSync(
			file,
			JSON.stringify({
				systems: [
					{
						id: 'sf',
						title: 'SuccessFactors',
						signIn: { method: 'ias' },
						env: { url: 'SF_URL', user: 'SF_USER', password: 'SF_PASSWORD' },
						tests: ['successfactors', 'sf/_agents']
					}
				]
			})
		);
		expect(readSystems(file).systems[0]?.record).toEqual([
			{ folder: 'successfactors', recorder: 'web' }
		]);
	});
});

describe('systemsOfFiles', () => {
	test('names the system a spec file starts signed in to', () => {
		const files = [
			'fiori/a.spec.ts',
			'fiori/demokit/b.spec.ts',
			'webgui/c.spec.ts',
			'_reference/d.spec.ts',
			'ariba/e.spec.ts',
			'_demo/f.spec.ts',
			'api/g.spec.ts'
		];
		expect(Object.fromEntries(systemsOfFiles(files, repoSystems()))).toEqual({
			'fiori/a.spec.ts': 'sap',
			'fiori/demokit/b.spec.ts': undefined,
			'webgui/c.spec.ts': 'sap',
			'_reference/d.spec.ts': 'sap',
			'ariba/e.spec.ts': 'ariba',
			'_demo/f.spec.ts': undefined,
			'api/g.spec.ts': undefined
		});
	});

	test('a missing or broken systems.json assigns none', () => {
		const dir = mkdtempSync(join(tmpdir(), 'systems-'));
		expect(
			systemsOfFiles(['fiori/a.spec.ts'], join(dir, 'none.json')).get('fiori/a.spec.ts')
		).toBeUndefined();
		writeFileSync(join(dir, 'systems.json'), '{');
		expect(
			systemsOfFiles(['fiori/a.spec.ts'], join(dir, 'systems.json')).get('fiori/a.spec.ts')
		).toBeUndefined();
	});
});
