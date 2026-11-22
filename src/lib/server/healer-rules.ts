import { existsSync, realpathSync } from 'node:fs';
import nodePath from 'node:path';
import { toPosix, within } from './paths.js';

/** The parts of an agent file (.claude/agents/*.md) the healer needs. */
export type AgentFile = { tools: string[]; model?: string; prompt: string };

/**
 * Reads an agent file as Claude Code does: YAML front matter between two `---` lines (only the
 * plain `key: value` lines `tools` and `model` are used), then the prompt. The comment that notes
 * where the file came from is not part of the prompt.
 */
export function parseAgentFile(source: string): AgentFile {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
	if (!match) throw new Error('The agent file has no front matter.');
	const [, head = '', body = ''] = match;
	const field = (name: string) =>
		new RegExp(`^${name}:[ \\t]*(.*)$`, 'm').exec(head)?.[1]?.trim() || undefined;
	const tools = (field('tools') ?? '')
		.split(',')
		.map((t) => t.trim())
		.filter(Boolean);
	if (tools.length === 0) throw new Error('The agent file lists no tools.');
	const prompt = body.replace(/^\s*<!--[\s\S]*?-->\s*/, '').trim();
	if (!prompt) throw new Error('The agent file has no prompt.');
	return { tools, model: field('model'), prompt };
}

/** Folders the healer may read and search, relative to the repository root. */
const READ_DIRS = [
	'sap-tests/tests',
	'sap-tests/helpers',
	'sap-tests/sap-plugin',
	'sap-tests/specs',
	'sap-tests/setup',
	'sap-tests/test-results',
	// The browser tools' console logs and snapshots, which their answers link to.
	'.playwright-mcp'
];
/** Single files it may read besides. */
const READ_FILES = new Set([
	'sap-tests/CLAUDE.md',
	'sap-tests/playwright.config.ts',
	'sap-tests/systems.json',
	'sap-tests/tsconfig.json'
]);
/** Folders it may change files in. */
const WRITE_DIRS = ['sap-tests/tests', 'sap-tests/helpers'];
/** What the healer's own instructions keep it out of; here it is enforced. */
const WRITE_EXCLUDED = [
	'sap-tests/tests/_demo',
	'sap-tests/tests/_plugin',
	'sap-tests/tests/_reference',
	'sap-tests/tests/_agents',
	'sap-tests/tests/fiori/rule-findings.example.spec.ts'
];

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS']);
/**
 * Runs code in the MCP server's process, which holds the test users' passwords, and reads any file
 * through its `filename`: never allowed, whatever the agent file lists. The healer tries locators
 * with browser_evaluate, which runs in the page.
 */
const DENIED_MCP_TOOLS = new Set(['mcp__playwright-test__browser_run_code_unsafe']);
const RESPONSE_PARTS = new Set(['response-headers', 'response-body']);
/** Playwright's raw recordings of a test: the network with its cookies, the trace, the video. */
const RAW_RECORDING = /(^|\/)\.playwright-artifacts|\.(network|trace|zip|webm|stacks)$/;
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

export type ToolDecision = { allow: true; writes?: string } | { allow: false; reason: string };

const inside = (rel: string, dir: string) => rel === dir || rel.startsWith(dir + '/');

/**
 * The path as the repository-relative posix form, following symbolic links of what exists, or
 * null when it lies outside the repository.
 */
function repoPath(root: string, raw: string): { abs: string; rel: string } | null {
	const abs = within(root, raw);
	if (!abs) return null;
	const real = realPath(abs);
	if (!real) return null;
	const realRoot = existsSync(root) ? realpathSync(root) : root;
	const checked = within(realRoot, nodePath.relative(realRoot, real));
	if (!checked) return null;
	return { abs, rel: toPosix(nodePath.relative(realRoot, real)) };
}

/**
 * The path with the symbolic links of what exists followed. A file about to be written may not
 * exist yet: the links of its nearest existing folder are followed.
 */
function realPath(abs: string): string | null {
	let existing = abs;
	while (!existsSync(existing) && nodePath.dirname(existing) !== existing)
		existing = nodePath.dirname(existing);
	try {
		return nodePath.join(realpathSync(existing), nodePath.relative(existing, abs));
	} catch {
		return null;
	}
}

