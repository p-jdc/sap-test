// KI-generiert, geprüft von: <Name>
// Mock scenarios (mfs/scenarios): every file is valid and passes in demo mode against the fake EWM; the runner
// reports failures, and can be paused and stopped. No SAP system involved.
import { test as base, expect } from '../../sap-plugin';
import { Emulator } from '../../mfs/emulator.mts';
import { FakeEwm } from '../../mfs/fake-ewm.mts';
import {
	listScenarios,
	ScenarioRunner,
	ScenarioSchema,
	validateScenario,
	type Scenario
} from '../../mfs/scenario.mts';
import { loadSetup } from '../../mfs/setup.mts';

const timing = { ackTimeoutMs: 150, maxResends: 3, lifeIntervalMs: 200 };
const speed = 50;
const setup = loadSetup('sap-example');

const test = base.extend<{ runner: ScenarioRunner }>({
	// oxlint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form
	runner: async ({}, use) => {
		const emulator = new Emulator({ setup, speed, timing });
		const ewm = new FakeEwm({ setup, timing, reconnectMs: 100 });
		await ewm.connect(await emulator.start());
		await use(new ScenarioRunner({ emulator, ewm, speed, waitTimeoutMs: 20_000 }));
		ewm.close();
		await emulator.stop();
	}
});

/** Waits for the run to end and returns its final state. */
async function finished(runner: ScenarioRunner) {
	await expect
		.poll(() => runner.state()?.status, { timeout: 30_000 })
		.not.toMatch(/^(running|paused)$/);
	return runner.state();
}

const scenario = (steps: Scenario['steps'], expectations: Scenario['expect'] = []): Scenario => ({
	name: 'inline',
	title: 'Inline',
	description: '',
	setup: 'sap-example',
	modes: ['demo'],
	fresh: true,
	steps,
	expect: expectations
});

test('every scenario file is valid and fits its setup', () => {
	const scenarios = listScenarios();
	expect(scenarios.map((s) => s.name)).toEqual(
		expect.arrayContaining([
			'putaway',
			'rejected-at-id-point',
			'bin-occupied',
			'crane-down',
			'connection-lost'
		])
	);
	for (const s of scenarios) expect(validateScenario(s, setup), s.name).toEqual([]);
});

for (const { name, title } of listScenarios()) {
	test(`scenario passes in demo mode: ${title}`, async ({ runner }) => {
		runner.start(name);
		const run = await finished(runner);
		// The whole run state on failure: which step failed and why, and every check.
		expect(run?.status, JSON.stringify(run, null, 2)).toBe('passed');
	});
}

test('a scenario whose expectation is not met fails and says which check', async ({ runner }) => {
	runner.start(
		scenario(
			[{ enter: 'A', idPoint: 'CONT' }, { wait: { hu: 'A', at: 'CLEAR' } }],
			[{ hu: 'A', at: 'bin' }]
		)
	);

	const run = await finished(runner);
	expect(run?.status).toBe('failed');
	expect(run?.checks).toEqual([
		{ title: 'A is in a bin', ok: false, detail: `A (${run?.hus.A}) is at CLEAR` }
	]);
});

test('a failing check step stops the run and skips the rest', async ({ runner }) => {
	runner.start(scenario([{ enter: 'A' }, { check: { hu: 'A', at: 'CLEAR' } }, { pause: '1s' }]));

	const run = await finished(runner);
	expect(run?.status).toBe('failed');
	expect(run?.steps.map((step) => step.status)).toEqual(['done', 'failed', 'skipped']);
	// A starts on the goods receipt conveyor, so it is not at the clearing point.
	expect(run?.error).toMatch(/^check failed: A \(\d+\) is on CV-GR/);
});

test('a run can be paused, resumed and stopped', async ({ runner }) => {
	runner.start(scenario([{ enter: 'A' }, { pause: '1000s' }, { enter: 'B' }]));
	await expect.poll(() => runner.state()?.steps[1]?.status).toBe('running');

	runner.pause();
	expect(runner.state()?.status).toBe('paused');
	expect(() => runner.start('putaway')).toThrow(/still running/);
	runner.resume();
	runner.stop();

	const run = await finished(runner);
	expect(run?.status).toBe('stopped');
	expect(run?.steps.map((step) => step.status)).toEqual(['done', 'skipped', 'skipped']);
});

test('scenario files are checked: wrong keys, HU names and references are reported', () => {
	const wrongKey = ScenarioSchema.safeParse({
		...scenario([{ enter: 'A' }]),
		steps: [{ enter: 'A', colour: 'red' }]
	});
	expect(wrongKey.success).toBe(false);
	const lowerCase = ScenarioSchema.safeParse({
		...scenario([{ enter: 'A' }]),
		steps: [{ enter: 'a' }]
	});
	expect(lowerCase.success).toBe(false);

	expect(
		validateScenario(
			scenario([
				{ wait: { hu: 'B', at: 'bin' } },
				{ device: 'SRM9', status: 'DOWN' },
				{ enter: 'A', at: 'NOWHERE' }
			]),
			setup
		)
	).toEqual([
		'step 1: HU B is used before it enters',
		'step 2: unknown device "SRM9"',
		'step 3: unknown point "NOWHERE"'
	]);
});
