// Telegrams: fixed-length ASCII fields, framed by start and end characters. The layout (field names, lengths,
// telegram types) comes from a layout file per PLC interface type, so the code never hard-codes a project's
// telegrams. Real layouts come from the EWM Customizing of the PLC interface type; layouts/demo.telegram.json is
// made up for the prototype.
import { z } from 'zod';

const FieldSchema = z.object({
	name: z.string().min(1),
	length: z.number().int().positive(),
	/** `numc`: digits only, padded with leading zeros. Default `char`: padded with the fill character. */
	type: z.enum(['char', 'numc']).optional()
});

export const TelegramLayoutSchema = z.object({
	interfaceType: z.string().min(1),
	description: z.string().optional(),
	fill: z.string().length(1),
	start: z.string().length(1),
	end: z.string().length(1),
	header: z.array(FieldSchema).min(1),
	telegrams: z.record(z.string(), z.array(FieldSchema)),
	/** Maps the generic protocol rules onto this layout's names. */
	roles: z.object({
		senderField: z.string(),
		receiverField: z.string(),
		seqField: z.string(),
		typeField: z.string(),
		/** Telegram type that acknowledges another telegram, and its field holding the acknowledged number. */
		ack: z.string(),
		ackSeqField: z.string(),
		/** Telegram type sent periodically to show the connection is alive. */
		life: z.string()
	})
});

export type FieldDef = z.infer<typeof FieldSchema>;
export type TelegramLayout = z.infer<typeof TelegramLayoutSchema>;

export type Fields = Record<string, string>;

export interface Telegram {
	type: string;
	header: Fields;
	fields: Fields;
	/** The frame without start and end characters. */
	raw: string;
}

export class TelegramError extends Error {
	raw: string | undefined;
	constructor(message: string, raw?: string) {
		super(message);
		this.name = 'TelegramError';
		this.raw = raw;
	}
}

function pad(def: FieldDef, value: string, fill: string): string {
	if (value.length > def.length)
		throw new TelegramError(`${def.name}: "${value}" is longer than ${def.length} characters`);
	if (def.type === 'numc') {
		if (!/^\d*$/.test(value)) throw new TelegramError(`${def.name}: "${value}" is not numeric`);
		return value.padStart(def.length, '0');
	}
	if (!/^[\x20-\x7e]*$/.test(value))
		throw new TelegramError(`${def.name}: "${value}" contains characters outside printable ASCII`);
	return value.padEnd(def.length, fill);
}

function readFields(defs: FieldDef[], text: string, offset: number): [Fields, number] {
	const fields: Fields = {};
	let at = offset;
	for (const def of defs) {
		const value = text.slice(at, at + def.length);
		fields[def.name] = def.type === 'numc' ? value : value.trimEnd();
		at += def.length;
	}
	return [fields, at];
}

const totalLength = (defs: FieldDef[]) => defs.reduce((sum, def) => sum + def.length, 0);

/** Encodes one telegram, start and end characters included. The type field is set from `type`. */
export function encode(
	layout: TelegramLayout,
	type: string,
	header: Fields,
	fields: Fields = {}
): string {
	const defs = layout.telegrams[type];
	if (!defs) throw new TelegramError(`unknown telegram type "${type}"`);
	const head = { ...header, [layout.roles.typeField]: type };
	for (const name of Object.keys(fields))
		if (!defs.some((def) => def.name === name))
			throw new TelegramError(`telegram ${type} has no field "${name}"`);
	const body =
		layout.header.map((def) => pad(def, head[def.name] ?? '', layout.fill)).join('') +
		defs.map((def) => pad(def, fields[def.name] ?? '', layout.fill)).join('');
	return layout.start + body + layout.end;
}

/** Decodes one frame (without start and end characters). */
export function decode(layout: TelegramLayout, raw: string): Telegram {
	const headerLength = totalLength(layout.header);
	if (raw.length < headerLength)
		throw new TelegramError(
			`telegram shorter than its header (${raw.length} < ${headerLength})`,
			raw
		);
	const [header, offset] = readFields(layout.header, raw, 0);
	const type = header[layout.roles.typeField] ?? '';
	const defs = layout.telegrams[type];
	if (!defs) throw new TelegramError(`unknown telegram type "${type}"`, raw);
	const expected = headerLength + totalLength(defs);
	if (raw.length !== expected)
		throw new TelegramError(`telegram ${type} has length ${raw.length}, expected ${expected}`, raw);
	const [fields] = readFields(defs, raw, offset);
	return { type, header, fields, raw };
}

/**
 * Splits a TCP byte stream into frames. TCP has no message boundaries: one read can hold half a telegram or
 * several, so the framer keeps the rest until the end character arrives. Bytes outside a frame are reported as
 * garbage instead of being silently dropped.
 */
export class Framer {
	#buffer = '';
	#layout: TelegramLayout;
	constructor(layout: TelegramLayout) {
		this.#layout = layout;
	}

	push(chunk: string): { frames: string[]; garbage: string[] } {
		this.#buffer += chunk;
		const frames: string[] = [];
		const garbage: string[] = [];
		const { start, end } = this.#layout;
		for (;;) {
			const from = this.#buffer.indexOf(start);
			if (from === -1) {
				if (this.#buffer) garbage.push(this.#buffer);
				this.#buffer = '';
				break;
			}
			if (from > 0) garbage.push(this.#buffer.slice(0, from));
			const to = this.#buffer.indexOf(end, from + 1);
			if (to === -1) {
				this.#buffer = this.#buffer.slice(from);
				break;
			}
			frames.push(this.#buffer.slice(from + 1, to));
			this.#buffer = this.#buffer.slice(to + 1);
		}
		return { frames, garbage };
	}
}
