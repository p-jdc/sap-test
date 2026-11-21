// KI-generiert, geprüft von: <Name>
// The IDoc model's RFC side (idoc/rfc.mts): the tables of IDOC_INBOUND_ASYNCHRONOUS, against the made-up custom
// type ZPWMOCK01 and its layout. No browser, no SAP system.
import { readFileSync } from 'node:fs';
import { test, expect } from '../../sap-plugin';
import { IdocError, type Idoc } from '../../idoc/idoc.mts';
import {
	fromRfcTables,
	SegmentLayoutSchema,
	toRfcTables,
	type RfcIdocTables
} from '../../idoc/rfc.mts';
import { parseIdocXml } from '../../idoc/xml.mts';

const file = (name: string) =>
	readFileSync(new URL(`../../idoc/samples/${name}`, import.meta.url), 'utf8');
const layout = SegmentLayoutSchema.parse(JSON.parse(file('zpwmock01.layout.json')));
const { idocs } = parseIdocXml(file('zpwmock01.xml'));

test('IDocs survive a round trip through the RFC tables', () => {
	expect(fromRfcTables(toRfcTables(idocs, layout), layout)).toEqual(idocs);
});

test('data records number the segments, point to their parent and pad the fields to their lengths', () => {
	const tables = toRfcTables(idocs, layout);
	expect(tables.IDOC_CONTROL_REC_40.map((c) => c.DOCNUM)).toEqual([
		'0000000000000001',
		'0000000000000002'
	]);
	const rows = tables.IDOC_DATA_REC_40.map(({ SEGNAM, DOCNUM, SEGNUM, PSGNUM, HLEVEL, MANDT }) => ({
		SEGNAM,
		DOCNUM: DOCNUM.slice(-1),
		SEGNUM,
		PSGNUM,
		HLEVEL,
		MANDT
	}));
	expect(rows).toEqual([
		{
			SEGNAM: 'Z1PWHDR',
			DOCNUM: '1',
			SEGNUM: '000001',
			PSGNUM: '000000',
			HLEVEL: '02',
			MANDT: '100'
		},
		{
			SEGNAM: 'Z1PWITM',
			DOCNUM: '1',
			SEGNUM: '000002',
			PSGNUM: '000001',
			HLEVEL: '03',
			MANDT: '100'
		},
		{
			SEGNAM: 'Z1PWTXT',
			DOCNUM: '1',
			SEGNUM: '000003',
			PSGNUM: '000002',
			HLEVEL: '04',
			MANDT: '100'
		},
		{
			SEGNAM: 'Z1PWITM',
			DOCNUM: '1',
			SEGNUM: '000004',
			PSGNUM: '000001',
			HLEVEL: '03',
			MANDT: '100'
		},
		{
			SEGNAM: '/PWM/Z1NOTE',
			DOCNUM: '1',
			SEGNUM: '000005',
			PSGNUM: '000000',
			HLEVEL: '02',
			MANDT: '100'
		},
		// Each IDoc numbers its segments from 1.
		{
			SEGNAM: 'Z1PWHDR',
			DOCNUM: '2',
			SEGNUM: '000001',
			PSGNUM: '000000',
			HLEVEL: '02',
			MANDT: '100'
		}
	]);
	const sdata = tables.IDOC_DATA_REC_40.map((row) => row.SDATA);
	// MOCKID (20) + KIND (1); the empty CREATED and trailing spaces are cut.
	expect(sdata[0]).toBe('RUN-0042'.padEnd(20) + 'A');
	// ITEMNO (6) + QTY (15)
	expect(sdata[1]).toBe('0000103');
	expect(sdata[4]).toBe('  leading spaces are kept');
});

test('SDATA from SAP is read with its trailing padding', () => {
	const tables = toRfcTables(idocs[1], layout);
	tables.IDOC_DATA_REC_40[0].SDATA = tables.IDOC_DATA_REC_40[0].SDATA.padEnd(1000);
	expect(fromRfcTables(tables, layout)).toEqual([idocs[1]]);
});

const oneSegment = (fields: Record<string, string>, name = 'Z1PWITM'): Idoc => ({
	control: { IDOCTYP: 'ZPWMOCK01', DOCNUM: '1' },
	segments: [{ name, fields, children: [] }]
});

function refusesToWrite(value: Idoc | Idoc[], message: RegExp) {
	expect(() => toRfcTables(value, layout)).toThrow(IdocError);
	expect(() => toRfcTables(value, layout)).toThrow(message);
}

test('writing refuses IDocs the layout or the tables cannot hold', () => {
	const idoc = oneSegment;
	const bad = refusesToWrite;
	bad({ ...idoc({}), control: { IDOCTYP: 'ZPWMOCK01' } }, /needs a DOCNUM/);
	bad([idoc({}), idoc({})], /DOCNUM 1 is used twice/);
	bad(idoc({}, 'Z1UNKNOWN'), /no segment Z1UNKNOWN/);
	bad(idoc({ COLOUR: 'red' }), /no field COLOUR/);
	bad(idoc({ ITEMNO: '0000010' }), /longer than 6 characters/);
	const wide = SegmentLayoutSchema.parse({ segments: { Z1WIDE: [{ name: 'F', length: 1001 }] } });
	expect(() => toRfcTables(idoc({}, 'Z1WIDE'), wide)).toThrow(/longer than 1000/);
});

/** Changes the tables of the first sample IDoc and expects reading them to fail. */
function refusesToRead(change: (t: RfcIdocTables) => void, message: RegExp) {
	const t = toRfcTables(idocs[0], layout);
	change(t);
	expect(() => fromRfcTables(t, layout)).toThrow(IdocError);
	expect(() => fromRfcTables(t, layout)).toThrow(message);
}

test('reading refuses tables whose records do not fit together', () => {
	const bad = refusesToRead;
	bad((t) => (t.IDOC_DATA_REC_40[1].DOCNUM = '9'), /belongs to no control record/);
	bad((t) => (t.IDOC_DATA_REC_40[1].PSGNUM = '000009'), /comes nowhere before it/);
	bad((t) => (t.IDOC_DATA_REC_40[1].HLEVEL = '04'), /level 04 under a parent of level 2/);
	bad((t) => (t.IDOC_DATA_REC_40[0].HLEVEL = '03'), /not 02/);
	bad((t) => (t.IDOC_DATA_REC_40[1].SEGNUM = '000001'), /used twice/);
	// Z1PWITM's fields end at 21 characters.
	bad(
		(t) => (t.IDOC_DATA_REC_40[1].SDATA = t.IDOC_DATA_REC_40[1].SDATA.padEnd(21) + 'X'),
		/past the layout's last field/
	);
	bad((t) => delete t.IDOC_CONTROL_REC_40[0].DOCNUM, /has no DOCNUM/);
});
