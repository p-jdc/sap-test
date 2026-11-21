// KI-generiert, geprüft von: <Name>
// The IDoc model's XML side (idoc/): reading and writing IDoc-XML, plain and in a SOAP envelope, against the
// made-up samples in idoc/samples. No browser, no SAP system.
import { readFileSync } from 'node:fs';
import { test, expect } from '../../sap-plugin';
import { findSegments, IdocError, type Idoc } from '../../idoc/idoc.mts';
import { parseIdocXml, toIdocXml } from '../../idoc/xml.mts';

const sample = (name: string) =>
	readFileSync(new URL(`../../idoc/samples/${name}`, import.meta.url), 'utf8');
const orders = sample('orders05.xml');
const ordersSoap = sample('orders05-soap.xml');
const custom = sample('zpwmock01.xml');

const names = (idoc: Idoc) => idoc.segments.map((segment) => segment.name);

test('an ORDERS05 IDoc is read with its control record and its segments in order', () => {
	const { root, soap, idocs } = parseIdocXml(orders);
	expect(root).toBe('ORDERS05');
	expect(soap).toBe(false);
	expect(idocs).toHaveLength(1);
	const [idoc] = idocs;

	expect(idoc.control).toMatchObject({
		DOCNUM: '0000000000123456',
		IDOCTYP: 'ORDERS05',
		MESTYP: 'ORDRSP',
		RCVPRN: 'PWMOCK',
		RCVPRT: 'LS'
	});
	// Segments of different types stay interleaved as they came.
	expect(names(idoc)).toEqual([
		'E1EDK01',
		'E1EDK14',
		'E1EDK03',
		'E1EDKA1',
		'E1EDKA1',
		'E1EDK02',
		'E1EDP01',
		'E1EDP01'
	]);
	// Numbers stay strings with their leading zeros; entities are decoded.
	expect(idoc.segments[0].fields).toEqual({ CURCY: 'EUR', BSART: 'TA', BELNR: '0000012345' });
	expect(idoc.segments[3].fields.NAME1).toBe('Müller & Söhne GmbH');
	expect(findSegments(idoc, 'E1EDP19').map((s) => s.fields.IDTNR)).toEqual(['MAT-100', 'MAT-200']);
	expect(idoc.segments[6].children.map((s) => s.name)).toEqual(['E1EDP19']);
});

test('the same IDoc inside a SOAP envelope reads the same', () => {
	const plain = parseIdocXml(orders);
	const soap = parseIdocXml(ordersSoap);
	expect(soap.soap).toBe(true);
	expect(soap.root).toBe('ORDERS05');
	// The SOAP sample writes ü and ö as character references.
	expect(soap.idocs).toEqual(plain.idocs);
});

for (const [name, xml] of [
	['ORDERS05', orders],
	['ORDERS05 in SOAP', ordersSoap],
	['the custom type ZPWMOCK01', custom]
] as const) {
	test(`${name} survives a round trip, plain and in SOAP, compact and indented`, () => {
		const { idocs } = parseIdocXml(xml);
		for (const soap of [false, true])
			for (const pretty of [false, true]) {
				const written = toIdocXml(idocs, { soap, pretty });
				const again = parseIdocXml(written);
				expect(again.soap).toBe(soap);
				expect(again.idocs).toEqual(idocs);
				// Writing is stable: the same IDocs give the same text.
				expect(toIdocXml(again.idocs, { soap, pretty })).toBe(written);
			}
	});
}

test('a custom type keeps several IDocs, deep segments, namespaced names, CDATA and leading spaces', () => {
	const { root, idocs } = parseIdocXml(custom);
	expect(root).toBe('ZPWMOCK01');
	expect(idocs.map((idoc) => idoc.control.DOCNUM)).toEqual([
		'0000000000000001',
		'0000000000000002'
	]);

	const [first] = idocs;
	expect(names(first)).toEqual(['Z1PWHDR', '/PWM/Z1NOTE']);
	const [item] = first.segments[0].children;
	expect(item.children[0]).toEqual({
		name: 'Z1PWTXT',
		fields: { TEXT: 'Fragile: <handle> with care' },
		children: []
	});
	expect(first.segments[1].fields.NOTE).toBe('  leading spaces are kept');

	const written = toIdocXml(idocs);
	expect(written).toContain('<_-PWM_-Z1NOTE SEGMENT="1">');
	expect(written).toContain('<TEXT>Fragile: &lt;handle&gt; with care</TEXT>');
});

