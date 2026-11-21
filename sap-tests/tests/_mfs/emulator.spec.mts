// KI-generiert, geprüft von: <Name>
// The MFS PLC emulator (mfs/) on SAP's example warehouse, driven by the fake EWM over real TCP channels. No SAP
// system involved: these tests check the emulator itself. Travel times run 50 times faster, protocol timeouts
// are shortened.
import { connect, type Socket } from 'node:net';
import { test as base, expect } from '../../sap-plugin';
import { Emulator } from '../../mfs/emulator.mts';
import { FakeEwm } from '../../mfs/fake-ewm.mts';
import { loadSetup } from '../../mfs/setup.mts';

const timing = { ackTimeoutMs: 150, maxResends: 3, lifeIntervalMs: 200 };

const test = base.extend<{ emulator: Emulator; ewm: FakeEwm }>({
	// oxlint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form
	emulator: async ({}, use) => {
		const emulator = new Emulator({ setup: loadSetup('sap-example'), speed: 50, timing });
		await emulator.start();
		await use(emulator);
		await emulator.stop();
	},
	// Automatic: every test runs with EWM connected to all PLCs, also those that only watch the channels.
	ewm: [
		async ({ emulator }, use) => {
			const ewm = new FakeEwm({ setup: emulator.setup, timing });
			await ewm.connect(Object.fromEntries(emulator.state().plcs.map((plc) => [plc.id, plc.port])));
			await use(ewm);
			ewm.close();
		},
		{ auto: true }
	]
});

const telegramTypes = (emulator: Emulator) =>
	emulator
		.log()
		.filter((entry) => entry.type !== 'ACK' && entry.type !== 'LIFE')
		.map((entry) => `${entry.from}>${entry.to} ${entry.type}`);

test('putaway: an HU from goods receipt is identified and stored via transfer car and crane', async ({
	emulator,
	ewm
}) => {
	emulator.enter('100001');

	await expect.poll(() => ewm.hu('100001')?.status).toBe('stored');
	expect(ewm.hu('100001')?.path).toEqual(['IP', 'A1-IN', 'A1-01-01']);
	expect(emulator.hu('100001')?.at).toBe('A1-01-01');
	expect(telegramTypes(emulator)).toEqual([
		'CONS>EWM1 SCAN',
		'EWM1>CONS WT',
		'CONS>EWM1 WTCO',
		'EWM1>SRM1 WT',
		'SRM1>EWM1 WTCO'
	]);
	expect([...ewm.tasks.values()].map((task) => task.status)).toEqual(['confirmed', 'confirmed']);
});

test('contour error at the identification point: the HU goes to clearing', async ({
	emulator,
	ewm
}) => {
	emulator.enter('100002', undefined, { idPoint: 'CONT' });

	await expect.poll(() => ewm.hu('100002')?.status).toBe('in-clearing');
	expect(ewm.hu('100002')).toMatchObject({ scan: 'CONT', path: ['IP', 'CLEAR'] });
	expect(emulator.hu('100002')?.at).toBe('CLEAR');
});

test('no read: the HU goes to clearing and its ident appears in no telegram', async ({
	emulator,
	ewm
}) => {
	emulator.enter('100003', undefined, { idPoint: 'NORD' });

	await expect.poll(() => ewm.hu('NOREAD-1')?.status).toBe('in-clearing');
	expect(emulator.hu('100003')?.at).toBe('CLEAR');
	const huFields = emulator
		.log()
		.flatMap((entry) => (entry.fields.hu === undefined ? [] : [entry.fields.hu]));
	expect(huFields.length).toBeGreaterThan(0);
	expect(huFields).not.toContain('100003');
});

test('bin occupied: the crane refuses the putaway and EWM sends the HU to another bin', async ({
	emulator,
	ewm
}) => {
	emulator.enter('100004', undefined, { binOccupied: true });

	await expect.poll(() => ewm.hu('100004')?.status).toBe('stored');
	const tasks = [...ewm.tasks.values()];
	expect(tasks.map((task) => `${task.dst}:${task.result}`)).toEqual([
		'A1-IN:OK',
		'A1-01-01:OCCU',
		'A1-01-02:OK'
	]);
	expect(emulator.hu('100004')?.at).toBe('A1-01-02');
});

test('removal to the pick point and back into storage, then to goods issue', async ({
	emulator,
	ewm
}) => {
	emulator.enter('100005');
	await expect.poll(() => ewm.hu('100005')?.status).toBe('stored');

	ewm.retrieve('100005', 'PP');
	await expect.poll(() => ewm.hu('100005')?.status).toBe('at-pick-point');
	expect(emulator.hu('100005')?.at).toBe('PP');

	ewm.picked('100005');
	await expect.poll(() => ewm.hu('100005')?.status).toBe('stored');
	const bin = ewm.hu('100005')?.bin;
	expect(bin).toMatch(/^A2-/);

	ewm.retrieve('100005', 'GI');
	await expect.poll(() => ewm.hu('100005')?.status).toBe('shipped');
	expect(ewm.hu('100005')?.path).toEqual([
		'IP',
		'A1-IN',
		'A1-01-01',
		'A1-OUT',
		'PP',
		'A2-IN',
		bin,
		'A2-OUT',
		'GI'
	]);
	expect(emulator.hu('100005')?.left).toBe(true);
});

