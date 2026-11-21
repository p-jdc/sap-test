// KI-generiert, geprüft von: <Name>
// The telegram codec and framing of the MFS PLC emulator (mfs/), against the made-up DEMO layout.
import { readFileSync } from 'node:fs';
import { test, expect } from '../../sap-plugin';
import {
	decode,
	encode,
	Framer,
	TelegramError,
	TelegramLayoutSchema
} from '../../mfs/telegram.mts';
import { foreign, foreignLayout } from './foreign-layout.mts';

const layout = TelegramLayoutSchema.parse(
	JSON.parse(readFileSync(new URL('../../mfs/layouts/demo.telegram.json', import.meta.url), 'utf8'))
);
const header = { sender: 'EWM1', receiver: 'CONS', seq: '7' };

test('a telegram survives encoding and decoding with padded fixed-length fields', () => {
	const frame = encode(layout, 'WT', header, {
		hu: '100001',
		src: 'IP',
		dst: 'A1-IN',
		tanum: '42'
	});
	expect(frame.startsWith('\u0002')).toBe(true);
	expect(frame.endsWith('\u0003')).toBe(true);
	// header 16 + hu 20 + src 10 + dst 10 + tanum 12
	expect(frame.length - 2).toBe(68);

	const telegram = decode(layout, frame.slice(1, -1));
	expect(telegram.type).toBe('WT');
	expect(telegram.header).toEqual({ sender: 'EWM1', receiver: 'CONS', seq: '0007', type: 'WT' });
	expect(telegram.fields).toEqual({ hu: '100001', src: 'IP', dst: 'A1-IN', tanum: '000000000042' });
});

test('values that do not fit the layout are refused instead of being cut off', () => {
	expect(() => encode(layout, 'WT', header, { hu: 'X'.repeat(21) })).toThrow(TelegramError);
	expect(() => encode(layout, 'WT', header, { tanum: '12A' })).toThrow(/not numeric/);
	expect(() => encode(layout, 'WT', header, { colour: 'red' })).toThrow(/no field "colour"/);
	expect(() => encode(layout, 'NOPE', header)).toThrow(/unknown telegram type/);
});

test('decoding rejects telegrams of the wrong length or of unknown type', () => {
	const frame = encode(layout, 'SCAN', header, { cp: 'IP', hu: '1', result: 'OK' }).slice(1, -1);
	expect(() => decode(layout, frame.slice(0, -1))).toThrow(/length/);
	expect(() => decode(layout, frame.replace('SCAN', 'XXXX'))).toThrow(/unknown telegram type/);
});

test('the framer reassembles telegrams split across reads and reports stray bytes', () => {
	const one = encode(layout, 'LIFE', header);
	const two = encode(layout, 'ACK', header, { ackseq: '7' });
	const framer = new Framer(layout);

	expect(framer.push(one.slice(0, 5))).toEqual({ frames: [], garbage: [] });
	expect(framer.push(one.slice(5) + 'junk' + two)).toEqual({
		frames: [one.slice(1, -1), two.slice(1, -1)],
		garbage: ['junk']
	});
});

test('a layout without start and end characters cuts telegrams by their fixed length', () => {
	const head = { SENDER: 'CONS', RECEIVER: 'EWM1', SEQU_NO: '12', HANDSHAKE: 'R' };
	const one = encode(foreignLayout, 'ALIVE', head);
	const two = encode(foreignLayout, 'TCONF', head, { SOURCE: 'IP', DEST: 'A1-IN', ERROR: '00' });
	// Every telegram is filled up to the same length, whatever its type.
	expect([one.length, two.length]).toEqual([90, 90]);
	const framer = new Framer(foreignLayout);

	expect(framer.push(one + two.slice(0, 40))).toEqual({ frames: [one], garbage: [] });
	expect(framer.push(two.slice(40))).toEqual({ frames: [two], garbage: [] });
	expect(decode(foreignLayout, two).fields).toEqual({
		SOURCE: 'IP',
		DEST: 'A1-IN',
		HUIDENT: '',
		ERROR: '00'
	});
});

test('without a fixed length a telegram is as long as its type says', () => {
	const byType = TelegramLayoutSchema.parse({ ...foreign, length: undefined });
	const head = { SENDER: 'CONS', RECEIVER: 'EWM1', SEQU_NO: '12' };
	const life = encode(byType, 'ALIVE', head);
	const scan = encode(byType, 'SCANNR', head, { CP: 'IP', HUIDENT: '1', ERROR: '00' });
	expect([life.length, scan.length]).toEqual([29, 69]);

	const framer = new Framer(byType);
	expect(framer.push(life + scan + life.slice(0, 10))).toEqual({
		frames: [life, scan],
		garbage: []
	});
	// A type the layout does not know has no length: what follows cannot be cut into telegrams.
	expect(framer.push(life.slice(10) + 'NOPE'.padEnd(29, '.')).garbage).toHaveLength(1);
});

test('a layout that names a telegram or field it does not have is refused when read', () => {
	const broken = TelegramLayoutSchema.safeParse({
		...foreign,
		roles: { ...foreign.roles, seqField: 'NUMBER' },
		messages: {
			...foreign.messages,
			task: { type: 'TORDER', fields: { source: 'FROM', destination: 'DEST' }, codes: {} }
		}
	});
	expect(broken.error?.issues.map((issue) => issue.message)).toEqual([
		'roles.seqField: the header has no field "NUMBER"',
		'messages.task.fields.source: telegram TORDER has no field "FROM"'
	]);
});
