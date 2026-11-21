// KI-generiert, geprüft von: <Name>
// The protocol rules of one MFS channel (mfs/channel.mts), between two channels over a real TCP
// connection on this computer. Timeouts are shortened.
import { readFileSync } from 'node:fs';
import { connect, createServer, type Socket } from 'node:net';
import { test as base, expect } from '../../sap-plugin';
import { Channel, type LogEntry, type Unacknowledged } from '../../mfs/channel.mts';
import { TelegramLayoutSchema, type Telegram, type TelegramLayout } from '../../mfs/telegram.mts';
import { foreignLayout } from './foreign-layout.mts';

const demoLayout = TelegramLayoutSchema.parse(
	JSON.parse(readFileSync(new URL('../../mfs/layouts/demo.telegram.json', import.meta.url), 'utf8'))
);
const timing = { ackTimeoutMs: 150, maxResends: 3, lifeIntervalMs: 200 };

type Side = {
	channel: Channel;
	received: Telegram[];
	log: LogEntry[];
	/** What this side sent and never got acknowledged; undefined while the connection is up. */
	closedWith: () => Unacknowledged[] | undefined;
};

function side(socket: Socket, local: string, remote: string, layout: TelegramLayout): Side {
	const received: Telegram[] = [];
	const log: LogEntry[] = [];
	let closedWith: Unacknowledged[] | undefined;
	const channel = new Channel({
		name: 'CONS',
		local,
		remote,
		layout,
		socket,
		timing,
		log: (entry) => log.push(entry),
		onTelegram: (telegram) => received.push(telegram),
		onClose: (unacknowledged) => {
			closedWith = unacknowledged;
		}
	});
	return { channel, received, log, closedWith: () => closedWith };
}

/** EWM and a PLC, connected. */
const test = base.extend<{ layout: TelegramLayout; pair: { ewm: Side; plc: Side } }>({
	layout: [demoLayout, { option: true }],
	pair: async ({ layout }, use) => {
		const server = createServer();
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
		const address = server.address();
		const port = typeof address === 'object' && address ? address.port : 0;
		const accepted = new Promise<Socket>((resolve) => server.once('connection', resolve));
		const client = connect(port, '127.0.0.1');
		const pair = {
			ewm: side(client, 'EWM1', 'CONS', layout),
			plc: side(await accepted, 'CONS', 'EWM1', layout)
		};
		await use(pair);
		pair.ewm.channel.close();
		pair.plc.channel.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

const task = (tanum: string) => ({ hu: '100001', src: 'GR', dst: 'IP', tanum });

test('several telegrams whose acknowledgements are lost are sent again and each processed once', async ({
	pair
}) => {
	const { ewm, plc } = pair;
	// Two tasks are on their way at once and the PLC acknowledges neither.
	plc.channel.faults = { dropAcks: 2 };
	ewm.channel.send('WT', task('1'));
	ewm.channel.send('WT', task('2'));

	// Both come again, and are acknowledged then.
	const resent = () => ewm.log.filter((entry) => entry.note?.startsWith('resent')).length;
	await expect.poll(resent).toBe(2);
	const duplicates = () => plc.log.filter((entry) => entry.note?.startsWith('repeated')).length;
	await expect.poll(duplicates).toBe(2);
	// Task numbers are a numeric field, padded with zeros.
	expect(plc.received.map((telegram) => Number(telegram.fields.tanum))).toEqual([1, 2]);
});

test('a telegram nobody acknowledged before the connection ended is handed back', async ({
	pair
}) => {
	const { ewm, plc } = pair;
	plc.channel.faults = { dropAcks: 1 };
	plc.channel.send('WTCO', { ...task('7'), result: 'OK' });
	await expect.poll(() => ewm.received.length).toBe(1);
	ewm.channel.faults = { dropAcks: 1 };
	// The PLC's confirmation reached EWM, but EWM's acknowledgement is withheld. Now the cable goes.
	plc.channel.send('WTCO', { ...task('8'), result: 'OK' });
	await expect.poll(() => ewm.received.length).toBe(2);
	ewm.channel.close();

	await expect.poll(() => plc.closedWith()).toBeDefined();
	expect(plc.closedWith()?.map((telegram) => [telegram.type, telegram.fields.tanum])).toEqual([
		['WTCO', '8']
	]);
	// What was acknowledged is not handed back, and a closed channel sends nothing.
	expect(ewm.closedWith()).toEqual([]);
	expect(plc.channel.open).toBe(false);
});

const order = (hu: string) => ({ SOURCE: 'GR', DEST: 'IP', HUIDENT: hu });

test.describe('a layout that acknowledges by sending the telegram back', () => {
	test.use({ layout: foreignLayout });

	test('the telegram comes back confirmed, with sender and receiver exchanged, and is not sent again', async ({
		pair
	}) => {
		const { ewm, plc } = pair;
		ewm.channel.send('TORDER', order('100001'));

		const acknowledged = () => ewm.log.filter((entry) => entry.note === 'acknowledgement');
		await expect.poll(() => acknowledged().length).toBe(1);
		// The six-digit sequence number of the layout, not a fixed four digits.
		expect(acknowledged()[0]).toMatchObject({ type: 'TORDER', seq: '000001', from: 'CONS' });
		expect(plc.received.map((telegram) => telegram.header)).toEqual([
			{ TELETYPE: 'TORDER', SEQU_NO: '000001', SENDER: 'EWM1', RECEIVER: 'CONS', HANDSHAKE: 'R' }
		]);
		// Longer than the acknowledgement timeout: an acknowledged telegram stays acknowledged.
		await expect
			.poll(() => plc.log.filter((entry) => entry.type === 'ALIVE').length, { timeout: 5000 })
			.toBeGreaterThan(2);
		expect(ewm.log.filter((entry) => entry.note?.startsWith('resent'))).toEqual([]);
		// The acknowledgement is not taken for a new task.
		expect(ewm.received).toEqual([]);
		expect(plc.received).toHaveLength(1);
	});

	test('a withheld acknowledgement brings the telegram again, and it is processed once', async ({
		pair
	}) => {
		const { ewm, plc } = pair;
		plc.channel.faults = { dropAcks: 1 };
		ewm.channel.send('TORDER', order('100002'));

		await expect
			.poll(() => plc.log.filter((entry) => entry.note?.startsWith('repeated')).length)
			.toBe(1);
		await expect
			.poll(
				() =>
					ewm.log.filter((entry) => entry.type === 'TORDER' && entry.note === 'acknowledgement')
						.length
			)
			.toBe(1);
		expect(plc.received).toHaveLength(1);
	});
});

test('acknowledgements match whatever length the sequence number has', async ({ pair }) => {
	// The DEMO layout has four digits; the ninth telegram of a one-digit layout would be number 9, the tenth 1.
	const { ewm, plc } = pair;
	for (let n = 1; n <= 3; n++) ewm.channel.send('WT', task(String(n)));
	await expect.poll(() => plc.received.length).toBe(3);
	await expect
		.poll(() => plc.log.filter((entry) => entry.type === 'LIFE').length, { timeout: 5000 })
		.toBeGreaterThan(2);
	expect(ewm.log.filter((entry) => entry.note?.startsWith('resent'))).toEqual([]);
});
