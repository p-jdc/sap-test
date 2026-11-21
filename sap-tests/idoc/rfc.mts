// The RFC form of IDocs: the tables IDOC_CONTROL_REC_40 (structure EDI_DC40) and IDOC_DATA_REC_40 (EDI_DD40) of
// the function module IDOC_INBOUND_ASYNCHRONOUS, which tRFC ports call. Nothing sends them yet. They keep the
// model ready for tRFC with SNC (a JCo sidecar, or open-rfc once it supports SNC and tRFC).
//
// A data record carries a segment's fields in SDATA: one fixed-width string, each field padded to its length in
// the segment definition. Building or reading it therefore needs the field lengths: a SegmentLayout, taken from
// the segment definitions (WE31) or the IDoc type's XML schema (WE60).
import { z } from 'zod';
import { IdocError, type ControlRecord, type Fields, type Idoc, type Segment } from './idoc.mts';

const LayoutFieldSchema = z.object({
	name: z.string().min(1),
	length: z.number().int().positive()
});

export const SegmentLayoutSchema = z.object({
	description: z.string().optional(),
	/** Segment type to its fields, in the order of the segment definition. */
	segments: z.record(z.string(), z.array(LayoutFieldSchema).min(1))
});

export type SegmentLayout = z.infer<typeof SegmentLayoutSchema>;

/** One row of EDI_DD40. */
export interface DataRecord {
	SEGNAM: string;
	MANDT: string;
	DOCNUM: string;
	/** Number of the segment within the IDoc, from 000001. */
	SEGNUM: string;
	/** SEGNUM of the parent segment, 000000 for a top-level segment. */
	PSGNUM: string;
	/** Hierarchy level: 02 for a top-level segment (the control record counts as 01). */
	HLEVEL: string;
	SDATA: string;
}

export interface RfcIdocTables {
	IDOC_CONTROL_REC_40: ControlRecord[];
	IDOC_DATA_REC_40: DataRecord[];
}

const SDATA_LENGTH = 1000;
const ROOT = '000000';

function fieldsOf(layout: SegmentLayout, segment: string) {
	const fields = layout.segments[segment];
	if (!fields) throw new IdocError(`the layout has no segment ${segment}`);
	return fields;
}

function encodeSdata(layout: SegmentLayout, segment: Segment): string {
	const defs = fieldsOf(layout, segment.name);
	const known = new Set(defs.map((def) => def.name));
	for (const name of Object.keys(segment.fields))
		if (!known.has(name)) throw new IdocError(`segment ${segment.name} has no field ${name}`);
	let sdata = '';
	for (const def of defs) {
		const value = segment.fields[def.name] ?? '';
		if (value.length > def.length)
			throw new IdocError(
				`${segment.name}-${def.name}: "${value}" is longer than ${def.length} characters`
			);
		sdata += value.padEnd(def.length, ' ');
	}
	if (sdata.length > SDATA_LENGTH)
		throw new IdocError(`segment ${segment.name} is longer than ${SDATA_LENGTH} characters`);
	return sdata.trimEnd();
}

function decodeSdata(layout: SegmentLayout, name: string, sdata: string): Fields {
	const fields: Fields = {};
	let offset = 0;
	for (const def of fieldsOf(layout, name)) {
		const value = sdata.slice(offset, offset + def.length).trimEnd();
		if (value !== '') fields[def.name] = value;
		offset += def.length;
	}
	if (sdata.slice(offset).trim() !== '')
		throw new IdocError(`SDATA of segment ${name} has data past the layout's last field`);
	return fields;
}

const num = (value: number, length: number) => String(value).padStart(length, '0');

/** Writes IDocs as the two tables of IDOC_INBOUND_ASYNCHRONOUS. Each IDoc needs its own DOCNUM, which links its
 * data records to its control record. */
export function toRfcTables(idocs: Idoc | Idoc[], layout: SegmentLayout): RfcIdocTables {
	const list = Array.isArray(idocs) ? idocs : [idocs];
	const tables: RfcIdocTables = { IDOC_CONTROL_REC_40: [], IDOC_DATA_REC_40: [] };
	const docnums = new Set<string>();
	for (const idoc of list) {
		const { DOCNUM, MANDT = '' } = idoc.control;
		if (!DOCNUM) throw new IdocError('each IDoc needs a DOCNUM in the RFC form');
		if (docnums.has(DOCNUM)) throw new IdocError(`DOCNUM ${DOCNUM} is used twice`);
		docnums.add(DOCNUM);
		tables.IDOC_CONTROL_REC_40.push({ ...idoc.control });

		let segnum = 0;
		const add = (segment: Segment, parent: string, level: number) => {
			const own = num(++segnum, 6);
			tables.IDOC_DATA_REC_40.push({
				SEGNAM: segment.name,
				MANDT,
				DOCNUM,
				SEGNUM: own,
				PSGNUM: parent,
				HLEVEL: num(level, 2),
				SDATA: encodeSdata(layout, segment)
			});
			for (const child of segment.children) add(child, own, level + 1);
		};
		for (const segment of idoc.segments) add(segment, ROOT, 2);
	}
	return tables;
}

/** Reads the two tables of IDOC_INBOUND_ASYNCHRONOUS back into IDocs, in the order of the control records. */
export function fromRfcTables(tables: RfcIdocTables, layout: SegmentLayout): Idoc[] {
	const byDocnum = new Map<
		string,
		{ idoc: Idoc; segments: Map<string, { segment: Segment; level: number }> }
	>();
	const idocs: Idoc[] = [];
	for (const row of tables.IDOC_CONTROL_REC_40) {
		if (!row.DOCNUM) throw new IdocError('a control record has no DOCNUM');
		if (byDocnum.has(row.DOCNUM)) throw new IdocError(`DOCNUM ${row.DOCNUM} is used twice`);
		const control = Object.fromEntries(Object.entries(row).filter(([, value]) => value !== ''));
		const idoc: Idoc = { control, segments: [] };
		byDocnum.set(row.DOCNUM, { idoc, segments: new Map() });
		idocs.push(idoc);
	}
	for (const row of tables.IDOC_DATA_REC_40) {
		const entry = byDocnum.get(row.DOCNUM);
		if (!entry)
			throw new IdocError(
				`data record ${row.SEGNUM} belongs to no control record (DOCNUM ${row.DOCNUM})`
			);
		if (entry.segments.has(row.SEGNUM))
			throw new IdocError(`segment number ${row.SEGNUM} is used twice in IDoc ${row.DOCNUM}`);
		const level = Number(row.HLEVEL);
		const segment: Segment = {
			name: row.SEGNAM,
			fields: decodeSdata(layout, row.SEGNAM, row.SDATA),
			children: []
		};
		if (Number(row.PSGNUM) === 0) {
			if (level !== 2)
				throw new IdocError(`top-level segment ${row.SEGNUM} has level ${row.HLEVEL}, not 02`);
			entry.idoc.segments.push(segment);
		} else {
			const parent = entry.segments.get(row.PSGNUM);
			if (!parent)
				throw new IdocError(
					`segment ${row.SEGNUM} names parent ${row.PSGNUM}, which comes nowhere before it`
				);
			if (level !== parent.level + 1)
				throw new IdocError(
					`segment ${row.SEGNUM} has level ${row.HLEVEL} under a parent of level ${parent.level}`
				);
			parent.segment.children.push(segment);
		}
		entry.segments.set(row.SEGNUM, { segment, level });
	}
	return idocs;
}
