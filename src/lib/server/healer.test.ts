import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import type { HealerState } from '#lib/shared/types.js';

// paths.ts reads TEST_APP_DATA_DIR and SAP_TESTS_DIR when it is first imported, so each test gets
// fresh folders and a fresh copy of the module.
type Healer = typeof import('./healer.js');
let healer: Healer;
let tests = '';
let runDir = '';
const RUN = '20260101-000001-abcd';
const TEST = 'abc123-def456';

beforeEach(async () => {
	const data = mkdtempSync(join(tmpdir(), 'healer-data-'));
	tests = mkdtempSync(join(tmpdir(), 'healer-tests-'));
	mkdirSync(join(tests, 'tests'), { recursive: true });
	vi.stubEnv('TEST_APP_DATA_DIR', data);
	vi.stubEnv('SAP_TESTS_DIR', tests);
	vi.resetModules();
	healer = await import('./healer.js');
	runDir = join(data, 'runs', RUN);
	mkdirSync(join(runDir, 'healer'), { recursive: true });
	writeFileSync(join(runDir, 'output.log'), '');
});

const file = (name: string) => join(tests, 'tests', name);

type Original = { before: string | null; after?: string | null };

function saved(state: Partial<HealerState>, originals?: Record<string, Original>) {
	const full: HealerState = {
		runId: RUN,
		testId: TEST,
		title: 'a test',
		location: 'a.spec.ts:1',
		status: 'finished',
		startedAt: '2026-01-01T00:00:00.000Z',
		activity: [],
		changes: [{ file: 'x', diff: 'd' }],
		...state
	};
	writeFileSync(join(runDir, 'healer', `${TEST}.json`), JSON.stringify(full));
	if (originals)
		writeFileSync(join(runDir, 'healer', `${TEST}.originals.json`), JSON.stringify(originals));
}

describe('discardRepair', () => {
	test('puts back what the healer changed, deletes what it created and keeps later edits', () => {
		writeFileSync(file('changed.ts'), 'after');
		writeFileSync(file('created.ts'), 'new');
		writeFileSync(file('edited-since.ts'), 'a person changed it');
		saved(
			{},
			{
				[file('changed.ts')]: { before: 'before', after: 'after' },
				[file('created.ts')]: { before: null, after: 'new' },
				[file('edited-since.ts')]: { before: 'before', after: 'after' }
			}
		);
		const result = healer.discardRepair(RUN, TEST);
		expect(result).toEqual({ ok: true, kept: [expect.stringMatching(/edited-since\.ts$/)] });
		expect(readFileSync(file('changed.ts'), 'utf8')).toBe('before');
		expect(existsSync(file('created.ts'))).toBe(false);
		expect(readFileSync(file('edited-since.ts'), 'utf8')).toBe('a person changed it');
		// After a reload the page still says which files were left as they are.
		expect(healer.healingState(RUN, TEST)).toMatchObject({
			discarded: true,
			discardKept: [expect.stringMatching(/edited-since\.ts$/)]
		});
		expect(healer.discardRepair(RUN, TEST)).toEqual(result);
	});

	test('does not touch a file outside the test project, whatever the record says', () => {
		const outside = join(mkdtempSync(join(tmpdir(), 'healer-outside-')), 'x.ts');
		writeFileSync(outside, 'after');
		saved({}, { [outside]: { before: 'before', after: 'after' } });
		expect(healer.discardRepair(RUN, TEST)).toEqual({ ok: true, kept: [] });
		expect(readFileSync(outside, 'utf8')).toBe('after');
	});

	test('refuses when the record of the files before is missing, and changes nothing', () => {
		writeFileSync(file('changed.ts'), 'after');
		saved({});
		expect(healer.discardRepair(RUN, TEST)).toEqual({
			ok: false,
			error: 'The record of the files before the repair is missing; nothing was put back.'
		});
		expect(readFileSync(file('changed.ts'), 'utf8')).toBe('after');
		expect(healer.healingState(RUN, TEST)?.discarded).toBeUndefined();
	});
});

describe('healingState', () => {
	test('a healer the app stopped in the middle shows as stopped, with the changes saved so far', () => {
		saved({ status: 'running' }, { [file('a.ts')]: { before: 'x' } });
		expect(healer.healingState(RUN, TEST)).toMatchObject({
			status: 'stopped',
			error: 'The app stopped.',
			changes: [{ file: 'x', diff: 'd' }]
		});
	});
});

describe('healerOptions', () => {
	test('keeps the passwords from the model and from command lines, and the task as it is', () => {
		const secret = 'Pw-of-the-test-user';
		vi.stubEnv('SAP_PASSWORD', secret);
		const options = healer.healerOptions(
			{ tools: ['Read', 'mcp__playwright-test__test_run'], prompt: 'You are the healer.' },
			{
				budget: 1,
				abort: new AbortController(),
				hooks: {},
				serverEnv: { SAP_PASSWORD: secret },
				secrets: [secret]
			}
		);
		expect(options).toMatchObject({
			// An `@path` in a test's error is not a file to attach.
			verbatimPrompts: true,
			mcpServersDelivery: 'initialize',
			strictMcpConfig: true,
			settingSources: [],
			tools: ['Read']
		});
		const server = options.mcpServers?.['playwright-test'];
		// Every answer of the server passes the mask.
		const { command, args } = z
			.object({ command: z.string(), args: z.array(z.string()) })
			.parse(server);
		expect(command).toBe(process.execPath);
		expect(args[0]).toMatch(/healer-mask\.ts$/);
		expect(args.join(' ')).not.toContain(secret);
		expect(JSON.stringify(options.env)).not.toContain(secret);
	});
});

describe('startHealing', () => {
	test('is off unless TEST_APP_HEALER is on', async () => {
		vi.stubEnv('TEST_APP_HEALER', '');
		const result = await healer.startHealing(RUN, TEST);
		expect(result).toHaveProperty('ok', false);
		expect(result).toHaveProperty('error', expect.stringMatching(/^The healer is off/));
	});
});
