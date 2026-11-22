/**
 * The app's side of the Mock PLC: it starts the real emulator from sap-tests/mfs as its own process, in demo
 * mode (with the simulated EWM), and drives it only through the control API, like the page does.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { MfsSnapshot } from '#lib/shared/mfs.js';
import {
	importedPackages,
	listScenarios,
	listSetups,
	mfsAction,
	mfsStatus,
	missingPackages,
	startEmulator,
	stopEmulator,
	watchMfs
} from './mfs.js';
import { PACKAGES_DIR, TESTS_ROOT } from './paths.js';

/** Reads the live view until a snapshot passes `check`. Leaving the loop closes the live view. */
async function waitFor(
	check: (snapshot: MfsSnapshot) => boolean,
	timeoutMs = 15_000
): Promise<MfsSnapshot> {
	const deadline = Date.now() + timeoutMs;
	for await (const snapshot of watchMfs()) {
		if (check(snapshot)) return snapshot;
		if (Date.now() > deadline) break;
	}
	throw new Error('timed out waiting for the Mock PLC');
}

const allConnected = (s: MfsSnapshot) =>
	s.ewm !== undefined && (s.state?.plcs.every((plc) => plc.connected) ?? false);
const stored = (hu: string) => (s: MfsSnapshot) =>
	s.ewm?.hus.some((record) => record.hu === hu && record.status === 'stored') ?? false;
const stopped = (s: MfsSnapshot) => !s.status.running;
const runEnded = (s: MfsSnapshot) =>
	s.run?.status === 'passed' || s.run?.status === 'failed' || s.run?.status === 'stopped';

afterEach(async () => {
	if (stopEmulator()) await waitFor(stopped);
});

describe('Mock PLC dependencies', () => {
	test('the packages its source files import are found, without built-ins and relative files', () => {
		const dir = mkdtempSync(join(tmpdir(), 'mfs-deps-'));
		writeFileSync(
			join(dir, 'a.mts'),
			[
				"import { z } from 'zod';",
				"import { thing } from '@scope/pkg/sub';",
				"import { other } from './b.mts';",
				"import { readFileSync } from 'node:fs';",
				"import 'side-effect';"
			].join('\n')
		);
		writeFileSync(join(dir, 'notes.json'), '{ "from": \'ignored\' }');
		expect(importedPackages(dir)).toEqual(['@scope/pkg', 'side-effect', 'zod']);

		mkdirSync(join(dir, 'node_modules', 'zod'), { recursive: true });
		writeFileSync(join(dir, 'node_modules', 'zod', 'package.json'), '{}');
		expect(missingPackages(join(dir, 'node_modules'), importedPackages(dir))).toEqual([
			'@scope/pkg',
			'side-effect'
		]);
	});

	test('the Mock PLC in sap-tests imports zod, and the setup installed it', () => {
		const packages = importedPackages(resolve(TESTS_ROOT, 'mfs'));
		expect(packages).toEqual(['zod']);
		expect(missingPackages(PACKAGES_DIR, packages)).toEqual([]);
	});
});

describe('Mock PLC', () => {
	test('lists the setups of sap-tests/mfs', () => {
		expect(listSetups()).toContain('sap-example');
	});

	test('demo: starts with the simulated EWM connected, stores an HU, and stops', async () => {
		await startEmulator({ setup: 'sap-example', mode: 'demo', speed: 20 });
		expect(mfsStatus()).toMatchObject({ running: true, setup: 'sap-example', mode: 'demo' });

		const connected = await waitFor(allConnected);
		expect(connected.setup?.plcs.map((plc) => plc.id)).toEqual(['CONS', 'SRM1', 'SRM2', 'SRM3']);

		await mfsAction('/hus', { hu: '100001' });
		const after = await waitFor(stored('100001'));
		expect(after.state?.hus.find((hu) => hu.hu === '100001')?.at).toBe('A1-01-01');
		expect(after.telegrams.map((t) => t.type)).toContain('WTCO');
		expect(after.events.map((e) => e.text)).toContain('SRM1 delivered HU 100001 to A1-01-01');

		await expect(mfsAction('/hus', { hu: '100001' })).rejects.toThrow(/already in the layout/);
		await expect(mfsAction('/ewm/hus/NOPE/picked', {})).rejects.toThrow(/not at the pick point/);
		await expect(startEmulator({ setup: 'sap-example', mode: 'demo', speed: 1 })).rejects.toThrow(
			/already running/
		);

		expect(stopEmulator()).toBe(true);
		const end = await waitFor(stopped);
		expect(end.status.error).toBeUndefined();
	});

	test('lists the scenario files with their setup and modes', () => {
		expect(listScenarios()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: 'putaway', setup: 'sap-example', modes: ['demo'] }),
				expect.objectContaining({
					name: 'crane-down',
					title: 'Stacker crane fails with a task waiting'
				})
			])
		);
	});

	test('starts with a scenario, which runs on the Mock PLC and passes', async () => {
		await startEmulator({
			setup: 'sap-example',
			mode: 'demo',
			speed: 20,
			scenario: 'bin-occupied'
		});

		const end = await waitFor(runEnded, 30_000);
		// The whole run on failure: which step or check went wrong.
		expect(end.run).toMatchObject({ status: 'passed' });
		expect(end.run?.error).toBeUndefined();
		expect(end.run?.checks.every((check) => check.ok)).toBe(true);
		expect(end.scenarios?.map((s) => s.name)).toContain('connection-lost');
	});

	test('a scenario that does not exist is reported, and the Mock PLC keeps running', async () => {
		await expect(
			startEmulator({ setup: 'sap-example', mode: 'demo', speed: 20, scenario: 'nope' })
		).rejects.toThrow(/running, but the scenario did not start: there is no scenario "nope"/);
		expect(mfsStatus().running).toBe(true);
	});

	test('two starts at the same moment start one emulator', async () => {
		const input = { setup: 'sap-example', mode: 'demo', speed: 20 } as const;
		const results = await Promise.allSettled([startEmulator(input), startEmulator(input)]);
		expect(results.map((result) => result.status).toSorted()).toEqual(['fulfilled', 'rejected']);
		const refused = results.filter(
			(result): result is PromiseRejectedResult => result.status === 'rejected'
		);
		expect(refused.map((result) => String(result.reason)).join()).toContain('already starting');
		expect(mfsStatus()).toMatchObject({ running: true, setup: 'sap-example' });
		// The one that runs is the one the app knows, so stopping it leaves none behind.
		expect(stopEmulator()).toBe(true);
		await waitFor(stopped);
	});

	test('refuses a setup that does not exist', async () => {
		await expect(startEmulator({ setup: 'nope', mode: 'demo', speed: 1 })).rejects.toThrow(
			/no setup "nope"/
		);
		expect(mfsStatus().running).toBe(false);
	});
});
