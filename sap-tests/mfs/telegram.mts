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

const totalLength = (defs: { length: number }[]) => defs.reduce((sum, def) => sum + def.length, 0);

/** A telegram type and where its values sit: what the emulator calls a value → the layout's field name. */
const messageOf = <F extends z.ZodRawShape, C extends z.ZodRawShape>(fields: F, codes: C) =>
	z.strictObject({
		type: z.string().min(1),
		fields: z.strictObject(fields),
		codes: z.strictObject(codes)
	});
const fieldName = z.string().min(1);
const wire = z.string();

/**
 * How a received telegram is acknowledged.
 * - `telegram`: with a telegram of its own type that carries the acknowledged sequence number.
 * - `echo`: the telegram itself comes back, with a header field changed from `request` to `confirm`
 *   (and, with `swapAddresses`, sender and receiver exchanged). Life telegrams are acknowledged too.
 */
const HandshakeSchema = z.discriminatedUnion('mode', [
	z.strictObject({ mode: z.literal('telegram'), type: fieldName, seqField: fieldName }),
	z.strictObject({
		mode: z.literal('echo'),
		field: fieldName,
		request: z.string().min(1),
		confirm: z.string().min(1),
		swapAddresses: z.boolean().default(true)
	})
]);

/**
 * What the telegrams mean. The emulator only knows a task, its confirmation, an identification result and a
 * device status; which telegram type, fields and codes stand for them is the layout's business. A field left
 * out is not sent and not read. A code left out is sent as `error`.
 */
const MessagesSchema = z.strictObject({
	/** EWM → PLC: move an HU from one point to another. */
	task: messageOf(
		{
			source: fieldName,
			destination: fieldName,
			hu: fieldName.optional(),
			task: fieldName.optional()
		},
		{}
	),
	/** PLC → EWM: what became of a task. */
	confirmation: messageOf(
		{
			result: fieldName,
			source: fieldName.optional(),
			destination: fieldName.optional(),
			hu: fieldName.optional(),
			task: fieldName.optional()
		},
		{
			ok: wire,
			/** Any failure without a code of its own. */
			error: wire,
			noRoute: wire.optional(),
			wrongPlc: wire.optional(),
			noHu: wire.optional(),
			occupied: wire.optional()
		}
	),
	/** PLC → EWM: an identification point read an HU. */
	scan: messageOf(
		{ point: fieldName, hu: fieldName, result: fieldName },
		{
			ok: wire,
			error: wire,
			noRead: wire.optional(),
			contour: wire.optional(),
			overweight: wire.optional()
		}
	).optional(),
	/** PLC → EWM: a device went down or came up. */
	status: messageOf({ device: fieldName, status: fieldName }, { up: wire, down: wire }).optional()
});