test('missing acknowledgement: EWM sends the task again and the PLC runs it once', async ({
	emulator,
	ewm
}) => {
	emulator.setFaults('CONS', { dropAcks: 1 });
	emulator.enter('100006');

	await expect.poll(() => ewm.hu('100006')?.status).toBe('stored');
	// The first telegram CONS receives is EWM's task for the transfer car. Its acknowledgement is withheld, so EWM
	// sends it again with the same sequence number; the PLC acknowledges the repeat but doesn't run it twice.
	const tasksToCons = emulator
		.log()
		.filter((entry) => entry.from === 'EWM1' && entry.to === 'CONS' && entry.type === 'WT');
	expect(tasksToCons.map((entry) => entry.seq)).toEqual([tasksToCons[0]?.seq, tasksToCons[0]?.seq]);
	expect(tasksToCons.map((entry) => entry.note)).toEqual([
		undefined,
		'repeated sequence number: acknowledged again, not processed'
	]);
	expect(
		emulator.log().filter((entry) => entry.note === 'acknowledgement withheld (fault)')
	).toHaveLength(1);
	expect(
		emulator.events().filter((event) => event.text.startsWith('TCAR takes task'))
	).toHaveLength(1);
});

test('a task the layout cannot run is refused: no connection, or sent to the wrong PLC', async ({
	emulator,
	ewm
}) => {
	emulator.enter('100007');
	await expect.poll(() => ewm.hu('100007')?.status).toBe('stored');

	const noRoute = ewm.sendTask('SRM1', '100007', 'GR-IN', 'A1-01-01');
	const wrongPlc = ewm.sendTask('CONS', '100007', 'A1-01-01', 'A1-OUT');
	const notThere = ewm.sendTask('SRM1', '100007', 'A1-01-05', 'A1-OUT');

	await expect.poll(() => ewm.tasks.get(noRoute)?.result).toBe('NORT');
	await expect.poll(() => ewm.tasks.get(wrongPlc)?.result).toBe('WPLC');
	await expect.poll(() => ewm.tasks.get(notThere)?.result).toBe('NOHU');
	expect(emulator.hu('100007')?.at).toBe('A1-01-01');
	expect(ewm.hu('100007')?.status).toBe('stored');
});

test('stacker crane down: EWM is told and puts away into another aisle', async ({
	emulator,
	ewm
}) => {
	emulator.setDeviceStatus('SRM1', 'DOWN');
	await expect.poll(() => telegramTypes(emulator)).toContain('SRM1>EWM1 STAT');

	emulator.enter('100008');
	await expect.poll(() => ewm.hu('100008')?.status).toBe('stored');
	expect(ewm.hu('100008')?.bin).toMatch(/^A2-/);
});

test('life telegrams: a PLC with the fault stops sending them, the others keep going', async ({
	emulator
}) => {
	emulator.setFaults('CONS', { stopLife: true });
	const from = emulator.log().at(-1)?.n ?? 0;
	const lifeFrom = (plc: string) =>
		emulator.log(from).filter((entry) => entry.type === 'LIFE' && entry.from === plc).length;

	await expect.poll(() => lifeFrom('SRM1')).toBeGreaterThanOrEqual(2);
	expect(lifeFrom('CONS')).toBe(0);
});

test('control API: testers and tests put HUs in and read the state over HTTP', async ({
	emulator,
	ewm
}) => {
	const api = `http://127.0.0.1:${await emulator.listenControl()}`;

	expect(await (await fetch(`${api}/health`)).json()).toEqual({ ok: true });
	const entered = await fetch(`${api}/hus`, {
		method: 'POST',
		body: JSON.stringify({ hu: '100009', script: { idPoint: 'WGHT' } })
	});
	expect(entered.status).toBe(201);
	await expect.poll(() => ewm.hu('100009')?.status).toBe('in-clearing');

	const state: unknown = await (await fetch(`${api}/state`)).json();
	expect(state).toMatchObject({
		plcs: ['CONS', 'SRM1', 'SRM2', 'SRM3'].map((id) => ({ id, connected: true }))
	});

	const unknownPoint = await fetch(`${api}/hus`, {
		method: 'POST',
		body: JSON.stringify({ hu: 'X', at: 'NOWHERE' })
	});
	expect(unknownPoint.status).toBe(400);
	expect(
		(await fetch(`${api}/devices/NOPE/status`, { method: 'POST', body: '{"status":"DOWN"}' }))
			.status
	).toBe(404);
});

