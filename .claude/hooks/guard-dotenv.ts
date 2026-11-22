// PreToolUse hook for Bash and Monitor: refuses shell commands that name a real .env file.
//
// .claude/settings.json already denies the Read, Edit and Write tools on sap-tests/.env, which
// holds the SAP passwords. Without this hook `cat sap-tests/.env` still prints them into the
// session, and `> sap-tests/.env` overwrites them.
//
// It is a tripwire, not a wall: it reads the command text, so a path built by a glob or a variable
// (`cat sap-tests/.e*`), or a search of the whole folder (`grep -r PASSWORD sap-tests`), gets past
// it. It stops the file being named outright.
//
// It cannot tell a file name from a mention of it: a commit message that says ".env", or a search
// for `'\.env'`, is refused too. The refusal says how to pass such text in a file.
//
// When it cannot decide (unreadable input, an error) it refuses.

/**
 * `.env`, or `.env.<suffix>` such as `.env.local`, as a file name of its own: not `process.env`,
 * `.envrc`, `.environment` or `--env-file`. Whatever follows that cannot continue a file name ends
 * it (`.env:`, `.env,`, `.env}`), and the case does not matter (one file on macOS).
 */
const ENV_FILE = /(?<![A-Za-z0-9_.-])\.env((?:\.[A-Za-z0-9_-]+)*)(?![A-Za-z0-9_-])/gi;

/** Templates and test settings that are checked in (as in app/.gitignore). */
const CHECKED_IN = new Set(['.example', '.test']);

/**
 * Commands that only ask whether the file is there or tracked. Allowed when the whole command is
 * one of them on one line, so nothing can be chained behind; `2>/dev/null` may follow.
 */
const HARMLESS =
	/^[ \t]*(?:ls(?:[ \t]+-[A-Za-z]+)*|test[ \t]+-[ef]|\[[ \t]+-[ef]|stat|git[ \t]+(?:check-ignore|status|ls-files))(?:[ \t]+[^\s|;&<>`$(){}]+)*(?:[ \t]+\])?(?:[ \t]+2>[ \t]*\/dev\/null)?[ \t]*$/;

function namesEnvFile(command: string): boolean {
	const text = command
		// `\.env` is the same name to the shell.
		.replaceAll(/\\+(?=\.env)/gi, '')
		// An option with the name attached: `grep -f.env`.
		.replaceAll(/(^|\s)-[A-Za-z]+(?=\.env)/gi, '$1');
	return [...text.matchAll(ENV_FILE)].some(([, suffix]) => !CHECKED_IN.has(suffix.toLowerCase()));
}

export function refusal(command: string): string | undefined {
	if (!namesEnvFile(command)) return undefined;
	if (!/[\r\n]/.test(command) && HARMLESS.test(command)) return undefined;
	return (
		'Blocked: this command names a .env file, which holds passwords. Do not read, copy, change or ' +
		'delete it from the shell. The app reads it itself; a person edits it by hand or on the ' +
		'Settings page. To ask whether it exists, run `ls <path>` or `test -f <path>` as the whole ' +
		'command (one line, nothing chained; `test` answers with its exit status). If the command ' +
		'only mentions the name in text (a commit message, a pull request description, a search ' +
		'pattern), write the text to a file and pass the file (`git commit -F`, `gh pr create ' +
		'--body-file`, `grep -f`).'
	);
}

/** What Claude Code reads from the hook to refuse the command. */
export function denial(reason: string): string {
	return JSON.stringify({
		hookSpecificOutput: {
			hookEventName: 'PreToolUse',
			permissionDecision: 'deny',
			permissionDecisionReason: reason
		}
	});
}

/** The hook's answer to what Claude Code sends on stdin: a denial, or nothing to let it run. */
export function answer(stdin: string): string | undefined {
	let command: unknown;
	try {
		const input: unknown = JSON.parse(stdin);
		const toolInput =
			typeof input === 'object' && input && 'tool_input' in input ? input.tool_input : undefined;
		command =
			typeof toolInput === 'object' && toolInput && 'command' in toolInput
				? toolInput.command
				: undefined;
		// A Monitor on a WebSocket runs no shell command.
		if (typeof toolInput === 'object' && toolInput && 'ws' in toolInput && command === undefined)
			return undefined;
	} catch {
		command = undefined;
	}
	if (typeof command !== 'string')
		return denial('Blocked: the .env guard could not read the command it was asked to check.');
	const reason = refusal(command);
	return reason === undefined ? undefined : denial(reason);
}

if (import.meta.main) {
	const output = answer(await Bun.stdin.text());
	if (output !== undefined) console.log(output);
}
