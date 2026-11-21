/**
 * The app's side of the Mock PLC: it starts the real emulator from sap-tests/mfs as its own process, in demo
 * mode (with the simulated EWM), and drives it only through the control API, like the page does.
 */
import { afterEach, describe, expect, test } from 'vitest';
import type { MfsSnapshot } from '#lib/shared/mfs.js';
import { listSetups, mfsAction, mfsStatus, startEmulator, stopEmulator, watchMfs } from './mfs.js';

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

afterEach(async () => {
	if (stopEmulator()) await waitFor(stopped);
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

	test('refuses a setup that does not exist', async () => {
		await expect(startEmulator({ setup: 'nope', mode: 'demo', speed: 1 })).rejects.toThrow(
			/no setup "nope"/
		);
		expect(mfsStatus().running).toBe(false);
	});
});
