import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync
} from 'node:fs';
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
import { aiReady } from '#lib/shared/ai.js';
import { aiStatus } from './ai/settings.js';
import { authMode, listensLocally } from './auth/policy.js';
import { masker } from './healer-mask.js';
import { settingNames } from './systems.js';
import { idocTestEnv } from './idoc.js';
import { childEnv, PLAYWRIGHT_PACKAGE, playwrightCommand } from './node-cli.js';
import { APP_ROOT, RUNS_DIR, TESTS_DIR, TESTS_ROOT, toPosix, within } from './paths.js';
import { redactor } from './redact.js';
import { activeRunId, getLiveState } from './runner.js';
import { readRunState } from './runs-store.js';
import type { HealerState, RunTest } from '#lib/shared/types.js';

/** The healer's definition, the same file Claude Code uses for its subagent. */
const HEALER_AGENT = resolve(APP_ROOT, '.claude/agents/playwright-test-healer.md');
/** Masks what the MCP server answers before the model sees it; runs on Bun, like the app. */
const MASK_SCRIPT = resolve(APP_ROOT, 'src/lib/server/healer-mask.ts');

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
/** Whether the healer is turned on (TEST_APP_HEALER=on); off, the run page does not show it. */
export const healerOn = () => process.env.TEST_APP_HEALER === 'on';

/**
 * How the healer's Claude Code reaches Claude: through the app's AI provider (TEST_APP_AI, see
 * ai/settings.ts) with Claude Code's own switches for Vertex AI and Microsoft Foundry, or, on a
 * local app with the AI off, through the Claude login of this computer.
 */
export function modelAccess(
	env: NodeJS.ProcessEnv = process.env
): { env: Record<string, string>; model?: string } | { problem: string } {
	const status = aiStatus(env);
	if (status.provider === 'off') {
		if (status.problem) return { problem: status.problem };
		let local = false;
		try {
			local = authMode(env.TEST_APP_AUTH) === 'off' && listensLocally(env.HOST);
		} catch {
			local = false;
		}
		return local
			? { env: {} }
			: {
					problem:
						"The healer reaches Claude through the app's AI provider: set TEST_APP_AI to vertex or foundry. Only a local app may use the Claude login of its computer."
				};
	}
	if (!aiReady(status))
		return { problem: status.problem ?? `The AI needs ${status.missing.join(' and ')}.` };
	const setting = (name: string) => env[name]?.trim() ?? '';
	const { model } = status;
	if (status.provider === 'vertex')
		return {
			model,
			env: {
				CLAUDE_CODE_USE_VERTEX: '1',
				ANTHROPIC_VERTEX_PROJECT_ID: setting('GOOGLE_VERTEX_PROJECT'),
				CLOUD_ML_REGION: setting('GOOGLE_VERTEX_LOCATION'),
				// Google's sign-in: a key file if one is set, otherwise the credentials of gcloud.
				...(setting('GOOGLE_APPLICATION_CREDENTIALS')
					? { GOOGLE_APPLICATION_CREDENTIALS: setting('GOOGLE_APPLICATION_CREDENTIALS') }
					: {})
			}
		};
	if (status.provider === 'foundry')
		return {
			model,
			env: {
				CLAUDE_CODE_USE_FOUNDRY: '1',
				ANTHROPIC_FOUNDRY_RESOURCE: setting('ANTHROPIC_FOUNDRY_RESOURCE'),
				ANTHROPIC_FOUNDRY_API_KEY: setting('ANTHROPIC_FOUNDRY_API_KEY')
			}
		};
	// Local tests only: aiStatus refuses it with sign-in on or on the network.
	return { model, env: { ANTHROPIC_API_KEY: setting('ANTHROPIC_API_KEY') } };
}

export function healerProblem(): string | undefined {
	if (!healerOn())
		return "The healer is off. It sends the test, its error and what the SAP screens show to the app's AI provider (TEST_APP_AI), so it is turned on with TEST_APP_HEALER=on once that is approved.";
	const access = modelAccess();
	if ('problem' in access) return access.problem;
	// The agent file and its paths assume the test project of this repository.
	if (resolve(TESTS_ROOT) !== resolve(APP_ROOT, 'sap-tests'))
		return 'The healer works only on the test project in this repository (SAP_TESTS_DIR points elsewhere).';
	if (!existsSync(HEALER_AGENT)) return `The healer's definition is missing: ${HEALER_AGENT}.`;
	if (!process.versions.bun || !existsSync(MASK_SCRIPT))
		return 'The healer needs the app to run on Bun from this repository (it starts src/lib/server/healer-mask.ts).';
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
		output: join(dir, `${testId}-results`),
		// What the browser tools wrote (console logs, snapshots), moved here when the session ends.
		browser: join(dir, `${testId}-browser`)
	};
}

