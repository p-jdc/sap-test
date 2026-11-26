import { existsSync } from 'node:fs';
import nodePath from 'node:path';
import { toolDecision, type ToolDecision, type ToolInput } from './healer-rules.js';
import { toPosix, within } from './paths.js';

/** The seed tests the planner starts from (sap-tests/tests/_agents), from the repository root. */
export const BLANK_SEED = 'sap-tests/tests/_agents/seed.spec.ts';
export const SIGNED_IN_SEED = 'sap-tests/tests/_agents/seed-signed-in.spec.ts';
/** Where plans go, from the repository root. */
export const PLANS_DIR = 'sap-tests/specs';

const MCP = 'mcp__playwright-test__';
const PLAN_NAME = /^[a-z0-9][a-z0-9._-]{0,80}\.plan\.md$/;

/** What one planner session may do, beyond the rules every agent of the app has. */
export type PlannerLimits = {
	/** The seed test and its project, as the session was started: blank, or signed in to a system. */
	seed: { file: string; project: string };
	/** The hosts the planner may open itself: the address it was given, the system's address. */
	hosts: ReadonlySet<string>;
	/** The plan this session saved before, which it may save again. */
	ownPlan?: string;
	/** The results folder of the seed test it starts. */
	outputDir?: string;
};

export type PlannerDecision = ToolDecision | { allow: true; plan: string };

const text = (input: ToolInput, key: string) =>
	typeof input[key] === 'string' ? input[key] : undefined;

/** The host of an http(s) address, or null for anything else (a file, a script, no address). */
export function webHost(address?: string): string | null {
	if (!address) return null;
	try {
		const url = new URL(address);
		return url.protocol === 'http:' || url.protocol === 'https:' ? url.host : null;
	} catch {
		return null;
	}
}

/**
 * Whether the planner may make this tool call. On top of the rules of healer-rules.ts (only the
 * tools its agent file lists, no `browser_run_code_unsafe`, no file given to a browser tool, reads
 * only inside the test code): it starts only the seed test of its session, opens only the hosts it
 * was sent to, uploads no file, and saves one plan, as a new `<name>.plan.md` in sap-tests/specs.
 * `plan` is the plan file a save is about to write, from the repository root.
 */
export function plannerDecision(
	tool: string,
	input: ToolInput,
	root: string,
	allowed: ReadonlySet<string>,
	limits: PlannerLimits
): PlannerDecision {
	const general = toolDecision(tool, input, root, allowed, limits.outputDir);
	if (!general.allow) return general;
	switch (tool) {
		case `${MCP}planner_setup_page`: {
			// The seed is test code that runs with the test users' passwords: only the one of this
			// session, in its project.
			const seed = text(input, 'seedFile');
			const file = seed ? within(root, seed) : null;
			if (
				!file ||
				toPosix(nodePath.relative(root, file)) !== limits.seed.file ||
				input.project !== limits.seed.project
			)
				return {
					allow: false,
					reason: `Set up the page with seedFile "${limits.seed.file}" and project "${limits.seed.project}".`
				};
			return { allow: true };
		}
		case `${MCP}browser_navigate`: {
			const host = webHost(text(input, 'url'));
			if (!host || !limits.hosts.has(host))
				return {
					allow: false,
					reason: `Open only addresses on ${[...limits.hosts].join(', ')}; reach other pages through the application's own links.`
				};
			return { allow: true };
		}
		// Sends a file of this computer to the application.
		case `${MCP}browser_file_upload`:
			return { allow: false, reason: 'Uploading files is not available in this app.' };
		case `${MCP}planner_save_plan`: {
			const name = text(input, 'fileName');
			const file = name ? within(root, name) : null;
			const rel = file ? toPosix(nodePath.relative(root, file)) : '';
			if (
				!file ||
				nodePath.posix.dirname(rel) !== PLANS_DIR ||
				!PLAN_NAME.test(nodePath.posix.basename(rel))
			)
				return {
					allow: false,
					reason: `Save the plan as ${PLANS_DIR}/<process>.plan.md (lower-case letters, digits and hyphens).`
				};
			// A plan that is already there is a person's, or another session's.
			if (existsSync(file) && rel !== limits.ownPlan)
				return {
					allow: false,
					reason: `${rel} exists already; choose another file name.`
				};
			return { allow: true, plan: rel };
		}
		default:
			return general;
	}
}

const quoted = (value: unknown) =>
	typeof value === 'string' && value ? ` “${value.slice(0, 80)}”` : '';

/** One line of the planner's progress, for a tool call. */
export function describePlannerTool(tool: string, input: ToolInput): string {
	const name = tool.replace(MCP, '');
	switch (name) {
		case 'planner_setup_page':
			return 'Opens the browser';
		case 'planner_save_plan':
			return `Saves the plan${quoted(input.fileName)}`;
		case 'browser_navigate':
			return `Opens${quoted(input.url)}`;
		case 'browser_navigate_back':
			return 'Goes back';
		case 'browser_snapshot':
			return 'Looks at the page';
		case 'browser_take_screenshot':
			return 'Takes a screenshot';
		case 'browser_click':
			return `Clicks${quoted(input.element)}`;
		case 'browser_hover':
			return `Points at${quoted(input.element)}`;
		case 'browser_type':
			return `Types into${quoted(input.element)}`;
		case 'browser_select_option':
			return `Chooses in${quoted(input.element)}`;
		case 'browser_press_key':
			return `Presses${quoted(input.key)}`;
		case 'browser_drag':
			return 'Drags an element';
		case 'browser_handle_dialog':
			return 'Answers a dialog';
		case 'browser_wait_for':
			return 'Waits for the page';
		case 'browser_evaluate':
			return 'Inspects a control';
		case 'browser_console_messages':
			return 'Reads the browser console';
		case 'browser_network_requests':
		case 'browser_network_request':
			return 'Reads the network requests';
		case 'browser_close':
			return 'Closes the browser';
		case 'Read':
		case 'Glob':
		case 'Grep':
		case 'LS':
			return 'Reads the test code';
		default:
			return name;
	}
}
