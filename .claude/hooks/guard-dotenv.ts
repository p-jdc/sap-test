// PreToolUse hook for Bash: refuses shell commands that name a real .env file.
//
// .claude/settings.json already denies the Read, Edit and Write tools on sap-tests/.env, which
// holds the SAP passwords. Without this hook `cat sap-tests/.env` still prints them into the
// session, and `> sap-tests/.env` overwrites them.
//
// It is a tripwire, not a wall: it reads the command text, so a path built by a glob or a variable
// (`cat sap-tests/.e*`), or a search of the whole folder (`grep -r PASSWORD sap-tests`), gets past
// it. It stops the direct, ordinary ways.
//
// It cannot tell a file name from a mention of it: a commit message that says ".env" is refused
// too. The refusal says how to pass such text in a file.

/** A path ending in `.env`: not `.env.example`, `.envrc`, `process.env` or `--env-file`. */
const ENV_FILE = /(?:^|[\s"'=<>(|;&`])(?:[^\s"'=<>(|;&`]*\/)?\.env(?=$|[\s"'<>)|;&`])/;

/**
 * Commands that only ask whether the file is there or tracked. They are allowed when the whole
 * command is one of them, so nothing can be chained behind.
 */
const HARMLESS =
	/^\s*(?:ls(?:\s+-[A-Za-z]+)*|test\s+-[ef]|\[\s+-[ef]|stat|git\s+(?:check-ignore|status|ls-files))(?:\s+[^\s|;&<>`$()]+)*(?:\s+\])?\s*$/;

export function refusal(command: string): string | undefined {
	if (!ENV_FILE.test(command)) return undefined;
	if (HARMLESS.test(command)) return undefined;
	return (
		'Blocked: this command names a .env file, which holds passwords. Do not read, copy, change or ' +
		'delete it from the shell. The app reads it itself; a person edits it by hand or on the ' +
		'Settings page. To ask whether it exists, run `test -f <path>` or `ls <path>` on its own. If ' +
		'the command only mentions the name in text (a commit message, a pull request description), ' +
		'write the text to a file and pass the file (`git commit -F`, `gh pr create --body-file`).'
	);
}

if (import.meta.main) {
	const input: unknown = JSON.parse(await Bun.stdin.text());
	const toolInput =
		typeof input === 'object' && input && 'tool_input' in input ? input.tool_input : undefined;
	const command =
		typeof toolInput === 'object' && toolInput && 'command' in toolInput ? toolInput.command : '';
	const reason = typeof command === 'string' ? refusal(command) : undefined;
	if (reason)
		console.log(
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: 'PreToolUse',
					permissionDecision: 'deny',
					permissionDecisionReason: reason
				}
			})
		);
}