export const TelegramLayoutSchema = z
	.strictObject({
		interfaceType: z.string().min(1),
		description: z.string().optional(),
		fill: z.string().length(1),
		/** Start and end characters of a telegram. Without an end character, telegrams are cut by their length. */
		start: z.string().length(1).optional(),
		end: z.string().length(1).optional(),
		/** Every telegram has this length (without start and end characters), filled up at its end. */
		length: z.number().int().positive().optional(),
		header: z.array(FieldSchema).min(1),
		telegrams: z.record(z.string(), z.array(FieldSchema)),
		/** Maps the generic protocol rules onto this layout's names. */
		roles: z.strictObject({
			senderField: fieldName,
			receiverField: fieldName,
			seqField: fieldName,
			typeField: fieldName,
			/** Telegram type sent periodically to show the connection is alive. */
			life: fieldName
		}),
		handshake: HandshakeSchema,
		messages: MessagesSchema
	})
	.superRefine((layout, context) => {
		const problem = (message: string) => context.addIssue({ code: 'custom', message });
		const inHeader = (field: string, what: string) => {
			if (!layout.header.some((def) => def.name === field))
				problem(`${what}: the header has no field "${field}"`);
		};
		const { roles, handshake } = layout;
		inHeader(roles.senderField, 'roles.senderField');
		inHeader(roles.receiverField, 'roles.receiverField');
		inHeader(roles.seqField, 'roles.seqField');
		inHeader(roles.typeField, 'roles.typeField');
		const fieldsOf = (type: string, what: string) => {
			const defs = layout.telegrams[type];
			if (!defs) problem(`${what}: there is no telegram type "${type}"`);
			return defs;
		};
		fieldsOf(roles.life, 'roles.life');
		if (handshake.mode === 'echo') inHeader(handshake.field, 'handshake.field');
		else if (
			!fieldsOf(handshake.type, 'handshake.type')?.some((def) => def.name === handshake.seqField)
		)
			problem(
				`handshake.seqField: telegram ${handshake.type} has no field "${handshake.seqField}"`
			);
		for (const [kind, mapped] of Object.entries(layout.messages)) {
			if (!mapped) continue;
			const defs = fieldsOf(mapped.type, `messages.${kind}.type`);
			for (const [value, field] of Object.entries<string | undefined>(mapped.fields))
				if (defs && field && !defs.some((def) => def.name === field))
					problem(
						`messages.${kind}.fields.${value}: telegram ${mapped.type} has no field "${field}"`
					);
		}
		const headerLength = totalLength(layout.header);
		for (const [type, defs] of Object.entries(layout.telegrams)) {
			const typeLength = layout.header.find((def) => def.name === roles.typeField)?.length ?? 0;
			if (type.length > typeLength)
				problem(`telegram type "${type}" is longer than the type field (${typeLength})`);
			const size = headerLength + totalLength(defs);
			if (layout.length !== undefined && size > layout.length)
				problem(`telegram ${type} has ${size} characters, more than length ${layout.length}`);
		}
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

/** Removes the fill characters behind a value. */
function unfill(value: string, fill: string): string {
	let end = value.length;
	while (end > 0 && value[end - 1] === fill) end--;
	return value.slice(0, end);
}

function readFields(
	defs: FieldDef[],
	text: string,
	offset: number,
	fill: string
): [Fields, number] {
	const fields: Fields = {};
	let at = offset;
	for (const def of defs) {
		const value = text.slice(at, at + def.length);
		fields[def.name] = def.type === 'numc' ? value : unfill(value, fill);
		at += def.length;
	}
	return [fields, at];
}

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
	return (layout.start ?? '') + body.padEnd(layout.length ?? 0, layout.fill) + (layout.end ?? '');
}

/** Decodes one frame (without start and end characters). */
export function decode(layout: TelegramLayout, raw: string): Telegram {
	const headerLength = totalLength(layout.header);
	if (raw.length < headerLength)
		throw new TelegramError(
			`telegram shorter than its header (${raw.length} < ${headerLength})`,
			raw
		);
	const [header, offset] = readFields(layout.header, raw, 0, layout.fill);
	const type = header[layout.roles.typeField] ?? '';
	const defs = layout.telegrams[type];
	if (!defs) throw new TelegramError(`unknown telegram type "${type}"`, raw);
	// With a fixed telegram length the rest behind the last field is fill.
	const expected = layout.length ?? headerLength + totalLength(defs);
	if (raw.length !== expected)
		throw new TelegramError(`telegram ${type} has length ${raw.length}, expected ${expected}`, raw);
	const [fields] = readFields(defs, raw, offset, layout.fill);
	return { type, header, fields, raw };
}

/**
 * Splits a TCP byte stream into frames. TCP has no message boundaries: one read can hold half a telegram or
 * several, so the framer keeps the rest until a telegram is complete. A telegram ends at the end character; a
 * layout without one gives every telegram the same length, or the length of its type. Bytes outside a frame are
 * reported as garbage instead of being silently dropped.
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
		const skip = start === undefined ? 0 : 1;
		while (this.#buffer) {
			if (start !== undefined) {
				const from = this.#buffer.indexOf(start);
				if (from === -1) {
					garbage.push(this.#buffer);
					this.#buffer = '';
					break;
				}
				if (from > 0) garbage.push(this.#buffer.slice(0, from));
				this.#buffer = this.#buffer.slice(from);
			}
			if (end !== undefined) {
				const to = this.#buffer.indexOf(end, skip);
				if (to === -1) break;
				frames.push(this.#buffer.slice(skip, to));
				this.#buffer = this.#buffer.slice(to + 1);
				continue;
			}
			const size = this.#size(this.#buffer.slice(skip));
			if (size === 'more') break;
			if (size === 'unknown') {
				// No length to go by: with a start character the next one is tried, without one the stream is lost.
				garbage.push(start === undefined ? this.#buffer : this.#buffer.slice(0, 1));
				this.#buffer = start === undefined ? '' : this.#buffer.slice(1);
				continue;
			}
			if (this.#buffer.length < skip + size) break;
			frames.push(this.#buffer.slice(skip, skip + size));
			this.#buffer = this.#buffer.slice(skip + size);
		}
		return { frames, garbage };
	}

	/** The length of the telegram that starts `text`, once enough of it is there to tell. */
	#size(text: string): number | 'more' | 'unknown' {
		if (this.#layout.length !== undefined) return this.#layout.length;
		const headerLength = totalLength(this.#layout.header);
		if (text.length < headerLength) return 'more';
		const [header] = readFields(this.#layout.header, text, 0, this.#layout.fill);
		const defs = this.#layout.telegrams[header[this.#layout.roles.typeField] ?? ''];
		return defs ? headerLength + totalLength(defs) : 'unknown';
	}
}

// --- what telegrams mean ---------------------------------------------------------------------------------------

export type MessageKind = keyof TelegramLayout['messages'];
/** The value of each kind that is a code from the layout's code table. */
const CODED = {
	task: undefined,
	confirmation: 'result',
	scan: 'result',
	status: 'status'
} as const;

interface Mapped {
	type: string;
	fields: Record<string, string | undefined>;
	codes: Record<string, string | undefined>;
}
const mapped = (layout: TelegramLayout, kind: MessageKind): Mapped | undefined =>
	layout.messages[kind];

/** The code the layout sends for one of the emulator's results (`occupied` → `OCCU`). */
export function wireCode(layout: TelegramLayout, kind: MessageKind, result: string): string {
	const codes = mapped(layout, kind)?.codes ?? {};
	return codes[result] ?? codes.error ?? result;
}

/**
 * Builds the telegram of a kind from the emulator's values. Values the layout has no field for are left out;
 * undefined when the layout has no telegram of this kind at all.
 */
export function toWire(
	layout: TelegramLayout,
	kind: MessageKind,
	values: Record<string, string | undefined>
): { type: string; fields: Fields } | undefined {
	const message = mapped(layout, kind);
	if (!message) return undefined;
	const fields: Fields = {};
	for (const [value, field] of Object.entries(message.fields)) {
		const given = values[value];
		if (field === undefined || given === undefined) continue;
		fields[field] = value === CODED[kind] ? wireCode(layout, kind, given) : given;
	}
	return { type: message.type, fields };
}

/**
 * Reads a telegram as one of the kinds the emulator knows: its values by the emulator's names, as they came,
 * and `code`, the emulator's name for the result (undefined for a code the layout does not list).
 */
export function fromWire(
	layout: TelegramLayout,
	telegram: Pick<Telegram, 'type' | 'fields'>
):
	| { kind: MessageKind; values: Record<string, string | undefined>; code: string | undefined }
	| undefined {
	for (const kind of ['task', 'confirmation', 'scan', 'status'] as const) {
		const message = mapped(layout, kind);
		if (message?.type !== telegram.type) continue;
		const values: Record<string, string | undefined> = {};
		for (const [value, field] of Object.entries(message.fields))
			if (field !== undefined) values[value] = telegram.fields[field];
		const coded = CODED[kind];
		const sentCode = coded === undefined ? undefined : values[coded];
		const code = Object.entries(message.codes).find(
			([known, sent]) => known !== 'error' && sent === sentCode
		)?.[0];
		return { kind, values, code };
	}
	return undefined;
}

/** Throws a TelegramError when a value cannot travel in the field the layout has for it. */
export function checkValue(
	layout: TelegramLayout,
	kind: MessageKind,
	value: string,
	text: string
): void {
	const message = mapped(layout, kind);
	const field = message?.fields[value];
	const def = layout.telegrams[message?.type ?? '']?.find((candidate) => candidate.name === field);
	if (def) pad(def, text, layout.fill);
}
