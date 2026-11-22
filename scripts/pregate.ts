// `bun run pregate`: every mechanical check a pull request must pass, short of the app's
// browser tests (CI runs those on the pushed branch). The static checks run side by side and all
// of their failures are reported in one round; the tests follow one after another, and only when
// the static checks passed. `--only static` skips the tests while iterating. Every step runs from
// the project root, which holds the one install.
import { createServer } from 'node:net';
import { join } from 'node:path';

interface Step {
	name: string;
	command: string[];
	/** Environment variable that tells the step which port its local server takes. */
	portVariable?: string;
}

interface Outcome {
	step: Step;
	passed: boolean;
	seconds: number;
	output: string;
}

const root = join(import.meta.dir, '..');

// Run once, before anything else: the type check and the linters read what it generates, and
// must not see it half-written.
const SYNC: Step = { name: 'generated types', command: ['bunx', 'svelte-kit', 'sync'] };

const STATIC: Step[] = [
	// `bun run check` without its own `svelte-kit sync`, in two halves. Keep them in step.
	{
		name: 'app: types',
		command: ['bunx', 'svelte-check', '--tsconfig', './tsconfig.json', '--tsgo']
	},
	{ name: 'sap-tests: types', command: ['bunx', 'tsc', '-p', 'sap-tests', '--noEmit'] },
	// One run for both: sap-tests/.oxlintrc.json applies to the files under sap-tests/.
	{ name: 'lint', command: ['bunx', 'oxlint', '--type-aware', '--deny-warnings'] },
	{ name: 'format', command: ['bun', 'run', 'format:check'] },
	{ name: 'unused files and dependencies', command: ['bunx', 'knip'] },
	{ name: 'eslint (Svelte templates)', command: ['bunx', 'eslint', '.'] },
	{
		name: 'Claude Code hooks: tests',
		command: ['bun', 'test', './.claude/hooks/guard-dotenv.test.ts']
	},
	{ name: 'sap-tests: specs load', command: ['bun', 'run', 'test:sap:list'] }
];

// None of these needs an SAP system. One after another: they start browsers and local servers.
const TESTS: Step[] = [
	{ name: 'app: unit and component tests', command: ['bun', 'run', 'test'] },
	{ name: 'sap-tests: plugin tests', command: ['bun', 'run', 'test:plugin'] },
	{
		name: 'sap-tests: Mock PLC tests',
		command: ['bun', 'run', 'test:mfs'],
		portVariable: 'MFS_MOCK_PORT'
	},
	{ name: 'sap-tests: IDoc tests', command: ['bun', 'run', 'test:idoc'] },
	{
		name: 'sap-tests: API tests on the mock',
		command: ['bun', 'run', 'test:api:mock'],
		portVariable: 'ODATA_MOCK_PORT'
	}
];

/**
 * A port nobody listens on right now. The suites' servers default to fixed ports, which a second
 * pregate in another worktree, or a server the user left running, would already hold.
 */
function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.once('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const address = probe.address();
			probe.close(() => {
				if (typeof address === 'object' && address) resolve(address.port);
				else reject(new Error('no port'));
			});
		});
	});
}

async function run(step: Step): Promise<Outcome> {
	const started = performance.now();
	const port = step.portVariable ? { [step.portVariable]: String(await freePort()) } : {};
	const child = Bun.spawn(step.command, {
		cwd: root,
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env, FORCE_COLOR: '0', ...port }
	});
	const [out, err, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited
	]);
	const outcome = {
		step,
		passed: code === 0,
		seconds: (performance.now() - started) / 1000,
		output: `${out}${err}`.trim()
	};
	console.log(`${outcome.passed ? '✓' : '✗'} ${step.name} (${outcome.seconds.toFixed(1)} s)`);
	return outcome;
}

function report(failed: Outcome[]): never {
	for (const { step, output } of failed) {
		console.log(`\n── ${step.name}: ${step.command.join(' ')} ──\n${output}`);
	}
	console.log(`\nPREGATE: FAIL (${failed.map((f) => f.step.name).join('; ')})`);
	process.exit(1);
}

const only = process.argv.includes('--only')
	? process.argv[process.argv.indexOf('--only') + 1]
	: undefined;
if (only !== undefined && only !== 'static') {
	console.log('Usage: bun run pregate [--only static]');
	process.exit(2);
}

const synced = await run(SYNC);
if (!synced.passed) report([synced]);

const staticFailed = (await Promise.all(STATIC.map((step) => run(step)))).filter((o) => !o.passed);
if (staticFailed.length > 0) report(staticFailed);

if (only === 'static') {
	console.log('\nPREGATE: static checks pass (tests not run)');
	process.exit(0);
}

const testFailed: Outcome[] = [];
for (const step of TESTS) {
	// oxlint-disable-next-line no-await-in-loop -- one after another on purpose, see TESTS
	const outcome = await run(step);
	if (!outcome.passed) testFailed.push(outcome);
}
if (testFailed.length > 0) report(testFailed);

console.log('\nPREGATE: PASS');