test('control API: a request the emulator cannot read is refused and the emulator keeps running', async ({
	emulator
}) => {
	const api = `http://127.0.0.1:${await emulator.listenControl()}`;
	const post = (body: unknown) =>
		fetch(`${api}/hus`, { method: 'POST', body: JSON.stringify(body) });

	// Broken percent-encoding in the path.
	expect((await fetch(`${api}/%`)).status).toBe(400);
	expect((await fetch(`${api}/hus/%zz/script`, { method: 'POST', body: '{}' })).status).toBe(400);
	// HU numbers that do not fit a telegram: too long, or not printable ASCII.
	const tooLong = await post({ hu: '1'.repeat(40) });
	expect(tooLong.status).toBe(400);
	expect(await tooLong.json()).toMatchObject({ error: expect.stringContaining('HU number') });
	expect((await post({ hu: 'HÜ-1' })).status).toBe(400);
	expect((await fetch(`${api}/hus`, { method: 'POST', body: '{not json' })).status).toBe(400);

	expect(emulator.state().hus).toEqual([]);
	expect(await (await fetch(`${api}/health`)).json()).toEqual({ ok: true });
});

/** A connection to a PLC port that says nothing: an EWM that is there but gone quiet. */
async function silentPeer(port: number): Promise<{ socket: Socket; data: () => string }> {
	const socket = connect(port, '127.0.0.1');
	let received = '';
	socket.setEncoding('latin1').on('data', (chunk: string) => {
		received += chunk;
	});
	socket.on('error', () => undefined);
	await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
	return { socket, data: () => received };
}

const connected = (emulator: Emulator, plc: string) =>
	emulator.state().plcs.find((p) => p.id === plc)?.connected;

/**
 * Ends the fake EWM's connections and waits until the emulator has seen CONS go. The emulator
 * may not have taken up the connection yet when a test starts, so that is waited for first:
 * "not connected" would otherwise be true before EWM was ever there.
 */
async function ewmGone(emulator: Emulator, ewm: FakeEwm) {
	await expect.poll(() => connected(emulator, 'CONS')).toBe(true);
	ewm.close();
	await expect.poll(() => connected(emulator, 'CONS')).toBe(false);
}

const eventTexts = (emulator: Emulator) => emulator.events().map((event) => event.text);
const portOf = (emulator: Emulator, plc: string) =>
	emulator.state().plcs.find((p) => p.id === plc)?.port ?? 0;

test('a second connection is refused while EWM is alive, and replaces one that went silent', async ({
	emulator,
	ewm
}) => {
	const port = portOf(emulator, 'CONS');
	// The fake EWM is connected and sends life telegrams: nobody else gets in.
	await expect.poll(() => connected(emulator, 'CONS')).toBe(true);
	const intruder = await silentPeer(port);
	await expect.poll(() => intruder.socket.destroyed).toBe(true);
	expect(eventTexts(emulator)).toContain('CONS: second connection refused, the channel is in use');

	// EWM goes away properly; then one connects and falls silent without closing (a dead pod).
	await ewmGone(emulator, ewm);
	const dead = await silentPeer(port);
	await expect.poll(() => connected(emulator, 'CONS')).toBe(true);

	// A new EWM keeps trying. Once the old connection has been silent long enough, it gets in.
	const retries: Socket[] = [];
	await expect
		.poll(async () => {
			retries.push((await silentPeer(port)).socket);
			return eventTexts(emulator).some((text) => text.includes('makes way for a new one'));
		})
		.toBe(true);
	await expect.poll(() => dead.socket.destroyed).toBe(true);
	expect(connected(emulator, 'CONS')).toBe(true);
	for (const socket of retries) socket.destroy();
});

test('a telegram EWM never acknowledged goes out again when EWM connects again', async ({
	emulator,
	ewm
}) => {
	await ewmGone(emulator, ewm);
	const port = portOf(emulator, 'CONS');
	const device = emulator.setup.devices.find((d) => d.plc === 'CONS')?.id ?? '';

	// EWM receives the status report but is gone before it acknowledges it.
	const first = await silentPeer(port);
	await expect.poll(() => connected(emulator, 'CONS')).toBe(true);
	emulator.setDeviceStatus(device, 'DOWN');
	await expect.poll(() => first.data()).toContain('STAT');
	first.socket.destroy();
	await expect
		.poll(() => eventTexts(emulator))
		.toContain('CONS: 1 unacknowledged telegram(s) kept until EWM connects again');

	const second = await silentPeer(port);
	await expect.poll(() => second.data()).toContain('STAT');
	expect(second.data()).toContain(device);
	second.socket.destroy();
});
