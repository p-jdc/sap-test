import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
	query,
	type HookCallback,
	type Options,
	type SDKMessage
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { runSettings } from './env-file.js';
import {
	describeTool,
	parseAgentFile,
	type AgentFile,
	toolDecision,
	toolInput,
	unifiedDiff
} from './healer-rules.js';
import { idocTestEnv } from './idoc.js';
import { childEnv, PLAYWRIGHT_PACKAGE, playwrightCommand } from './node-cli.js';
import { APP_ROOT, RUNS_DIR, TESTS_DIR, TESTS_ROOT, toPosix, within } from './paths.js';
import { redactor } from './redact.js';
import { activeRunId, getLiveState } from './runner.js';
import { readRunState } from './runs-store.js';
import type { HealerState, RunTest } from '#lib/shared/types.js';

/** The healer's definition, the same file Claude Code uses for its subagent. */
const HEALER_AGENT = resolve(APP_ROOT, '.claude/agents/playwright-test-healer.md');

/** The most one repair may cost (an estimate); TEST_APP_HEALER_BUDGET_USD overrides it. */
const DEFAULT_BUDGET_USD = 5;
const MAX_TURNS = 80;
const ACTIVITY_TAIL = 300;
/** The built-in tools that change files. */
const CHANGING_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);

/**
 * Why the healer cannot be started here, or undefined when it can. It sends the test, its error
 * and what the browser shows to the AI provider, so it is off until TEST_APP_HEALER is `on`.
 */
export function healerProblem(): string | undefined {
	if (process.env.TEST_APP_HEALER !== 'on')
		return 'The healer is off. It sends the test, its error and what the SAP screens show to the AI provider (Anthropic), so it is turned on with TEST_APP_HEALER=on once that is approved. It also needs an API key (ANTHROPIC_API_KEY) or a Claude login on the computer running this app.';
	// The agent file and its paths assume the test project of this repository.
	if (resolve(TESTS_ROOT) !== resolve(APP_ROOT, 'sap-tests'))
		return 'The healer works only on the test project in this repository (SAP_TESTS_DIR points elsewhere).';
	if (!existsSync(HEALER_AGENT)) return `The healer's definition is missing: ${HEALER_AGENT}.`;
	if (!existsSync(PLAYWRIGHT_PACKAGE))
		return 'Playwright is not installed. Run "bun run setup" in the repository root.';
	return undefined;
}

type Original = z.infer<typeof originalSchema>;
type Healing = { state: HealerState; abort: AbortController };
let active: Healing | null = null;

/** The test the healer is working on, if any. One at a time, and never during a run. */
export function activeHealing(): { runId: string; testId: string; title: string } | null {
	if (active?.state.status !== 'running') return null;
	const { runId, testId, title } = active.state;
	return { runId, testId, title };
}

const SAFE_ID = /^[\w-]{1,200}$/;

/**
 * The healer's files of one test of a run: its state, the files as they were before it, and the
 * results of the test runs it starts (traces, screenshots, videos of the SAP screens). All of them
 * are removed with the run's log under the retention rules.
 */
function healerFiles(runId: string, testId: string) {
	const run = within(RUNS_DIR, runId);
	if (!run || run === RUNS_DIR || !SAFE_ID.test(testId)) return null;
	const dir = join(run, 'healer');
	return {
		dir,
		state: join(dir, `${testId}.json`),
		originals: join(dir, `${testId}.originals.json`),
		// Playwright empties the results folder before each run, so the server runs in another.
		output: join(dir, `${testId}-results`),
		server: join(dir, `${testId}-server`)
	};
}

function save(state: HealerState, originals?: Map<string, Original>) {
	const files = healerFiles(state.runId, state.testId);
	if (!files) return;
	mkdirSync(files.dir, { recursive: true });
	writeFileSync(files.state, JSON.stringify(state, null, '\t'));
	if (originals) writeFileSync(files.originals, JSON.stringify(Object.fromEntries(originals)));
}

const originalSchema = z.object({
	before: z.string().nullable(),
	after: z.string().nullable().optional()
});
const originalsSchema = z.record(z.string(), originalSchema);
const stateSchema = z.object({
	runId: z.string(),
	testId: z.string(),
	title: z.string(),
	location: z.string(),
	status: z.enum(['running', 'finished', 'failed', 'stopped']),
	startedAt: z.string(),
	finishedAt: z.string().optional(),
	activity: z.array(z.string()),
	report: z.string().optional(),
	error: z.string().optional(),
	changes: z.array(z.object({ file: z.string(), diff: z.string() })),
	discarded: z.boolean().optional(),
	discardKept: z.array(z.string()).optional(),
	costUsd: z.number().optional()
}) satisfies z.ZodType<HealerState>;

