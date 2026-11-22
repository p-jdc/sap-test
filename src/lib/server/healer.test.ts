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

describe('continuedRepair', () => {
	test('goes on from the files before the first session, unless a person changed them since', () => {
		writeFileSync(file('untouched.ts'), 'H1');
		writeFileSync(file('edited.ts'), 'H1 and a person');
		saved(
			{},
			{
				[file('untouched.ts')]: { before: 'B0', after: 'H1' },
				[file('edited.ts')]: { before: 'B0', after: 'H1' }
			}
		);
		expect(Object.fromEntries(healer.continuedRepair(RUN, TEST))).toEqual({
			[file('untouched.ts')]: { before: 'B0' },
			[file('edited.ts')]: { before: 'H1 and a person' }
		});
	});

	test("a file the healer was changing when the app stopped is still the healer's", () => {
		writeFileSync(file('mid-change.ts'), 'H2');
		saved({}, { [file('mid-change.ts')]: { before: 'B0' } });
		expect(Object.fromEntries(healer.continuedRepair(RUN, TEST))).toEqual({
			[file('mid-change.ts')]: { before: 'B0' }
		});
	});

	test('starts afresh after a discard', () => {
		saved({ discarded: true }, { [file('a.ts')]: { before: 'B0', after: 'H1' } });
		expect(healer.continuedRepair(RUN, TEST).size).toBe(0);
	});
});

describe('a session the app stopped', () => {
	test('shows the change in progress and can be discarded', () => {
		writeFileSync(file('a.ts'), 'H2');
		saved({ status: 'running', changes: [] }, { [file('a.ts')]: { before: 'B0' } });
		expect(JSON.stringify(healer.healingState(RUN, TEST))).toContain('+H2');
		expect(healer.discardRepair(RUN, TEST)).toEqual({ ok: true, kept: [] });
		expect(readFileSync(file('a.ts'), 'utf8')).toBe('B0');
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

	test('starts the server in the test project with what a run gets, without the model key', () => {
		vi.stubEnv('SAP_URL', 'https://sap.example');
		vi.stubEnv('ANTHROPIC_API_KEY', 'model-key');
		vi.stubEnv('BETTER_AUTH_SECRET', 'the-apps-secret');
		vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '/secrets/vertex.json');
		const options = healer.healerOptions(
			{ tools: ['mcp__playwright-test__test_run'], prompt: 'p' },
			{
				budget: 1,
				abort: new AbortController(),
				hooks: {},
				serverEnv: { SAP_PASSWORD: 'from-the-store' },
				secrets: ['from-the-store']
			}
		);
		const { env } = z
			.object({ env: z.record(z.string(), z.string()) })
			.parse(options.mcpServers?.['playwright-test']);
		// healer-mask.ts starts the server there, where the config loads sap-tests/.env.
		expect(env.HEALER_CWD).toBe(tests);
		expect(env).toMatchObject({ SAP_URL: 'https://sap.example', SAP_PASSWORD: 'from-the-store' });
		// Not the rest of the app's environment, which code the healer writes would run with.
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.BETTER_AUTH_SECRET).toBeUndefined();
		expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
		expect(env.PATH).toBeDefined();
	});
});

describe('modelAccess', () => {
	test("goes through Foundry with Claude Code's switch, the key and the deployment", () => {
		expect(
			healer.modelAccess({
				TEST_APP_AI: 'foundry',
				TEST_APP_AI_MODEL: 'claude-healer',
				ANTHROPIC_FOUNDRY_RESOURCE: 'lab-ai',
				ANTHROPIC_FOUNDRY_API_KEY: 'k'
			})
		).toEqual({
			model: 'claude-healer',
			env: {
				CLAUDE_CODE_USE_FOUNDRY: '1',
				ANTHROPIC_FOUNDRY_RESOURCE: 'lab-ai',
				ANTHROPIC_FOUNDRY_API_KEY: 'k'
			}
		});
	});

	test('goes through Vertex AI with its project and location', () => {
		expect(
			healer.modelAccess({
				TEST_APP_AI: 'vertex',
				GOOGLE_VERTEX_PROJECT: 'p',
				GOOGLE_VERTEX_LOCATION: 'europe-west1'
			})
		).toMatchObject({
			env: {
				CLAUDE_CODE_USE_VERTEX: '1',
				ANTHROPIC_VERTEX_PROJECT_ID: 'p',
				CLOUD_ML_REGION: 'europe-west1'
			}
		});
	});

	test('with the AI off, uses the Claude login only on a local app', () => {
		expect(healer.modelAccess({})).toEqual({ env: {} });
		expect(healer.modelAccess({ TEST_APP_AUTH: 'passkey' })).toHaveProperty(
			'problem',
			expect.stringMatching(/TEST_APP_AI/)
		);
	});

	test('the direct Anthropic API only on a local app', () => {
		expect(
			healer.modelAccess({ TEST_APP_AI: 'anthropic', ANTHROPIC_API_KEY: 'k', HOST: '0.0.0.0' })
		).toHaveProperty('problem');
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
