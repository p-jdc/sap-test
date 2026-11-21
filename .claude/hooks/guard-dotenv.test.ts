import { expect, test } from 'bun:test';
import { refusal } from './guard-dotenv.ts';

const BLOCKED = [
	'cat sap-tests/.env',
	'cat .env',
	'head -3 ./sap-tests/.env',
	'grep SAP_PASSWORD sap-tests/.env',
	'cp sap-tests/.env /tmp/x',
	'cp sap-tests/.env.example sap-tests/.env',
	'echo "SAP_PASSWORD=x" > sap-tests/.env',
	'echo x >> .env',
	'rm sap-tests/.env',
	'source sap-tests/.env && env',
	'set -a; . ./.env; set +a',
	'cd sap-tests && cat .env',
	'cat "sap-tests/.env"',
	"cat 'sap-tests/.env'",
	'cat /Users/someone/project/sap-tests/.env',
	'bun --env-file=sap-tests/.env run dev',
	'cat <sap-tests/.env',
	'ls sap-tests/.env && cat sap-tests/.env',
	'test -f sap-tests/.env; cat sap-tests/.env',
	'ls $(cat sap-tests/.env)',
	'ls sap-tests/.env | xargs cat'
];

const ALLOWED = [
	'cat sap-tests/.env.example',
	'cp sap-tests/.env.example /tmp/x',
	'git diff -- app/.env.test',
	'cat .envrc',
	'grep -rn "process.env.SAP_URL" sap-tests/tests',
	'bun run dev',
	'node -e "console.log(process.env)"',
	'ls sap-tests/.env',
	'ls -la sap-tests/.env',
	'test -f sap-tests/.env',
	'[ -f sap-tests/.env ]',
	'git check-ignore -v sap-tests/.env',
	'git status --short sap-tests/.env',
	'echo "see the .env.example file"',
	'ls sap-tests/.environment'
];

test.each(BLOCKED)('blocks: %s', (command) => {
	expect(refusal(command)).toBeString();
});

test.each(ALLOWED)('allows: %s', (command) => {
	expect(refusal(command)).toBeUndefined();
});
