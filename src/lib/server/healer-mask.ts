// Sits between Claude Code and the healer's MCP server and masks what the server answers, before
// the model sees it: every reply, also the ones that end as an error (Claude Code's PostToolUse
// hook does not see those). The test users' passwords come in HEALER_MASK (a JSON list), which the
// server does not get.
//
//   bun healer-mask.ts <command> <arguments…>
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { redactor } from './redact.js';

const MASK = '***';
/** Header lines that carry a session or a login, as the browser tools print them. */
const SECRET_HEADER =
	/^(\s*(?:cookie|set-cookie|authorization|proxy-authorization|x-csrf-token)\s*:\s*)/i;
/** A line that starts another header (`name: value`). */
const HEADER = /^\s*[\w-]+\s*:\s/;

/**
 * Masks the value of a secret header, and the lines after it that are not another header:
 * Playwright prints several Set-Cookie values one per line under one name.
 */
function maskHeaders(s: string): string {
	let inSecret = false;
	return s
		.split('\n')
		.map((line) => {
			const secret = SECRET_HEADER.exec(line);
			if (secret) {
				inSecret = true;
				return `${secret[1]}${MASK}`;
			}
			if (inSecret && line.trim() !== '' && !HEADER.test(line)) return MASK;
			inSecret = false;
			return line;
		})
		.join('\n');
}
/** SAP's session and single sign-on cookies, wherever they appear (document.cookie, a header). */
const SAP_COOKIE =
	/\b(MYSAPSSO2|SAP_SESSIONID_\w+|sap-usercontext|SAP_SSO\w*|JSESSIONID)=[^;\s"',]+/g;

/**
 * Masks the passwords as they are, as a URL or a form sends them, and the session cookies and
 * login headers, in a string and in the strings of a JSON value.
 */
export function masker(secrets: readonly string[]) {
	const forms = secrets
		.filter(Boolean)
		.flatMap((s) => [s, encodeURIComponent(s), new URLSearchParams({ v: s }).toString().slice(2)]);
	const redact = redactor(forms);
	const text = (s: string) => maskHeaders(redact(s)).replaceAll(SAP_COOKIE, `$1=${MASK}`);
	const deep = (value: unknown): unknown => {
		if (typeof value === 'string') return text(value);
		if (Array.isArray(value)) return value.map((item) => deep(item));
		if (value !== null && typeof value === 'object')
			return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, deep(v)]));
		return value;
	};
	/** One line of the server's output: a JSON-RPC message, or text. */
	const line = (raw: string) => {
		try {
			return JSON.stringify(deep(JSON.parse(raw)));
		} catch {
			return text(raw);
		}
	};
	return { text, deep, line };
}

if (import.meta.main) {
	const { HEALER_MASK, HEALER_CWD, ...env } = process.env;
	const secrets = z.array(z.string()).parse(JSON.parse(HEALER_MASK ?? '[]'));
	const [command, ...args] = process.argv.slice(2);
	if (!command) throw new Error('Usage: bun healer-mask.ts <command> <arguments…>');
	const mask = masker(secrets);
	// The folder a run starts Playwright in: its config loads the settings file from there.
	const server = spawn(command, args, {
		stdio: ['pipe', 'pipe', 'pipe'],
		env,
		cwd: HEALER_CWD || process.cwd()
	});
	process.stdin.pipe(server.stdin);
	createInterface({ input: server.stdout }).on('line', (l) => {
		process.stdout.write(`${mask.line(l)}\n`);
	});
	createInterface({ input: server.stderr }).on('line', (l) => {
		process.stderr.write(`${mask.text(l)}\n`);
	});
	server.on('exit', (code) => process.exit(code ?? 1));
	for (const signal of ['SIGTERM', 'SIGINT'] as const)
		process.on(signal, () => {
			server.kill(signal);
		});
}
