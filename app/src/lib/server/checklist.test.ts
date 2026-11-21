import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';

let dataDir = '';

function freshChecklist(create = true) {
	dataDir = join(mkdtempSync(join(tmpdir(), 'checklist-')), create ? '' : 'not-yet-there');
	vi.stubEnv('TEST_APP_DATA_DIR', dataDir);
	vi.resetModules();
	return import('./checklist.js');
}

beforeEach(() => {
	vi.unstubAllEnvs();
});

describe('checklist', () => {
	test('every item has its own id', async () => {
		const { CHECKLIST } = await freshChecklist();
		const ids = CHECKLIST.flatMap((phase) => phase.items.map((item) => item.id));
		expect(ids).toHaveLength(16);
		expect(new Set(ids).size).toBe(ids.length);
	});

	test('nothing is ticked at first', async () => {
		const { readChecked } = await freshChecklist();
		expect(readChecked()).toEqual({});
	});

	test('ticks are stored, also when the data folder does not exist yet', async () => {
		const { readChecked, setChecked } = await freshChecklist(false);
		expect(existsSync(dataDir)).toBe(false);
		setChecked('p1-system', true);
		expect(setChecked('p1-flows', true)).toEqual({ 'p1-system': true, 'p1-flows': true });
		expect(setChecked('p1-system', false)).toEqual({ 'p1-system': false, 'p1-flows': true });
		expect(readChecked()).toEqual({ 'p1-system': false, 'p1-flows': true });
		expect(JSON.parse(readFileSync(join(dataDir, 'checklist.json'), 'utf8'))).toEqual(
			readChecked()
		);
	});

	test.each(['{not json', '{"p1-system":"yes"}', '[true]'])(
		'a damaged file (%s) counts as nothing ticked and is replaced by the next tick',
		async (content) => {
			const { readChecked, setChecked } = await freshChecklist();
			writeFileSync(join(dataDir, 'checklist.json'), content);
			expect(readChecked()).toEqual({});
			expect(setChecked('p2-mcp', true)).toEqual({ 'p2-mcp': true });
		}
	);
});
