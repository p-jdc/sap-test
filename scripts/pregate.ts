// `bun run pregate`: every mechanical check a pull request must pass, short of the app's
// browser tests (CI runs those on the pushed branch). The static checks run side by side and all
// of their failures are reported in one round; the tests follow one after another, and only when
// the static checks passed. `--only static` skips the tests while iterating.
import { createServer } from 'node:net';
import { join } from 'node:path';

interface Step {
	name: string;
	dir: 'app' | 'sap-tests';
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
const SYNC: Step = { name: 'app: generated types', dir: 'app', command: ['bunx', 'svelte-kit', 'sync'] };

const STATIC: Step[] = [
	// `bun run check` in app/ without its own `svelte-kit sync`. Keep the two in step.
	{
		name: 'app: types',
		dir: 'app',
		command: ['bunx', 'svelte-check', '--tsconfig', './tsconfig.json', '--tsgo']
	},
	// oxlint, oxfmt, prettier, knip and eslint.
	{ name: 'app: lint and format', dir: 'app', command: ['bun', 'run', 'lint'] },
	{ name: 'sap-tests: types', dir: 'sap-tests', command: ['bun', 'run', 'typecheck'] },
	{ name: 'sap-tests: lint', dir: 'sap-tests', command: ['bun', 'run', 'lint'] },
	{ name: 'sap-tests: format', dir: 'sap-tests', command: ['bun', 'run', 'format:check'] },
	{
		name: 'sap-tests: specs load',
		dir: 'sap-tests',
		command: ['bunx', 'playwright', 'test', '--list']
	}
];

// None of these needs an SAP system. One after another: they start browsers and local servers.
const TESTS: Step[] = [
	{ name: 'app: unit and component tests', dir: 'app', command: ['bun', 'run', 'test'] },
	{ name: 'sap-tests: plugin tests', dir: 'sap-tests', command: ['bun', 'run', 'test:plugin'] },
	{
		name: 'sap-tests: Mock PLC tests',
		dir: 'sap-tests',
		command: ['bun', 'run', 'test:mfs'],
		portVariable: 'MFS_MOCK_PORT'
	},
	{ name: 'sap-tests: IDoc tests', dir: 'sap-tests', command: ['bun', 'run', 'test:idoc'] },
	{
		name: 'sap-tests: API tests on the mock',
		dir: 'sap-tests',
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
			probe.close(() =>
				typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))
			);
		});
	});
}

async function run(step: Step): Promise<Outcome> {
	const started = performance.now();
	const port = step.portVariable ? { [step.portVariable]: String(await freePort()) } : {};
	const child = Bun.spawn(step.command, {
		cwd: join(root, step.dir),
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
	console.log(
		`${outcome.passed ? '✓' : '✗'} ${step.name} (${outcome.seconds.toFixed(1)} s)`
	);
	return outcome;
}

function report(failed: Outcome[]): never {
	for (const { step, output } of failed) {
		console.log(`\n── ${step.name}: ${step.command.join(' ')} (in ${step.dir}/) ──\n${output}`);
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

const staticFailed = (await Promise.all(STATIC.map(run))).filter((o) => !o.passed);
if (staticFailed.length > 0) report(staticFailed);

if (only === 'static') {
	console.log('\nPREGATE: static checks pass (tests not run)');
	process.exit(0);
}

const testFailed: Outcome[] = [];
for (const step of TESTS) {
	const outcome = await run(step);
	if (!outcome.passed) testFailed.push(outcome);
}
if (testFailed.length > 0) report(testFailed);

console.log('\nPREGATE: PASS');