/** A file this module wrote, or null when it is missing or not what it should be. */
function readJson<S extends z.ZodType>(path: string, schema: S): z.infer<S> | null {
	try {
		const parsed = schema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What the healer did or is doing for one test of a run, or null if it was never asked. */
export function healingState(runId: string, testId: string): HealerState | null {
	if (active && active.state.runId === runId && active.state.testId === testId) return active.state;
	const files = healerFiles(runId, testId);
	if (!files) return null;
	const state = readJson(files.state, stateSchema);
	// The app stopped while the healer worked: nothing will finish it now.
	if (state?.status === 'running')
		return { ...state, status: 'stopped', error: 'The app stopped.' };
	return state;
}

const readText = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : null);

/** The repair's changes as diffs, from what each file was before and is now. */
function changesOf(originals: Map<string, Original>) {
	const changes: HealerState['changes'] = [];
	for (const [abs, original] of originals) {
		original.after = readText(abs);
		const file = toPosix(relative(APP_ROOT, abs));
		const diff = unifiedDiff(original.before, original.after, file);
		if (diff) changes.push({ file, diff });
	}
	return changes;
}

function failedTest(runId: string, testId: string): RunTest | string {
	const run = getLiveState(runId) ?? readRunState(runId);
	if (!run) return 'This run no longer exists.';
	if (run.status === 'running') return 'The run is still going.';
	const test = run.tests.find((t) => t.testId === testId);
	if (!test) return 'This test is not part of the run.';
	if (test.setup) return 'The healer repairs tests, not the sign-in.';
	if (test.status !== 'failed' && test.status !== 'timedOut')
		return 'The healer works on tests that failed.';
	return test;
}

/** The task for the healer: the test and how it failed in this run. */
function healerTask(test: RunTest, runId: string): string {
	const location = `sap-tests/tests/${test.file}:${test.line}`;
	// The MCP server runs in the healer's results folder, so the location it runs is absolute.
	const runLocation = `${resolve(TESTS_DIR, test.file)}:${test.line}`;
	const error = test.error?.message
		? `It failed with this error:\n\n\`\`\`\n${test.error.message}\n\`\`\``
		: 'The error message of the run is no longer kept; run the test to see it.';
	return [
		`Repair the failing test "${test.title}" at ${location}. It failed in the Test Lab run ${runId}.`,
		error,
		`Run only this test (\`${runLocation}\` as the location). You are started from the Test Lab app, not from a chat: nobody can answer a question, and your closing report is shown to the person who reviews your change.`,
		'In this app `browser_run_code_unsafe` is not available: try a locator on the paused page with `browser_evaluate` or `browser_generate_locator` instead. Do not save tool results to files.'
	].join('\n\n');
}

type SessionOptions = {
	budget: number;
	abort: AbortController;
	hooks: NonNullable<Options['hooks']>;
	serverEnv: Record<string, string>;
	serverCwd: string;
	secrets: readonly string[];
};

/** The Agent SDK session of the healer, with the playwright-test MCP server of this repository. */
function healerSession(test: RunTest, runId: string, agent: AgentFile, o: SessionOptions) {
	const server = playwrightCommand([
		'run-test-mcp-server',
		'--headless',
		'-c',
		resolve(TESTS_ROOT, 'playwright.config.ts')
	]);
	// The browser tools write their logs into the folder the server runs in.
	const inFolder = ['-c', 'cd "$0" && exec "$@"', o.serverCwd, server.cmd, ...server.args];
	// The model process gets no password, neither in its environment nor on its command line.
	const secretValues = new Set(o.secrets);
	const modelEnv = Object.fromEntries(
		Object.entries(childEnv({ CLAUDE_AGENT_SDK_CLIENT_APP: 'sap-test-lab' })).filter(
			([, value]) => value !== undefined && !secretValues.has(value)
		)
	);
	return query({
		prompt: healerTask(test, runId),
		options: {
			cwd: APP_ROOT,
			systemPrompt: agent.prompt,
			...(agent.model ? { model: agent.model } : {}),
			// Only the agent file's built-in tools, every call through the hooks. No settings, hooks or
			// MCP servers from the user's or the project's configuration.
			tools: agent.tools.filter((t) => !t.startsWith('mcp__')),
			allowedTools: agent.tools,
			permissionMode: 'dontAsk',
			settingSources: [],
			hooks: o.hooks,
			mcpServers: {
				'playwright-test': {
					type: 'stdio',
					command: '/bin/sh',
					args: inFolder,
					env: o.serverEnv,
					alwaysLoad: true
				}
			},
			// Over stdin, not on Claude Code's command line, where anyone on the machine could read
			// the server's environment and with it the passwords.
			mcpServersDelivery: 'initialize',
			// Only this server: no claude.ai connectors of the Claude login, no .mcp.json, no plugins.
			strictMcpConfig: true,
			env: modelEnv,
			maxTurns: MAX_TURNS,
			maxBudgetUsd: o.budget,
			abortController: o.abort,
			persistSession: false
		}
	});
}

/**
 * Starts the healer on one failed test of a finished run. It runs as the agent of
 * .claude/agents/playwright-test-healer.md, through the Claude Agent SDK, with the playwright-test
 * MCP server of this repository. Its changes stay in the working tree for a person to review;
 * nothing is committed.
 */
export async function startHealing(
	runId: string,
	testId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
	const problem = healerProblem();
	if (problem) return { ok: false, error: problem };
	const files = healerFiles(runId, testId);
	if (!files) return { ok: false, error: 'Unknown run or test.' };
	const test = failedTest(runId, testId);
	if (typeof test === 'string') return { ok: false, error: test };
	// Its report would outlive the run's details, which the retention rules remove with the log.
	if (!existsSync(join(files.dir, '..', 'output.log')))
		return { ok: false, error: 'The details of this run are no longer kept.' };
	if (!within(TESTS_DIR, test.file) || !existsSync(resolve(TESTS_DIR, test.file)))
		return { ok: false, error: `The test file ${test.file} no longer exists.` };
	let agent;
	try {
		agent = parseAgentFile(readFileSync(HEALER_AGENT, 'utf8'));
	} catch (e) {
		return { ok: false, error: `The healer's definition cannot be read: ${errorText(e)}` };
	}
	const settings = await runSettings();
	// Checked after the await: nothing below yields, so two requests cannot both start.
	if (activeHealing())
		return { ok: false, error: `The healer is working on "${activeHealing()?.title}".` };
	if (activeRunId())
		return { ok: false, error: 'A run is going; start the healer when it has finished.' };

	const redact = redactor(settings.secrets);
	const allowed = new Set(agent.tools);
	const originals = new Map<string, Original>();
	const abort = new AbortController();
	const state: HealerState = {
		runId,
		testId,
		title: test.title,
		location: `${test.file}:${test.line}`,
		status: 'running',
		startedAt: new Date().toISOString(),
		activity: [],
		changes: []
	};
	mkdirSync(files.server, { recursive: true });
	active = { state, abort };
	save(state);

	const note = (line: string) => {
		state.activity.push(redact(line));
		if (state.activity.length > ACTIVITY_TAIL)
			state.activity.splice(0, state.activity.length - ACTIVITY_TAIL);
	};

	// Every tool call passes here, also the ones the agent file allows: reading stays inside the
	// test code, changes inside the tests and helpers (healer-rules.ts).
	const gate: HookCallback = (input) => {
		if (input.hook_event_name !== 'PreToolUse') return Promise.resolve({});
		const args = toolInput(input.tool_input);
		const decision = toolDecision(input.tool_name, args, APP_ROOT, allowed, files.output);
		if (!decision.allow) {
			note(`Not allowed: ${describeTool(input.tool_name, args, APP_ROOT)} (${decision.reason})`);
			return Promise.resolve({
				hookSpecificOutput: {
					hookEventName: 'PreToolUse',
					permissionDecision: 'deny',
					permissionDecisionReason: decision.reason
				}
			});
		}
		if (decision.writes && !originals.has(decision.writes)) {
			originals.set(decision.writes, { before: readText(decision.writes) });
			// On disk before the change: if the app stops now, the change can still be undone.
			save(state, originals);
		}
		return Promise.resolve({
			hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' }
		});
	};

	// After every tool call: a password in what a tool returns (a test's output, a page, a file) is
	// masked before the model sees it, and after a change the diff is saved.
	const afterTool: HookCallback = (input) => {
		if (input.hook_event_name !== 'PostToolUse') return Promise.resolve({});
		if (CHANGING_TOOLS.has(input.tool_name)) {
			state.changes = redact(changesOf(originals));
			save(state, originals);
		}
		return Promise.resolve({
			hookSpecificOutput: {
				hookEventName: 'PostToolUse',
				updatedToolOutput: redact(input.tool_response)
			}
		});
	};

	const finish = (status: HealerState['status'], error?: string) => {
		if (state.finishedAt) return;
		process.off('exit', stopWithApp);
		state.status = status;
		if (error) state.error = redact(error);
		state.finishedAt = new Date().toISOString();
		state.changes = redact(changesOf(originals));
		save(state, originals);
		if (active?.state === state) active = null;
	};
	const stopWithApp = () => {
		abort.abort();
	};
	process.once('exit', stopWithApp);

	const budget = Number(process.env.TEST_APP_HEALER_BUDGET_USD) || DEFAULT_BUDGET_USD;
	let messages: AsyncIterable<SDKMessage>;
	try {
		messages = healerSession(test, runId, agent, {
			budget,
			abort,
			hooks: {
				PreToolUse: [{ hooks: [gate], onFailure: 'block' }],
				PostToolUse: [{ hooks: [afterTool] }]
			},
			// The test users' passwords go to the MCP server only, which runs the tests. Its results
			// go to the healer's folder, which the retention rules remove with the run's log.
			serverEnv: {
				...settings.env,
				...idocTestEnv(),
				SAP_TESTS_OUTPUT_DIR: files.output,
				FORCE_COLOR: '0'
			},
			serverCwd: files.server,
			secrets: settings.secrets
		});
	} catch (e) {
		finish('failed', errorText(e));
		return { ok: false, error: `The healer could not start: ${redact(errorText(e))}` };
	}

	void (async () => {
		try {
			for await (const message of messages) onMessage(message);
			finish(abort.signal.aborted ? 'stopped' : state.report ? 'finished' : 'failed');
		} catch (e) {
			finish(abort.signal.aborted ? 'stopped' : 'failed', errorText(e));
		}
	})();

	function onMessage(message: SDKMessage) {
		if (message.type === 'assistant' && message.parent_tool_use_id === null) {
			if (message.error) note(`The model call failed: ${message.error}`);
			for (const block of message.message.content) {
				if (block.type === 'tool_use') {
					note(describeTool(block.name, toolInput(block.input), APP_ROOT));
				}
			}
		} else if (message.type === 'result') {
			state.costUsd = message.total_cost_usd;
			if (message.subtype === 'success') state.report = redact(message.result);
			else
				state.error = redact(
					message.subtype === 'error_max_budget_usd'
						? `Stopped at the budget of $${budget} (TEST_APP_HEALER_BUDGET_USD).`
						: message.subtype === 'error_max_turns'
							? `Stopped after ${MAX_TURNS} turns.`
							: message.errors.join('\n') || 'The healer stopped with an error.'
				);
		}
	}

	return { ok: true };
}

export function stopHealing(runId: string, testId: string): boolean {
	if (!active || active.state.runId !== runId || active.state.testId !== testId) return false;
	active.abort.abort();
	return true;
}

/**
 * Puts back the files the healer changed, as they were before it. A file someone changed since is
 * left as it is and named in the answer.
 */
export function discardRepair(
	runId: string,
	testId: string
): { ok: true; kept: string[] } | { ok: false; error: string } {
	const files = healerFiles(runId, testId);
	const state = healingState(runId, testId);
	if (!files || !state) return { ok: false, error: 'The healer did not work on this test.' };
	if (state.status === 'running') return { ok: false, error: 'The healer is still working.' };
	if (state.discarded) return { ok: true, kept: state.discardKept ?? [] };
	const originals = readJson(files.originals, originalsSchema);
	if (!originals) {
		if (state.changes.length > 0)
			return {
				ok: false,
				error: 'The record of the files before the repair is missing; nothing was put back.'
			};
		save({ ...state, discarded: true, discardKept: [] });
		return { ok: true, kept: [] };
	}
	const kept: string[] = [];
	for (const [abs, original] of Object.entries(originals)) {
		// Only files the healer could change: the gate recorded them, but the file is data.
		if (!within(TESTS_ROOT, relative(TESTS_ROOT, abs))) continue;
		const now = readText(abs);
		if (now === original.before) continue;
		if (now !== original.after) {
			kept.push(toPosix(relative(APP_ROOT, abs)));
			continue;
		}
		if (original.before === null) rmSync(abs, { force: true });
		else {
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, original.before);
		}
	}
	save({ ...state, discarded: true, discardKept: kept });
	return { ok: true, kept };
}
