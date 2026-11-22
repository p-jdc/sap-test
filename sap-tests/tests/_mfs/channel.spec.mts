// KI-generiert, geprüft von: <Name>
// The protocol rules of one MFS channel (mfs/channel.mts), between two channels over a real TCP
// connection on this computer. Timeouts are shortened.
import { readFileSync } from 'node:fs';
import { connect, createServer, type Socket } from 'node:net';
import { test as base, expect } from '../../sap-plugin';
import {
	Channel,
	faultRuleProblems,
	FaultRuleSchema,
	type FaultRuleInput,
	type LogEntry,
	type Unacknowledged
} from '../../mfs/channel.mts';
import {
	encode,
	TelegramLayoutSchema,
	type Telegram,
	type TelegramLayout
} from '../../mfs/telegram.mts';
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

const rules = (...list: FaultRuleInput[]) => ({
	rules: list.map((rule) => FaultRuleSchema.parse(rule))
});
const confirmation = (tanum: string) => ({ ...task(tanum), result: 'OK' });
const tanums = (receiver: Side) =>
	receiver.received.map((telegram) => Number(telegram.fields.tanum));

test('fault rules drop or change the next matching telegrams, then they are used up', async ({
	pair
}) => {
	const { ewm, plc } = pair;
	plc.channel.faults = rules(
		{ type: 'WTCO', fields: { tanum: '1' }, action: 'drop' },
		{ type: 'WTCO', action: 'change', set: { result: 'ERR' }, times: 2 }
	);
	for (const tanum of ['1', '2', '3', '4']) plc.channel.send('WTCO', confirmation(tanum));

	await expect.poll(() => tanums(ewm)).toEqual([2, 3, 4]);
	expect(ewm.received.map((telegram) => telegram.fields.result)).toEqual(['ERR', 'ERR', 'OK']);
	// The dropped one never went out: no resend, and conditions on telegrams do not count it.
	expect(plc.log.filter((entry) => entry.note?.startsWith('dropped'))).toMatchObject([
		{ type: 'WTCO', notSent: true, fields: { tanum: '1' } }
	]);
	expect(plc.log.filter((entry) => entry.note?.startsWith('resent'))).toEqual([]);
	expect(plc.channel.faults.rules).toEqual([]);
});

test('a duplicate rule sends the telegram twice: as a second report, or as a repeat', async ({
	pair
}) => {
	const { ewm, plc } = pair;
	plc.channel.faults = rules(
		{ type: 'WTCO', fields: { tanum: '1' }, action: 'duplicate' },
		{ type: 'WTCO', fields: { tanum: '2' }, action: 'duplicate', sameSeq: true }
	);
	plc.channel.send('WTCO', confirmation('1'));
	plc.channel.send('WTCO', confirmation('2'));

	// With a new sequence number EWM gets the confirmation twice; with the same one it sees a repeat.
	await expect
		.poll(() => ewm.log.some((entry) => entry.note?.startsWith('repeated sequence number')))
		.toBe(true);
	expect(tanums(ewm)).toEqual([1, 1, 2]);
	const seqs = plc.log.filter((entry) => entry.type === 'WTCO').map((entry) => entry.seq);
	expect(seqs[0]).not.toBe(seqs[1]);
	expect(seqs[2]).toBe(seqs[3]);
});

test('a delayed telegram goes out late, and is handed back if the connection ends first', async ({
	pair
}) => {
	const { ewm, plc } = pair;
	plc.channel.faults = rules(
		{ type: 'WTCO', fields: { tanum: '1' }, action: 'delay', delayMs: 300 },
		{ type: 'WTCO', fields: { tanum: '2' }, action: 'delay', delayMs: 60_000 }
	);
	const sentAt = Date.now();
	plc.channel.send('WTCO', confirmation('1'));
	plc.channel.send('WTCO', confirmation('2'));

	await expect.poll(() => tanums(ewm)).toEqual([1]);
	const late = plc.log.find((entry) => entry.note === 'delayed 300 ms (fault rule)');
	expect((late?.at ?? 0) - sentAt).toBeGreaterThanOrEqual(300);
	plc.channel.close();
	await expect.poll(() => plc.closedWith()).toBeDefined();
	expect(plc.closedWith()?.map((telegram) => telegram.fields.tanum)).toEqual(['2']);
});

test('a delayed telegram that cannot be built fails at once, and held ones can be dropped', async ({
	pair
}) => {
	const { ewm, plc } = pair;
	plc.channel.faults = rules({ type: 'WTCO', action: 'delay', delayMs: 60_000, times: 2 });
	expect(() => plc.channel.send('WTCO', { ...confirmation('1'), result: 'TOOLONG' })).toThrow(
		'longer than 4 characters'
	);
	plc.channel.send('WTCO', confirmation('2'));
	plc.channel.dropDelayed('the warehouse was reset');

	expect(plc.log.filter((entry) => entry.notSent)).toMatchObject([
		{ note: 'dropped while delayed: the warehouse was reset', fields: { tanum: '2' } }
	]);
	plc.channel.close();
	await expect.poll(() => plc.closedWith()).toEqual([]);
	expect(ewm.received).toEqual([]);
});