/** Whether the path lies in the folder (absolute), both with their links followed. */
function insideFolder(raw: string, root: string, folder: string): boolean {
	const real = realPath(nodePath.resolve(root, raw));
	const realFolder = realPath(folder);
	return !!real && !!realFolder && within(realFolder, nodePath.relative(realFolder, real)) !== null;
}

/** A name that holds passwords or a signed-in session, wherever it is. */
function secretName(rel: string): boolean {
	return rel.split('/').some((part) => part.startsWith('.env') || part === '.auth');
}

/** A tool call's input as Claude Code passes it: JSON whose shape depends on the tool. */
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- tool inputs are untyped JSON from the model; each field is checked where it is read
export type ToolInput = Record<string, unknown>;

/** The input of a tool call, or an empty one when it is not an object. */
export function toolInput(value: unknown): ToolInput {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: {};
}

const text = (input: ToolInput, key: string) =>
	typeof input[key] === 'string' ? input[key] : undefined;

/**
 * Whether the healer may make this tool call. Only the tools its agent file lists are allowed.
 * Reading and searching stay inside the test project's code (never a settings file or a saved
 * session), changes inside sap-tests/tests and sap-tests/helpers, outside the folders the healer
 * must not touch. `outputDir` holds the results of the test runs it starts, which it may read too.
 * `writes` is the file a change is about to modify.
 */
export function toolDecision(
	tool: string,
	input: ToolInput,
	root: string,
	allowed: ReadonlySet<string>,
	outputDir?: string
): ToolDecision {
	if (!allowed.has(tool) || DENIED_MCP_TOOLS.has(tool))
		return { allow: false, reason: `${tool} is not one of the healer's tools.` };
	if (tool.startsWith('mcp__playwright-test__')) {
		// Saving to or reading from a file through the browser tools passes no check of the paths.
		if (input.filename !== undefined)
			return { allow: false, reason: 'Do not save to files; take the result as the answer.' };
		// A request's headers and body hold the session cookies and, at the sign-in, the password.
		if (
			tool === 'mcp__playwright-test__browser_network_request' &&
			!RESPONSE_PARTS.has(String(input.part))
		)
			return {
				allow: false,
				reason: 'Look at a request only with part "response-headers" or "response-body".'
			};
		return { allow: true };
	}
	if (READ_TOOLS.has(tool)) {
		const raw = text(input, 'file_path') ?? text(input, 'path');
		if (!raw)
			return {
				allow: false,
				reason: `Give ${tool} a path inside ${READ_DIRS.join(', ')}.`
			};
		// A search pattern must not climb out of the folder it searches.
		for (const key of ['pattern', 'glob']) {
			const value = tool === 'Grep' && key === 'pattern' ? undefined : text(input, key);
			if (value && (value.includes('..') || nodePath.isAbsolute(value)))
				return { allow: false, reason: `The ${key} must stay inside the folder searched.` };
		}
		if (outputDir && insideFolder(raw, root, outputDir))
			return tool === 'Read' && !secretName(toPosix(raw)) && !RAW_RECORDING.test(toPosix(raw))
				? { allow: true }
				: {
						allow: false,
						reason:
							'In the results of its test runs, read the files the tools name (error-context.md); do not search them.'
					};
		const path = repoPath(root, raw);
		if (!path || secretName(path.rel))
			return { allow: false, reason: `${raw} is not something the healer may read.` };
		const ok =
			READ_DIRS.some((d) => inside(path.rel, d)) || (tool === 'Read' && READ_FILES.has(path.rel));
		return ok
			? { allow: true }
			: { allow: false, reason: `Read only inside ${READ_DIRS.join(', ')}.` };
	}
	if (WRITE_TOOLS.has(tool)) {
		const raw = text(input, 'file_path');
		const path = raw ? repoPath(root, raw) : null;
		if (!raw || !path || secretName(path.rel))
			return { allow: false, reason: 'Change only test files.' };
		if (!WRITE_DIRS.some((d) => inside(path.rel, d)) || !path.rel.endsWith('.ts'))
			return {
				allow: false,
				reason: 'Change only .ts files in sap-tests/tests and sap-tests/helpers.'
			};
		if (WRITE_EXCLUDED.some((d) => inside(path.rel, d)))
			return { allow: false, reason: `${path.rel} is not to be touched by the healer.` };
		return { allow: true, writes: path.abs };
	}
	return { allow: false, reason: `${tool} is not available to the healer.` };
}

