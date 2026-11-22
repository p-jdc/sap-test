// `bun run agents`: writes the GitHub Copilot (VS Code) and Codex versions of the Playwright test
// agents from the Claude Code files in .claude/agents, which are the ones to edit. `--check` writes
// nothing and fails when a generated file is out of date (pregate runs it).
//
// The formats are those of `playwright init-agents --loop=vscode` and `--loop=codex`
// (Playwright 1.63): the same prompt, the tools named the way each tool names them.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROLES = ['planner', 'generator', 'healer'] as const;

/** The parts of a Claude Code agent file that the other formats carry over. */
export interface Agent {
	name: string;
	description: string;
	tools: string[];
	prompt: string;
}

const MCP_PREFIX = 'mcp__playwright-test__';
const READ_TOOLS = new Set(['Glob', 'Grep', 'Read', 'LS']);
const WRITE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);

/**
 * The arguments that start Playwright's MCP server with node. Its two files are given from the
 * repository root, after `base` where a tool needs them absolute; the subcommand and the flag stay
 * as they are.
 */
export const mcpArgs = (base = '') => [
	`${base}node_modules/@playwright/test/cli.js`,
	'run-test-mcp-server',
	'-c',
	`${base}sap-tests/playwright.config.ts`
];
const MCP_ARGS = mcpArgs();

/** A YAML scalar of the front matter: plain, or in single quotes with '' for a quote. */
function scalar(raw: string): string {
	const value = raw.trim();
	return value.startsWith("'") && value.endsWith("'")
		? value.slice(1, -1).replaceAll("''", "'")
		: value;
}

export function parseAgent(source: string): Agent {
	const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source);
	if (!match) throw new Error('The agent file has no front matter.');
	const [, head = '', body = ''] = match;
	const field = (key: string) => {
		const value = new RegExp(`^${key}:(.*)$`, 'm').exec(head)?.[1];
		if (value === undefined) throw new Error(`The agent file has no ${key}.`);
		return scalar(value);
	};
	const tools = field('tools')
		.split(',')
		.map((t) => t.trim())
		.filter(Boolean);
	for (const tool of tools)
		if (!tool.startsWith(MCP_PREFIX) && !READ_TOOLS.has(tool) && !WRITE_TOOLS.has(tool))
			throw new Error(`No Copilot or Codex counterpart is known for the tool ${tool}.`);
	// The comment on where the file came from belongs to the Claude Code file only.
	const prompt = body.replace(/^\s*<!--[\s\S]*?-->\s*/, '').trim();
	return { name: field('name'), description: field('description'), tools, prompt };
}

const mcpTools = (agent: Agent) =>
	agent.tools.filter((t) => t.startsWith(MCP_PREFIX)).map((t) => t.slice(MCP_PREFIX.length));
const writes = (agent: Agent) => agent.tools.some((t) => WRITE_TOOLS.has(t));

interface Target {
	/** How the prompt names the MCP tools. */
	tools: string;
	/** Where the MCP server comes from and how to see its state. */
	server: string;
	/** Rules for what this tool has beyond the agent file's tools, if anything. */
	extra?: string;
}

/** Replaces text that must be there: when the Claude Code file changes it, this script must too. */
function replaceOnce(text: string, from: string, to: string): string {
	if (!text.includes(from)) throw new Error(`The prompt no longer says: ${from}`);
	return text.replace(from, to);
}

/** The prompt with what is particular to Claude Code put in this tool's terms. */
export function adaptPrompt(prompt: string, target: Target): string {
	let text = replaceOnce(prompt, 'the `mcp__playwright-test__*` tools', target.tools);
	text = replaceOnce(
		text,
		'it connects when a new Claude Code session starts at the\nrepository root (`/mcp` shows its state).',
		`${target.server}\n\n` +
			'Never open, print or copy `sap-tests/.env` or anything in a `.auth` folder: they hold passwords and\n' +
			'signed-in sessions. The tests and the MCP server read them themselves.' +
			(target.extra ? `\n\n${target.extra}` : '')
	);
	return text;
}

const COPILOT: Target = {
	tools: 'the `playwright-test` tools',
	server:
		'it is set up in `.vscode/mcp.json` and starts when VS Code has the\n' +
		'repository root open and the server is trusted (the command "MCP: List Servers" shows its state).'
};

