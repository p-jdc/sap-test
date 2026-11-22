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

const test = base.extend<{ runner: ScenarioRunner; realEwm: ScenarioRunner }>({
	// The Mock PLC as it runs against a real EWM: it has no simulated EWM of its own. An EWM is connected all
	// the same (the same stand-in, from outside), so that tasks arrive.
	// oxlint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form
	realEwm: async ({}, use) => {
		const emulator = new Emulator({ setup, speed, timing });
		const ewm = new FakeEwm({ setup, timing, reconnectMs: 100 });
		await ewm.connect(await emulator.start());
		await use(new ScenarioRunner({ emulator, speed, waitTimeoutMs: 20_000 }));
		ewm.close();
		await emulator.stop();
	},
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
			'connection-lost',
			'putaway-ewm'
		])
	);
	for (const s of scenarios) expect(validateScenario(s, setup), s.name).toEqual([]);
});

for (const { name, title } of listScenarios().filter((s) => s.modes.includes('demo'))) {
	test(`scenario passes in demo mode: ${title}`, async ({ runner }) => {
		runner.start(name);
		const run = await finished(runner);
		// The whole run state on failure: which step failed and why, and every check.
		expect(run?.status, JSON.stringify(run, null, 2)).toBe('passed');
	});
}

test('against a real EWM a scenario runs with the HU numbers it is given', async ({ realEwm }) => {
	expect(realEwm.available()).toMatchObject([
		{ name: 'putaway-ewm', hus: ['A'], needsHuNumbers: true, problems: [] }
	]);
	realEwm.start('putaway-ewm', { A: '112345678000004711' });

	const run = await finished(realEwm);
	expect(run?.status, JSON.stringify(run, null, 2)).toBe('passed');
	expect(run?.hus).toEqual({ A: '112345678000004711' });
});

test('against a real EWM a scenario without HU numbers, or with wrong ones, does not start', async ({
	realEwm
}) => {
	expect(() => realEwm.start('putaway-ewm')).toThrow(
		'against a real EWM every HU needs a number that EWM knows: none given for A'
	);
	expect(() => realEwm.start('putaway-ewm', { A: '1', B: '1' })).toThrow(
		/HU number 1 is given to more than one HU\n- HU number for B: no HU B enters/
	);
	// A number the telegram's HU field cannot hold is refused before anything moves.
	expect(() => realEwm.start('putaway-ewm', { A: '1'.repeat(21) })).toThrow(
		/HU number 1{21} \(A\) cannot travel in a telegram: hu: .* is longer than 20 characters/
	);
	expect(() => realEwm.start('putaway')).toThrow('needs the demo (simulated EWM)');
	// An HU still standing in the warehouse cannot arrive again: a real EWM is not reset.
	realEwm.start('putaway-ewm', { A: '4711' });
	await finished(realEwm);
	expect(() => realEwm.start('putaway-ewm', { A: '4711' })).toThrow(
		/HU 4711 \(A\) is already in the layout, at A1-01-01/
	);
});

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

test('event conditions match the kind and fields of an event, and can count', async ({
	runner
}) => {
	runner.start(
		scenario(
			[
				{ enter: 'A', idPoint: 'CONT' },
				{ enter: 'B' },
				{ wait: { event: { kind: 'delivered', hu: 'B', device: 'SRM1', to: 'bin' } } }
			],
			[
				{ event: { kind: 'scanned', hu: 'A', point: 'IP', result: 'CONT' } },
				{ event: { kind: 'task-taken', hu: 'B', plc: 'CONS', from: 'IP', to: 'A*-IN' } },
				// To A1-IN on the transfer car, then into an aisle 1 bin.
				{ event: { kind: 'delivered', hu: 'B', to: 'A1-*' }, count: 2 },
				{ event: { kind: 'delivered', hu: 'A', to: 'bin' }, count: 0 },
				// Deliberately wrong: B never fails a scan.
				{ event: { kind: 'scanned', hu: 'B', result: 'NORD' } }
			]
		)
	);

	const run = await finished(runner);
	expect(run?.steps[2]).toMatchObject({
		title: 'Wait until event delivered with hu=B device=SRM1 to=bin',
		status: 'done'
	});
	expect(run?.checks).toEqual([
		{
			title: `event scanned with hu=A (${run?.hus.A}) point=IP result=CONT`,
			ok: true,
			detail: `IP reads HU ${run?.hus.A}: CONT`
		},
		expect.objectContaining({ ok: true }),
		expect.objectContaining({ ok: true, detail: '2 found' }),
		expect.objectContaining({
			title: `event delivered with hu=A (${run?.hus.A}) to=bin exactly 0 time(s)`,
			ok: true
		}),
		expect.objectContaining({ ok: false, detail: '0 found' })
	]);
	expect(run?.status).toBe('failed');
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
	// Events are matched by kind and fields; the text form of earlier scenarios and unknown kinds are refused.
	for (const event of ['HU {A} IP → A1-IN', { kind: 'arrived' }, { kind: 'reset', text: 'x' }])
		expect(
			ScenarioSchema.safeParse({ ...scenario([{ enter: 'A' }]), expect: [{ event }] }).success,
			JSON.stringify(event)
		).toBe(false);

	expect(
		validateScenario(
			scenario([
				{ wait: { hu: 'B', at: 'bin' } },
				{ device: 'SRM9', status: 'DOWN' },
				{ enter: 'A', at: 'NOWHERE' },
				{ wait: { event: { kind: 'delivered', hu: 'C', device: 'SRM9', plc: 'PLC9' } } },
				// Fields and results an event never has: such a condition could never match.
				{ check: { event: { kind: 'delivered', hu: 'A', result: 'occupied' } } },
				{ check: { event: { kind: 'task-refused', result: 'NoRoute' }, count: 0 } },
				{ check: { event: { kind: 'bin-occupied', point: 'A1-01-01' }, count: 0 } },
				// Fields the kind does carry are fine.
				{ check: { event: { kind: 'telegram-queued', plc: 'CONS', telegram: 'WTCO' }, count: 0 } }
			]),
			setup
		)
	).toEqual([
		'step 1: HU B is used before it enters',
		'step 2: unknown device "SRM9"',
		'step 3: unknown point "NOWHERE"',
		'step 4: HU C is used before it enters',
		'step 4: unknown device "SRM9"',
		'step 4: unknown PLC "PLC9"',
		'step 5: a delivered event has no "result" (it has plc, device, hu, from, to, task)',
		'step 6: a task-refused event has no result "NoRoute" (it reports noRoute, wrongPlc, noHu)',
		'step 7: a bin-occupied event has no "point" (it has plc, device, hu, from, to, task)'
	]);
});