function save(state: HealerState, originals?: Map<string, Original>) {
	const files = healerFiles(state.runId, state.testId);
	// The retention rules removed the run's log, and with it the healer's folder: keep nothing.
	if (!files || !existsSync(join(files.dir, '..', 'output.log'))) return;
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
	// The app stopped while the healer worked: nothing will finish it now. The diff is worked out
	// from the record of the files before it, which also holds the change in progress.
	if (state?.status === 'running') {
		const originals = readJson(files.originals, originalsSchema) ?? {};
		const inTests = Object.entries(originals).filter(([abs]) =>
			within(TESTS_ROOT, relative(TESTS_ROOT, abs))
		);
		return {
			...state,
			status: 'stopped',
			error: 'The app stopped.',
			changes: inTests.length > 0 ? changesOf(new Map(inTests)) : state.changes
		};
	}
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
	// Its traces and screenshots would outlive the run's own, which the retention rules removed.
	if (run.artifactsRemoved) return 'The files of this run are no longer kept.';
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
	// Absolute, as the MCP server's test runner finds it best.
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

/**
 * The browser tools of the MCP server write their console logs and snapshots to .playwright-mcp
 * in the folder Claude Code works in (the repository root), not to a folder of their own.
 */
const BROWSER_FILES = resolve(APP_ROOT, '.playwright-mcp');
const browserFiles = () => new Set(existsSync(BROWSER_FILES) ? readdirSync(BROWSER_FILES) : []);

/** Moves what the browser tools wrote during the session into the healer's folder of the run. */
function moveBrowserFiles(before: ReadonlySet<string>, to: string) {
	const added = [...browserFiles()].filter((name) => !before.has(name));
	if (added.length === 0 || !existsSync(dirname(to))) return;
	mkdirSync(to, { recursive: true });
	for (const name of added) {
		try {
			renameSync(join(BROWSER_FILES, name), join(to, name));
		} catch {
			rmSync(join(BROWSER_FILES, name), { recursive: true, force: true });
		}
	}
}

/** What the system needs to run node and a browser. */
const SYSTEM_ENV = new Set([
	'PATH',
	'HOME',
	'USER',
	'LOGNAME',
	'SHELL',
	'LANG',
	'TZ',
	'TMPDIR',
	'TEMP',
	'TMP',
	'DISPLAY',
	'XDG_RUNTIME_DIR',
	'CI',
	'CHROMIUM_PATH',
	'SSL_CERT_FILE',
	'SSL_CERT_DIR',
	'HTTP_PROXY',
	'HTTPS_PROXY',
	'NO_PROXY',
	'http_proxy',
	'https_proxy',
	'no_proxy'
]);
/** Settings of the test project and its tools by their prefix. */
const TEST_ENV = /^(SAP_|ARIBA_|ODATA_|IDOC_|MFS_|PLAYWRIGHT_|PW_|NODE_|LC_)/;

/**
 * The MCP server's environment: the tests' settings (those this app knows, the saved ones, the
 * test project's prefixes) and what the system needs, not the rest of this app's environment
 * (its sign-in secret, the AI provider's credentials, the model's key), which code the healer
 * writes would run with. It runs in sap-tests, where its config loads sap-tests/.env as a run's
 * does.
 */
function serverEnv(extra: Record<string, string>, secrets: readonly string[]) {
	const known = new Set<string>(settingNames());
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(childEnv(extra)))
		if (value !== undefined && (SYSTEM_ENV.has(key) || known.has(key) || TEST_ENV.test(key)))
			env[key] = value;
	return { ...env, ...extra, HEALER_CWD: TESTS_ROOT, HEALER_MASK: JSON.stringify(secrets) };
}

type SessionOptions = {
	budget: number;
	abort: AbortController;
	hooks: NonNullable<Options['hooks']>;
	serverEnv: Record<string, string>;
	secrets: readonly string[];
};

/**
 * The Agent SDK options of the healer's session, with the playwright-test MCP server of this
 * repository behind the mask.
 */
