// KI-generiert, geprüft von: <Name>
// The `mfs` fixture (sap-plugin/mfs.ts) against the local Mock PLC with the simulated EWM
// (`bun run test:mfs` sets MFS_MOCK=1). Without a Mock PLC these tests are skipped.
import { test, expect } from '../../sap-plugin/mfs';

const contourError = {
	title: 'Contour error, written in the test',
	description: 'A one-off scenario: the HU sticks out and must end in clearing.',
	setup: 'sap-example',
	modes: ['demo' as const],
	steps: [{ enter: 'A', idPoint: 'CONT' as const }, { wait: { hu: 'A', at: 'CLEAR' } }]
};

test('runs a scenario file and returns its HU numbers', async ({ mfs }) => {
	const result = await mfs.runScenario('putaway');

	expect(result.status).toBe('passed');
	expect(result.hus.A).toMatch(/^\d+$/);
	expect(result.checks.every((check) => check.ok)).toBe(true);
	// The run is attached to the test, for the report and the app's run view.
	expect(test.info().attachments.map((a) => a.name)).toContain(
		'Mock PLC scenario: Putaway into the high rack'
	);
});

test('HU numbers given by the test are the ones the scenario uses', async ({ mfs }) => {
	const result = await mfs.runScenario('putaway', { hus: { A: '112345678000004711' } });

	expect(result.hus).toEqual({ A: '112345678000004711' });
	expect(result.checks.map((check) => check.detail)).toContain(
		'A (112345678000004711) at A1-01-01'
	);
	await expect(mfs.runScenario('putaway', { hus: { B: '1' } })).rejects.toThrow(
		'HU number for B: no HU B enters'
	);
});

test('runs a scenario written in the test', async ({ mfs }) => {
	const result = await mfs.runScenario({
		...contourError,
		expect: [{ hu: 'A', at: 'CLEAR', ewm: 'in-clearing' }]
	});

	expect(result).toMatchObject({ status: 'passed', title: 'Contour error, written in the test' });
	expect(result.steps.map((step) => step.status)).toEqual(['done', 'done']);
});

test('a scenario that does not pass fails the call with the unmet expectation', async ({ mfs }) => {
	await expect(
		mfs.runScenario({ ...contourError, expect: [{ hu: 'A', at: 'bin' }] })
	).rejects.toThrow(/failed\n {2}not met: A is in a bin: A \(\d+\) is at CLEAR/);
});

test('with expectPass: false the failed run is returned for checking', async ({ mfs }) => {
	const result = await mfs.runScenario(
		{ ...contourError, expect: [{ hu: 'A', at: 'bin' }] },
		{ expectPass: false }
	);

	expect(result.status).toBe('failed');
	expect(result.checks).toEqual([
		{ title: 'A is in a bin', ok: false, detail: `A (${result.hus.A}) is at CLEAR` }
	]);
});

test('a scenario the Mock PLC cannot run is refused with the reason', async ({ mfs }) => {
	await expect(mfs.runScenario('no-such-scenario')).rejects.toThrow(
		'Mock PLC: there is no scenario "no-such-scenario"'
	);
	await expect(
		mfs.runScenario({ ...contourError, steps: [{ wait: { hu: 'B', at: 'bin' } }] })
	).rejects.toThrow(/invalid:\n- step 1: HU B is used before it enters/);
});