test('a rule on a numeric field matches the value however it is padded; a resend skips the rules', async ({
	pair
}) => {
	const { ewm, plc } = pair;
	plc.channel.faults = rules(
		{ type: 'WTCO', fields: { tanum: '7' }, action: 'drop' },
		{ type: 'WTCO', fields: { tanum: '000000000008' }, action: 'drop' },
		{ type: 'WTCO', fields: { tanum: '9' }, action: 'drop' }
	);
	plc.channel.send('WTCO', confirmation('000000000007'));
	plc.channel.send('WTCO', confirmation('8'));
	plc.channel.send('WTCO', confirmation('9'), { rules: false });

	await expect.poll(() => tanums(ewm)).toEqual([9]);
	expect(plc.channel.faults.rules).toMatchObject([{ fields: { tanum: '9' }, times: 1 }]);
});

test('raw text is sent exactly as given, a broken telegram included', async ({ pair }) => {
	const { ewm, plc } = pair;
	const wellFormed = encode(
		demoLayout,
		'WTCO',
		{ sender: 'CONS', receiver: 'EWM1', seq: '0042' },
		confirmation('5')
	);
	plc.channel.sendRaw(wellFormed);
	plc.channel.sendRaw('\u0002CONSEWM1XXXXWTCO\u0003');

	await expect.poll(() => tanums(ewm)).toEqual([5]);
	await expect
		.poll(() => ewm.log.find((entry) => entry.note?.startsWith('decode error'))?.type)
		.toBe('?');
	// Logged as what it is: a telegram of the layout, or the text that went out.
	expect(plc.log.filter((entry) => entry.note === 'raw, sent as written')).toMatchObject([
		{ type: 'WTCO', seq: '0042', fields: { tanum: '000000000005' } },
		{ type: '?' }
	]);
	// EWM acknowledged the well-formed one; nothing on the PLC side was waiting for it.
	await expect.poll(() => plc.log.some((entry) => entry.type === 'ACK')).toBe(true);
});

test('a fault rule that does not fit the layout is reported', () => {
	expect(faultRuleProblems(demoLayout, { type: 'WTCX', action: 'drop' })).toEqual([
		'the telegram layout has no telegram "WTCX"'
	]);
	expect(
		faultRuleProblems(demoLayout, {
			type: 'WTCO',
			action: 'change',
			fields: { colour: 'red' },
			set: { result: 'TOOLONG' }
		})
	).toEqual(['telegram WTCO has no field "colour"']);
	expect(
		faultRuleProblems(demoLayout, { type: 'WTCO', action: 'change', set: { result: 'TOOLONG' } })
	).toEqual(['result: "TOOLONG" is longer than 4 characters']);
	expect(FaultRuleSchema.safeParse({ type: 'WTCO', action: 'delay' }).success).toBe(false);
	expect(FaultRuleSchema.safeParse({ type: 'WTCO', action: 'change', set: {} }).success).toBe(
		false
	);
});

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

/** The DEMO layout with a sequence number of one digit: after telegram 9 the numbers start again at 1. */
const oneDigit = TelegramLayoutSchema.parse({
	...demoLayout,
	header: demoLayout.header.map((def) => (def.name === 'seq' ? { ...def, length: 1 } : def)),
	telegrams: { ...demoLayout.telegrams, ACK: [{ name: 'ackseq', length: 1, type: 'numc' }] }
});

test.describe('a layout with a one-digit sequence number', () => {
	test.use({ layout: oneDigit });

	test('numbers that come round again are acknowledged and processed, not taken for repeats', async ({
		pair
	}) => {
		const { ewm, plc } = pair;
		for (let n = 1; n <= 25; n++) {
			ewm.channel.send('WT', task(String(n)));
			// One at a time: nine numbers cannot tell more telegrams apart that are on their way together.
			await expect.poll(() => plc.received.length).toBe(n);
		}
		expect(plc.received.map((telegram) => Number(telegram.fields.tanum))).toEqual(
			Array.from({ length: 25 }, (_, index) => index + 1)
		);
		// 25 telegrams shared the nine numbers there are.
		expect(new Set(plc.received.map((telegram) => telegram.header.seq)).size).toBeLessThanOrEqual(
			9
		);
		// Longer than the acknowledgement timeout: every acknowledgement found its telegram.
		await expect
			.poll(() => plc.log.filter((entry) => entry.type === 'LIFE').length, { timeout: 5000 })
			.toBeGreaterThan(2);
		expect(ewm.log.filter((entry) => entry.note?.startsWith('resent'))).toEqual([]);
		expect(plc.log.filter((entry) => entry.note?.startsWith('repeated'))).toEqual([]);
	});
});
