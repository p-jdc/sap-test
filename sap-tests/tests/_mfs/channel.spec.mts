// KI-generiert, geprüft von: <Name>
// The protocol rules of one MFS channel (mfs/channel.mts), between two channels over a real TCP
// connection on this computer. Timeouts are shortened.
import { readFileSync } from 'node:fs';
import { connect, createServer, type Socket } from 'node:net';
import { test as base, expect } from '../../sap-plugin';
import { Channel, type LogEntry, type Unacknowledged } from '../../mfs/channel.mts';
import { TelegramLayoutSchema, type Telegram } from '../../mfs/telegram.mts';

const layout = TelegramLayoutSchema.parse(
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

function side(socket: Socket, local: string, remote: string): Side {
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
const test = base.extend<{ pair: { ewm: Side; plc: Side } }>({
	// oxlint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form
	pair: async ({}, use) => {
		const server = createServer();
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
		const address = server.address();
		const port = typeof address === 'object' && address ? address.port : 0;
		const accepted = new Promise<Socket>((resolve) => server.once('connection', resolve));
		const client = connect(port, '127.0.0.1');
		const pair = { ewm: side(client, 'EWM1', 'CONS'), plc: side(await accepted, 'CONS', 'EWM1') };
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