/** One line of the healer's progress, for a tool call. Paths are shown from the repository root. */
export function describeTool(tool: string, input: ToolInput, root: string): string {
	const raw = text(input, 'file_path') ?? text(input, 'path') ?? '';
	const inRepo = raw ? within(root, raw) : null;
	const path = inRepo ? toPosix(nodePath.relative(root, inRepo)) || '.' : raw;
	const name = tool.replace(/^mcp__playwright-test__/, '');
	switch (name) {
		case 'Read':
			return `Reads ${path}`;
		case 'Glob':
		case 'Grep':
		case 'LS':
			return `Searches ${path || 'the files'}`;
		case 'Edit':
		case 'MultiEdit':
		case 'Write':
			return `Changes ${path}`;
		case 'test_run':
			return 'Runs the test';
		case 'test_debug':
			return 'Runs the test and pauses where it fails';
		case 'test_list':
			return 'Lists the tests';
		case 'browser_snapshot':
			return 'Looks at the page';
		case 'browser_evaluate':
		case 'browser_run_code_unsafe':
			return 'Inspects the page';
		case 'browser_generate_locator':
			return 'Asks Playwright for a locator';
		case 'browser_console_messages':
			return 'Reads the browser console';
		case 'browser_network_requests':
		case 'browser_network_request':
			return 'Reads the network requests';
		default:
			return name;
	}
}

const CONTEXT = 3;

/**
 * A unified diff of two texts, line by line (longest common subsequence; test files are small).
 * Empty when they are equal. `null` stands for a file that does not exist.
 */
export function unifiedDiff(before: string | null, after: string | null, name: string): string {
	if (before === after) return '';
	const a = before === null ? [] : before.split('\n');
	const b = after === null ? [] : after.split('\n');
	// lcs[i][j]: length of the common subsequence of a[i..] and b[j..].
	const lcs = Array.from({ length: a.length + 1 }, () =>
		Array.from({ length: b.length + 1 }, () => 0)
	);
	for (let i = a.length - 1; i >= 0; i--)
		for (let j = b.length - 1; j >= 0; j--)
			lcs[i]![j] =
				a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
	type Op = { kind: ' ' | '-' | '+'; line: string; ai: number; bi: number };
	const ops: Op[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		if (i < a.length && j < b.length && a[i] === b[j]) {
			ops.push({ kind: ' ', line: a[i]!, ai: i, bi: j });
			i++;
			j++;
		} else if (i < a.length && (j >= b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
			// Removed lines before added ones, as git shows them.
			ops.push({ kind: '-', line: a[i]!, ai: i, bi: j });
			i++;
		} else {
			ops.push({ kind: '+', line: b[j]!, ai: i, bi: j });
			j++;
		}
	}
	const out = [
		`--- ${before === null ? '/dev/null' : name}`,
		`+++ ${after === null ? '/dev/null' : name}`
	];
	let k = 0;
	while (k < ops.length) {
		if (ops[k]!.kind === ' ') {
			k++;
			continue;
		}
		// A hunk: from CONTEXT lines before this change to CONTEXT lines after the last change that
		// is less than 2 * CONTEXT unchanged lines away.
		const start = Math.max(0, k - CONTEXT);
		let end = k;
		let quiet = 0;
		for (let m = k; m < ops.length; m++) {
			if (ops[m]!.kind === ' ') {
				quiet++;
				if (quiet > 2 * CONTEXT) break;
			} else {
				quiet = 0;
				end = m;
			}
		}
		const stop = Math.min(ops.length, end + CONTEXT + 1);
		const hunk = ops.slice(start, stop);
		const aLines = hunk.filter((o) => o.kind !== '+').length;
		const bLines = hunk.filter((o) => o.kind !== '-').length;
		const first = hunk[0]!;
		out.push(
			`@@ -${aLines ? first.ai + 1 : first.ai},${aLines} +${bLines ? first.bi + 1 : first.bi},${bLines} @@`
		);
		for (const o of hunk) out.push(o.kind + o.line);
		k = stop;
	}
	return out.join('\n');
}