export function healerOptions(agent: AgentFile, o: SessionOptions): Options {
	const server = playwrightCommand([
		'run-test-mcp-server',
		'--headless',
		'-c',
		resolve(TESTS_ROOT, 'playwright.config.ts')
	]);
	// The model process gets no password, neither in its environment nor on its command line.
	const access = modelAccess();
	if ('problem' in access) throw new Error(access.problem);
	const secretValues = new Set(o.secrets);
	const modelEnv = Object.fromEntries(
		Object.entries(childEnv({ ...access.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'sap-test-lab' })).filter(
			([, value]) => value !== undefined && !secretValues.has(value)
		)
	);
	return {
		cwd: APP_ROOT,
		systemPrompt: agent.prompt,
		// The app's model (TEST_APP_AI_MODEL; on Foundry the deployment), else the agent file's.
		...(access.model || agent.model ? { model: access.model ?? agent.model } : {}),
		// The task holds the test's title and error, text from the SAP screens: Claude Code must not
		// read an `@path` in it as a file to attach, which no hook would see.
		verbatimPrompts: true,
		// Only the agent file's built-in tools, every call through the hooks. No settings, hooks or
		// MCP servers from the user's or the project's configuration.
		tools: agent.tools.filter((t) => !t.startsWith('mcp__')),
		allowedTools: agent.tools,
		permissionMode: 'dontAsk',
		settingSources: [],
		hooks: o.hooks,
		mcpServers: {
			// Every answer of the server passes healer-mask.ts before the model sees it.
			'playwright-test': {
				type: 'stdio',
				command: process.execPath,
				args: [MASK_SCRIPT, server.cmd, ...server.args],
				env: serverEnv(o.serverEnv, o.secrets),
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
	};
}

/**
 * The record of an earlier repair of this test that was not discarded: a new session goes on from
 * it, so its diff and "Discard the repair" still go back to the files before the first session. A
 * file someone changed since that session starts afresh from what it is now, so that a discard
 * does not undo the person's edits.
 */
export function continuedRepair(runId: string, testId: string): Map<string, Original> {
	const originals = new Map<string, Original>();
	const files = healerFiles(runId, testId);
	if (!files || healingState(runId, testId)?.discarded) return originals;
	for (const [abs, original] of Object.entries(readJson(files.originals, originalsSchema) ?? {})) {
		if (!within(TESTS_ROOT, relative(TESTS_ROOT, abs))) continue;
		const now = readText(abs);
		// No `after`: the healer was changing the file when its session ended.
		const healers = original.after === undefined || now === original.after;
		originals.set(abs, { before: healers ? original.before : now });
	}
	return originals;
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
	// A repair of this test that was not discarded: this session goes on from it, so its diff and
	// "Discard the repair" still go back to the files as they were before the first session.
	const originals = continuedRepair(runId, testId);
	const abort = new AbortController();
	const browserFilesBefore = browserFiles();
	const state: HealerState = {
		runId,
		testId,
		title: test.title,
		location: `${test.file}:${test.line}`,
		status: 'running',
		startedAt: new Date().toISOString(),
		activity: [],
		changes: redact(changesOf(originals))
	};
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
		if (decision.writes) {
			// On disk before the change: if the app stops during it, the change can still be undone.
			// `after` is unknown until the change is done (afterTool), so a stop in between does not
			// make the healer's change look like a person's.
			const known = originals.get(decision.writes);
			if (known) delete known.after;
			else originals.set(decision.writes, { before: readText(decision.writes) });
			save(state, originals);
		}
		return Promise.resolve({
			hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' }
		});
	};

	// After every tool call: what a tool returns (a test's output, a page, a file) is masked as
	// healer-mask.ts masks the server's answers, before the model sees it; after a change the diff
	// is saved.
	const mask = masker(settings.secrets);
	const afterTool: HookCallback = (input) => {
		if (input.hook_event_name !== 'PostToolUse') return Promise.resolve({});
		if (CHANGING_TOOLS.has(input.tool_name)) {
			try {
				state.changes = redact(changesOf(originals));
				save(state, originals);
			} catch (e) {
				note(`The diff could not be saved: ${errorText(e)}`);
			}
		}
		return Promise.resolve({
			hookSpecificOutput: {
				hookEventName: 'PostToolUse',
				updatedToolOutput: mask.deep(input.tool_response)
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
		moveBrowserFiles(browserFilesBefore, files.browser);
		if (active?.state === state) active = null;
	};
	const stopWithApp = () => {
		abort.abort();
	};
	process.once('exit', stopWithApp);

	const budget = Number(process.env.TEST_APP_HEALER_BUDGET_USD) || DEFAULT_BUDGET_USD;
	let messages: AsyncIterable<SDKMessage>;
	try {
		messages = query({
			prompt: healerTask(test, runId),
			options: healerOptions(agent, {
				budget,
				abort,
				hooks: {
					PreToolUse: [{ hooks: [gate], onFailure: 'block' }],
					PostToolUse: [{ hooks: [afterTool], onFailure: 'block' }]
				},
				// The test users' passwords go to the MCP server only, which runs the tests. Its results
				// go to the healer's folder, which the retention rules remove with the run's log.
				serverEnv: {
					...settings.env,
					...idocTestEnv(),
					SAP_TESTS_OUTPUT_DIR: files.output,
					FORCE_COLOR: '0'
				},
				secrets: settings.secrets
			})
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
		// No `after`: the session ended during the healer's change of this file.
		if (original.after !== undefined && now !== original.after) {
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
