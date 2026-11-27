import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { query, type HookCallback, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { readTestEnv, runSettings } from './env-file.js';
import {
	activeHealing,
	agentProblem,
	browserFiles,
	healerOptions,
	moveBrowserFiles
} from './healer.js';
import { masker } from './healer-mask.js';
import { reviewBlock } from './healer-review.js';
import { parseAgentFile, toolInput } from './healer-rules.js';
import { setPlanning } from './healing-run.js';
import { idocTestEnv } from './idoc.js';
import { APP_ROOT, DATA_DIR, toPosix, within } from './paths.js';
import { describePlannerTool, PLANS_DIR, plannerDecision, sessionTarget } from './planner-rules.js';
import { redactor } from './redact.js';
import { endpointOf, startHostProxy, type HostProxy } from './agent-proxy.js';
import { activeRunId } from './runner.js';
import { signInSystems } from './systems.js';
import type { PlannerState } from '#lib/shared/types.js';

/** The planner's definition, the same file Claude Code uses for its subagent. */
const PLANNER_AGENT = resolve(APP_ROOT, '.claude/agents/playwright-test-planner.md');
const SESSIONS_DIR = resolve(DATA_DIR, 'planner');

/** The most one plan may cost (an estimate); TEST_APP_PLANNER_BUDGET_USD overrides it. */
const DEFAULT_BUDGET_USD = 5;
/** Exploring takes more turns than a repair. */
const MAX_TURNS = 200;
const ACTIVITY_TAIL = 400;
/** The sessions kept; older ones are removed when a new one starts. */
const KEEP_SESSIONS = 30;
/** How long after a session the MCP server may still write its results. */
const LATE_RESULTS_MS = 20_000;

/** Whether the planner is turned on (TEST_APP_PLANNER=on); off, the page only says so. */
export const plannerOn = () => process.env.TEST_APP_PLANNER === 'on';

/**
 * Why the planner cannot be started here, or undefined when it can. It clicks through the
 * application on its own and sends what the screens show to the AI provider, so it is off until
 * TEST_APP_PLANNER is `on`.
 */
export function plannerProblem(): string | undefined {
	if (!plannerOn())
		return "The planner is off. It explores the application on its own, with a test user's rights, and sends what the screens show to the app's AI provider (TEST_APP_AI), so it is turned on with TEST_APP_PLANNER=on once that is approved.";
	// Its seed test is test code, and none runs while a repair of the healer has not been read.
	return reviewBlock() ?? agentProblem('planner', PLANNER_AGENT);
}

type Planning = { state: PlannerState; abort: AbortController };
let active: Planning | null = null;

/** The session the planner is working on, if any. One at a time, and never beside a run. */
export function activePlanning(): { id: string; flow: string } | null {
	if (active?.state.status !== 'running') return null;
	const { id, flow } = active.state;
	return { id, flow };
}

const SESSION_ID = /^[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$/;
const pad = (n: number) => String(n).padStart(2, '0');

function newId() {
	const d = new Date();
	return (
		`${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
		`${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-` +
		Math.random().toString(36).slice(2, 6)
	);
}

function sessionFiles(id: string) {
	if (!SESSION_ID.test(id)) return null;
	const dir = join(SESSIONS_DIR, id);
	return {
		dir,
		state: join(dir, 'state.json'),
		// The results of the seed test and what the browser tools wrote: removed when it ends.
		output: join(dir, 'results'),
		browser: join(dir, 'browser')
	};
}

const stateSchema = z.object({
	id: z.string(),
	flow: z.string(),
	target: z.string(),
	status: z.enum(['running', 'finished', 'failed', 'stopped']),
	startedAt: z.string(),
	finishedAt: z.string().optional(),
	activity: z.array(z.string()),
	report: z.string().optional(),
	error: z.string().optional(),
	plan: z.string().optional(),
	costUsd: z.number().optional()
}) satisfies z.ZodType<PlannerState>;

function save(state: PlannerState) {
	const files = sessionFiles(state.id);
	if (!files) return;
	mkdirSync(files.dir, { recursive: true });
	writeFileSync(files.state, JSON.stringify(state, null, '\t'));
}

function stored(id: string): PlannerState | null {
	const files = sessionFiles(id);
	if (!files) return null;
	try {
		const parsed = stateSchema.safeParse(JSON.parse(readFileSync(files.state, 'utf8')));
		if (!parsed.success) return null;
		// The app stopped while the planner worked: nothing will finish it now.
		return parsed.data.status === 'running'
			? { ...parsed.data, status: 'stopped', error: 'The app stopped.' }
			: parsed.data;
	} catch {
		return null;
	}
}

/** What the planner did or is doing in one session, or null if there is none. */
export function planningState(id: string): PlannerState | null {
	return active?.state.id === id ? active.state : stored(id);
}

const sessionIds = () =>
	existsSync(SESSIONS_DIR)
		? readdirSync(SESSIONS_DIR)
				.filter((name) => SESSION_ID.test(name))
				.toSorted()
				.toReversed()
		: [];

/** The sessions, newest first, without their activity. */
export function listPlannings(): PlannerState[] {
	return sessionIds().flatMap((id) => {
		const state = planningState(id);
		return state ? [{ ...state, activity: [] }] : [];
	});
}

/** The plan a session saved, as it is now in sap-tests/specs, or null when it is gone. */
export function planText(id: string): string | null {
	const plan = planningState(id)?.plan;
	const file = plan ? within(APP_ROOT, plan) : null;
	// The state file is data: only a file directly in the plans folder is shown.
	if (!file || toPosix(dirname(relative(APP_ROOT, file))) !== PLANS_DIR) return null;
	return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type PlanningInput = {
	/** The id of a system of systems.json to start signed in to; without it, no sign-in. */
	system?: string;
	/** The address to open; with a system, a page of it to start from. */
	address?: string;
	/** The business process to plan, in the person's words. */
	flow: string;
};

/** The task for the planner: where to start and what to plan. */
function plannerTask(flow: string, start: string): string {
	return [
		`Plan tests for this business process:\n\n${flow}`,
		start,
		'You are started from the Test Lab app, not from a chat: nobody can answer a question, and your closing report is shown to the person who reviews the plan. Save one plan with `planner_save_plan` under a new file name; a file that exists already is refused, and a second save must use the same name as your first.',
		'In this app `browser_run_code_unsafe` and `browser_file_upload` are not available, tool results cannot be saved to files, and the browser reaches only the host you start on: requests to any other host are blocked. So you cannot count a locator with Playwright: read the control type and its properties with `browser_evaluate` as your instructions describe, and say under **Locators and pitfalls** that the locators are not checked for uniqueness.'
	].join('\n\n');
}

/**
 * Removes what a session's browser left: snapshots, console logs and the seed test's results show
 * the application's screens. The plan and the report are what is kept.
 */
function removeBrowserData(id: string) {
	const files = sessionFiles(id);
	if (!files) return;
	// The MCP server may still be writing there: what stays now goes on a later pass.
	for (const dir of [files.browser, files.output]) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Tried again when the next session starts (pruneSessions).
		}
	}
}

/**
 * Removes the oldest sessions beyond the ones kept, and the browser data of the others: the MCP
 * server writes its test results when it closes, which can be after its session ended.
 */
function pruneSessions() {
	sessionIds().forEach((id, i) => {
		if (id === active?.state.id) return;
		if (i < KEEP_SESSIONS) removeBrowserData(id);
		else
			try {
				rmSync(join(SESSIONS_DIR, id), { recursive: true, force: true });
			} catch {
				// Tried again when the next session starts.
			}
	});
}

/**
 * Starts the planner on a business process. It runs as the agent of
 * .claude/agents/playwright-test-planner.md, through the Claude Agent SDK, with the playwright-test
 * MCP server of this repository behind the mask (healer.ts, healerOptions). It explores the
 * application in a headless browser and saves one plan to sap-tests/specs, for a person to review:
 * it writes no test code.
 */
export async function startPlanning(
	input: PlanningInput
): Promise<{ ok: true; id: string; flow: string } | { ok: false; error: string }> {
	const problem = plannerProblem();
	if (problem) return { ok: false, error: problem };
	const flow = input.flow.trim();
	if (!flow) return { ok: false, error: 'Describe the business process to plan.' };
	let agent;
	try {
		agent = parseAgentFile(readFileSync(PLANNER_AGENT, 'utf8'));
	} catch (e) {
		return { ok: false, error: `The planner's definition cannot be read: ${errorText(e)}` };
	}
	const chosen = input.system ? signInSystems().find((s) => s.id === input.system) : undefined;
	if (input.system && !chosen)
		return { ok: false, error: `There is no system "${input.system}" in sap-tests/systems.json.` };
	const target = sessionTarget(
		input,
		chosen && {
			id: chosen.id,
			title: chosen.title,
			setting: chosen.env.url,
			address: (await readTestEnv())[chosen.env.url]
		}
	);
	if (typeof target === 'string') return { ok: false, error: target };
	const settings = await runSettings();
	// The browser reaches only these hosts, through a proxy of this session (agent-proxy.ts): the
	// session's own, and those an admin added for what the application loads from elsewhere.
	const extra = (process.env.TEST_APP_PLANNER_HOSTS ?? '')
		.split(',')
		.map((host) => host.trim().toLowerCase())
		.filter(Boolean);
	const hosts = new Set([...target.limits.hosts, ...extra]);
	let proxy: HostProxy;
	try {
		// The session's own host on the port of its address; an added host on the port it names,
		// else on 443.
		proxy = await startHostProxy(
			new Set([
				...target.endpoints,
				...extra.flatMap((host) => endpointOf(`https://${host}`) ?? [])
			])
		);
	} catch (e) {
		return { ok: false, error: `The planner's proxy could not start: ${errorText(e)}` };
	}
	const refuse = (error: string) => {
		proxy.close();
		return { ok: false as const, error };
	};
	// Checked after the last await: nothing below yields, so two requests cannot both start.
	if (activePlanning()) return refuse('The planner is working already.');
	const healing = activeHealing();
	if (healing) return refuse(`The healer is working on "${healing.title}".`);
	if (activeRunId()) return refuse('A run is going; start the planner when it has finished.');
	const unread = reviewBlock();
	if (unread) return refuse(unread);

	const id = newId();
	const files = sessionFiles(id);
	if (!files) return refuse('The session could not be created.');
	const redact = redactor(settings.secrets);
	const allowed = new Set(agent.tools);
	const abort = new AbortController();
	const browserFilesBefore = browserFiles();
	// A password typed into the description reaches neither the model nor the page nor a log.
	const task = redact(plannerTask(flow, target.start));
	const state: PlannerState = {
		id,
		flow: redact(flow),
		target: redact(target.target),
		status: 'running',
		startedAt: new Date().toISOString(),
		activity: []
	};
	try {
		save(state);
	} catch (e) {
		return refuse(`The session could not be saved: ${errorText(e)}`);
	}
	active = { state, abort };
	setPlanning(state.flow);
	pruneSessions();

	const note = (line: string) => {
		state.activity.push(redact(line));
		if (state.activity.length > ACTIVITY_TAIL)
			state.activity.splice(0, state.activity.length - ACTIVITY_TAIL);
	};

	// Every tool call passes here, also the ones the agent file allows (planner-rules.ts).
	const gate: HookCallback = (hook) => {
		if (hook.hook_event_name !== 'PreToolUse') return Promise.resolve({});
		const args = toolInput(hook.tool_input);
		const decision = plannerDecision(hook.tool_name, args, APP_ROOT, allowed, {
			...target.limits,
			outputDir: files.output,
			...(state.plan ? { ownPlan: state.plan } : {})
		});
		if (!decision.allow) {
			note(`Not allowed: ${describePlannerTool(hook.tool_name, args)} (${decision.reason})`);
			return Promise.resolve({
				hookSpecificOutput: {
					hookEventName: 'PreToolUse',
					permissionDecision: 'deny',
					permissionDecisionReason: decision.reason
				}
			});
		}
		if ('plan' in decision) {
			state.plan = decision.plan;
			save(state);
		}
		return Promise.resolve({
			hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' }
		});
	};

	// What a tool returns (a page, a file) is masked as healer-mask.ts masks the server's answers,
	// before the model sees it.
	const mask = masker(settings.secrets);
	const afterTool: HookCallback = (hook) => {
		if (hook.hook_event_name !== 'PostToolUse') return Promise.resolve({});
		try {
			save(state);
		} catch {
			// The page shows the activity from memory; the next save may work again.
		}
		return Promise.resolve({
			hookSpecificOutput: {
				hookEventName: 'PostToolUse',
				updatedToolOutput: mask.deep(hook.tool_response)
			}
		});
	};

	const finish = (status: PlannerState['status'], error?: string) => {
		if (state.finishedAt) return;
		process.off('exit', stopWithApp);
		state.status = status;
		if (error) state.error = redact(error);
		state.finishedAt = new Date().toISOString();
		// First what others wait for: a failing disk below must not keep runs, the healer and the
		// planner blocked.
		proxy.close();
		if (active?.state === state) {
			active = null;
			setPlanning(null);
		}
		try {
			// A plan it named but never saved.
			if (state.plan && !existsSync(resolve(APP_ROOT, state.plan))) delete state.plan;
			save(state);
			moveBrowserFiles(browserFilesBefore, files.browser);
		} catch {
			// The session is over either way; its page shows what was saved last.
		}
		removeBrowserData(id);
		// Again once the MCP server has closed and written the seed test's results.
		setTimeout(() => {
			removeBrowserData(id);
		}, LATE_RESULTS_MS).unref();
	};
	const stopWithApp = () => {
		abort.abort();
	};
	process.once('exit', stopWithApp);

	const budget = Number(process.env.TEST_APP_PLANNER_BUDGET_USD) || DEFAULT_BUDGET_USD;
	let messages: AsyncIterable<SDKMessage>;
	try {
		messages = query({
			prompt: task,
			options: {
				...healerOptions(agent, {
					budget,
					abort,
					hooks: {
						PreToolUse: [{ hooks: [gate], onFailure: 'block' }],
						PostToolUse: [{ hooks: [afterTool], onFailure: 'block' }]
					},
					// The test users' passwords go to the MCP server only, which signs in with them.
					serverEnv: {
						...settings.env,
						...idocTestEnv(),
						SAP_TESTS_OUTPUT_DIR: files.output,
						// The seed test keeps the browser on these hosts (sap-plugin/agent-hosts.ts), with
						// those an admin added for what the application loads from elsewhere.
						SAP_AGENT_HOSTS: [...hosts].join(','),
						SAP_AGENT_PROXY: proxy.url,
						FORCE_COLOR: '0'
					},
					secrets: settings.secrets
				}),
				maxTurns: MAX_TURNS
			}
		});
	} catch (e) {
		finish('failed', errorText(e));
		return { ok: false, error: `The planner could not start: ${redact(errorText(e))}` };
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
				if (block.type === 'tool_use')
					note(describePlannerTool(block.name, toolInput(block.input)));
			}
		} else if (message.type === 'result') {
			state.costUsd = message.total_cost_usd;
			// A turn that ended on an API error is a 'success' with is_error: its text is the error.
			if (message.subtype === 'success' && message.is_error)
				state.error = redact(message.result || 'The AI provider answered with an error.');
			else if (message.subtype === 'success') state.report = redact(message.result);
			else
				state.error = redact(
					message.subtype === 'error_max_budget_usd'
						? `Stopped at the budget of $${budget} (TEST_APP_PLANNER_BUDGET_USD).`
						: message.subtype === 'error_max_turns'
							? `Stopped after ${MAX_TURNS} turns.`
							: message.errors.join('\n') || 'The planner stopped with an error.'
				);
		}
	}

	return { ok: true, id, flow: state.flow };
}

export function stopPlanning(id: string): boolean {
	if (active?.state.id !== id) return false;
	active.abort.abort();
	return true;
}