test('the control record is written in the order of EDI_DC40, whatever order it was given in', () => {
	const idoc: Idoc = {
		control: {
			MESTYP: 'ZPWMOCK',
			IDOCTYP: 'ZPWMOCK01',
			TABNAM: 'EDI_DC40',
			ZNEWFIELD: 'x',
			DOCNUM: ''
		},
		segments: [{ name: 'Z1PWHDR', fields: { MOCKID: 'RUN-1', KIND: '' }, children: [] }]
	};
	expect(toIdocXml(idoc)).toBe(
		'<?xml version="1.0" encoding="UTF-8"?><ZPWMOCK01><IDOC BEGIN="1"><EDI_DC40 SEGMENT="1">' +
			'<TABNAM>EDI_DC40</TABNAM><IDOCTYP>ZPWMOCK01</IDOCTYP><MESTYP>ZPWMOCK</MESTYP><ZNEWFIELD>x</ZNEWFIELD>' +
			'</EDI_DC40><Z1PWHDR SEGMENT="1"><MOCKID>RUN-1</MOCKID></Z1PWHDR></IDOC></ZPWMOCK01>'
	);
});

test('an extended IDoc is written under the name of its extension', () => {
	const idoc: Idoc = {
		control: { IDOCTYP: 'ORDERS05', CIMTYP: 'ZORDERS05EXT' },
		segments: [{ name: 'Z1EXTRA', fields: { FLAG: 'X' }, children: [] }]
	};
	const xml = toIdocXml(idoc);
	expect(xml).toContain('<ZORDERS05EXT><IDOC BEGIN="1">');
	expect(parseIdocXml(xml).root).toBe('ZORDERS05EXT');
});

function refusesToRead(xml: string, message: RegExp) {
	expect(() => parseIdocXml(xml)).toThrow(IdocError);
	expect(() => parseIdocXml(xml)).toThrow(message);
}

test('reading refuses anything that is not IDoc-XML', () => {
	const bad = refusesToRead;
	const dc = '<EDI_DC40 SEGMENT="1"><IDOCTYP>X</IDOCTYP></EDI_DC40>';

	// Entity expansion ("billion laughs") never reaches the parser.
	bad('<!DOCTYPE x [<!ENTITY a "aaaa">]><X><IDOC>&a;</IDOC></X>', /DOCTYPE/);
	bad('<X><IDOC>', /not well-formed/);
	bad('<X></X>', /holds no IDOC/);
	bad(`<X><IDOC>${dc}</IDOC><OTHER/></X>`, /only hold IDOC elements/);
	bad('<X><IDOC><E1 SEGMENT="1"/></IDOC></X>', /start with its control record/);
	bad(`<X><IDOC>${dc}<E1 SEGMENT="1">text<F>1</F></E1></IDOC></X>`, /contains text/);
	bad(`<X><IDOC>${dc}<E1 SEGMENT="1"><F>1</F><F>2</F></E1></IDOC></X>`, /appears twice/);
	bad(
		`<X><IDOC><EDI_DC40 SEGMENT="1"><E1 SEGMENT="1"/></EDI_DC40></IDOC></X>`,
		/contains segments/
	);
	bad('<a/><b/>', /not well-formed|exactly one element/);
	bad(
		'<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Header/></s:Envelope>',
		/no Body/
	);
});

const oneSegment = (idoctyp: string, fields: Record<string, string> = {}, name = 'E1'): Idoc => ({
	control: { IDOCTYP: idoctyp },
	segments: [{ name, fields, children: [] }]
});

test('writing refuses what IDoc-XML cannot hold', () => {
	const idoc = oneSegment;
	expect(() => toIdocXml([])).toThrow(/no IDoc/);
	expect(() => toIdocXml([idoc('A'), idoc('B')])).toThrow(/A and B are mixed/);
	expect(() => toIdocXml({ control: {}, segments: [] })).toThrow(/neither IDOCTYP nor CIMTYP/);
	expect(() => toIdocXml(idoc('A', { F: 'bell\u0007' }))).toThrow(/control character/);
	expect(() => toIdocXml(idoc('A', {}, 'E1 X'))).toThrow(/XML element name/);
});
