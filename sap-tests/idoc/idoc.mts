// The IDoc model: a control record and a tree of segments, the same for every IDoc type and independent of how
// the IDoc travels. xml.mts reads and writes it as IDoc-XML (plain or in a SOAP envelope), rfc.mts as the
// EDI_DC40 and EDI_DD40 tables of an RFC call.

/** Field name to value. Values are always strings: IDoc fields are character fields, and numbers keep their
 * leading zeros. Empty fields are left out, as SAP does in IDoc-XML. */
export type Fields = Record<string, string>;

/** The fields of the control record EDI_DC40, in the order of the structure. Written in this order. */
export const CONTROL_FIELDS = [
	'TABNAM',
	'MANDT',
	'DOCNUM',
	'DOCREL',
	'STATUS',
	'DIRECT',
	'OUTMOD',
	'EXPRSS',
	'TEST',
	'IDOCTYP',
	'CIMTYP',
	'MESTYP',
	'MESCOD',
	'MESFCT',
	'STD',
	'STDVRS',
	'STDMES',
	'SNDPOR',
	'SNDPRT',
	'SNDPFC',
	'SNDPRN',
	'SNDSAD',
	'SNDLAD',
	'RCVPOR',
	'RCVPRT',
	'RCVPFC',
	'RCVPRN',
	'RCVSAD',
	'RCVLAD',
	'CREDAT',
	'CRETIM',
	'REFINT',
	'REFGRP',
	'REFMES',
	'ARCKEY',
	'SERIAL'
] as const;

export type ControlField = (typeof CONTROL_FIELDS)[number];

/** The control record. Known fields are typed; fields of newer releases are kept as they come. */
export type ControlRecord = Partial<Record<ControlField, string>> & Fields;

export interface Segment {
	/** Segment type, for example `E1EDK01`. */
	name: string;
	fields: Fields;
	children: Segment[];
}

export interface Idoc {
	control: ControlRecord;
	/** The top-level segments, in their order. */
	segments: Segment[];
}

export class IdocError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'IdocError';
	}
}

/** The name an IDoc goes by in IDoc-XML: the extension (`CIMTYP`) if there is one, otherwise the basic type
 * (`IDOCTYP`). */
export function idocTypeName(idoc: Idoc): string {
	const name = idoc.control.CIMTYP || idoc.control.IDOCTYP;
	if (!name) throw new IdocError('the control record has neither IDOCTYP nor CIMTYP');
	return name;
}

/** All segments of a type, at any depth, in document order. */
export function findSegments(idoc: Idoc, name: string): Segment[] {
	const found: Segment[] = [];
	const visit = (segments: Segment[]) => {
		for (const segment of segments) {
			if (segment.name === name) found.push(segment);
			visit(segment.children);
		}
	};
	visit(idoc.segments);
	return found;
}

/** The control record's fields in the order of EDI_DC40, followed by any others in their own order. */
export function orderedControl(control: ControlRecord): [string, string][] {
	const known = new Set<string>(CONTROL_FIELDS);
	const entries: [string, string][] = [];
	for (const name of CONTROL_FIELDS) {
		const value = control[name];
		if (value !== undefined && value !== '') entries.push([name, value]);
	}
	for (const [name, value] of Object.entries(control))
		if (!known.has(name) && value !== '') entries.push([name, value]);
	return entries;
}