const CODEX: Target = {
	tools: 'the `playwright-test` tools',
	server:
		"it is set up in this agent's `mcp_servers.playwright-test` entry and starts\n" +
		'when Codex runs at the repository root (`/mcp` shows its state).',
	extra:
		'You have a shell, which the Claude Code version of this agent does not. Use it only to read and search files\n' +
		'in `sap-tests` (`rg`, `sed -n`, `cat`), never the files named above. Run tests and look at pages only through the\n' +
		'`playwright-test` tools, never with `playwright` or `npx` in the shell. Do not run git, install anything or\n' +
		'start servers. Change files only with your patch tool, and only where this file allows it.'
};

const yamlQuoted = (value: string) => `'${value.replaceAll("'", "''")}'`;

export function copilotAgent(agent: Agent, source: string): string {
	const tools = [
		...(agent.tools.some((t) => READ_TOOLS.has(t)) ? ['search'] : []),
		...(writes(agent) ? ['edit'] : []),
		...mcpTools(agent).map((t) => `playwright-test/${t}`)
	];
	return [
		'---',
		`name: ${agent.name}`,
		`description: ${yamlQuoted(agent.description)}`,
		'tools:',
		...tools.map((t) => `  - ${t}`),
		'mcp-servers:',
		'  playwright-test:',
		'    type: stdio',
		'    command: node',
		'    args:',
		...MCP_ARGS.map((a) => `      - ${a}`),
		'    tools:',
		"      - '*'",
		'---',
		'',
		`<!-- Generated by \`bun run agents\` from ${source}. Edit that file, not this one. -->`,
		'',
		adaptPrompt(agent.prompt, COPILOT),
		''
	].join('\n');
}

/** A TOML basic string; JSON's escapes are valid in TOML. */
const tomlString = (value: string) => JSON.stringify(value);

export function codexAgent(agent: Agent, source: string): string {
	const prompt = adaptPrompt(agent.prompt, CODEX);
	// A literal string keeps the prompt as it is, backslashes included; it cannot hold '''.
	if (prompt.includes("'''")) throw new Error(`${source}: the prompt must not contain '''.`);
	return [
		`# Generated by \`bun run agents\` from ${source}. Edit that file, not this one.`,
		`name = ${tomlString(agent.name.replaceAll('-', '_'))}`,
		`description = ${tomlString(agent.description)}`,
		// The planner and the generator write only through the MCP server; the healer edits tests.
		`sandbox_mode = ${tomlString(writes(agent) ? 'workspace-write' : 'read-only')}`,
		`developer_instructions = '''`,
		prompt,
		`'''`,
		'',
		'[mcp_servers.playwright-test]',
		'command = "node"',
		`args = [${MCP_ARGS.map((v) => tomlString(v)).join(', ')}]`,
		`enabled_tools = [${mcpTools(agent)
			.map((v) => tomlString(v))
			.join(', ')}]`,
		''
	].join('\n');
}

/** VS Code's MCP servers for this workspace: the one the Copilot agents use. */
export function vscodeMcp(): string {
	const server = {
		type: 'stdio',
		command: 'node',
		args: mcpArgs('${workspaceFolder}/'),
		cwd: '${workspaceFolder}'
	};
	return `${JSON.stringify({ servers: { 'playwright-test': server } }, null, '\t')}\n`;
}

/** Every generated file, by its path from the repository root. */
export function generate(root: string): Map<string, string> {
	const files = new Map<string, string>();
	for (const role of ROLES) {
		const source = `.claude/agents/playwright-test-${role}.md`;
		const agent = parseAgent(readFileSync(join(root, source), 'utf8'));
		files.set(`.github/agents/playwright-test-${role}.agent.md`, copilotAgent(agent, source));
		files.set(`.codex/agents/playwright_test_${role}.toml`, codexAgent(agent, source));
	}
	files.set('.vscode/mcp.json', vscodeMcp());
	return files;
}

if (import.meta.main) {
	const root = join(import.meta.dir, '..');
	const check = process.argv.includes('--check');
	const stale: string[] = [];
	for (const [path, content] of generate(root)) {
		const file = join(root, path);
		const current = existsSync(file) ? readFileSync(file, 'utf8') : null;
		if (current === content) continue;
		stale.push(path);
		if (!check) {
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, content);
		}
	}
	if (check && stale.length > 0) {
		console.log(`Out of date, run \`bun run agents\`: ${stale.join(', ')}`);
		process.exit(1);
	}
	console.log(
		stale.length === 0
			? 'The Copilot and Codex agents are up to date.'
			: `Written: ${stale.join(', ')}`
	);
}
