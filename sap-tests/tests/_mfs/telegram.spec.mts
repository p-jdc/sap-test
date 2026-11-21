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
