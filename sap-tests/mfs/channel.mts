// One MFS communication channel: a TCP connection between EWM and a PLC that carries telegrams. Both the
// emulator (PLC side) and the fake EWM use it, so the protocol rules live in one place:
// - every telegram gets a sequence number;
// - every telegram except acknowledgements is acknowledged, the way the layout says (handshake): with a telegram
//   of its own that names the sequence number, or by sending the telegram back with a changed header field;
// - an unacknowledged telegram is sent again with the same number, a few times;
// - a number from the other side that was seen lately is acknowledged again but not processed twice;
// - telegrams still unacknowledged when the connection ends are handed back, to be sent again after a reconnect;
// - life telegrams go out at a fixed interval.
// Faults for tests act on top: withheld acknowledgements, no life telegrams, and rules that drop, delay, double
// or change the telegrams this side sends.
import type { Socket } from 'node:net';
import { z } from 'zod';
import {
	decode,
	encode,
	Framer,
	TelegramError,
	type Fields,
	type Telegram,
	type TelegramLayout
} from './telegram.mts';

export interface LogEntry {
	n: number;
	at: number;
	channel: string;
	from: string;
	to: string;
	type: string;
	seq: string;
	fields: Fields;
	/** Protocol events: resend, duplicate, dropped acknowledgement, decode error, … */
	note?: string;
	/** Acknowledgements and life telegrams: the protocol's own traffic, hidden in most views. */
	technical?: boolean;
	/** About a telegram that did not go out (dropped, withheld, given up): conditions on telegrams skip it. */
	notSent?: boolean;
}

export interface ChannelTiming {
	ackTimeoutMs: number;
	maxResends: number;
	lifeIntervalMs: number;
}

const RuleBase = {
	/** The telegram type, as in the layout (WTCO, …). */
	type: z.string().min(1),
	/** Only telegrams whose fields have these values (field names as in the layout). */
	fields: z.record(z.string(), z.string()).optional(),
	/** How many matching telegrams the rule acts on before it is used up. */
	times: z.number().int().positive().max(10_000).default(1)
};
/**
 * What happens to the next telegram(s) of a type that this side sends:
 * - drop: never sent, as if the PLC failed to report;
 * - delay: sent late (protocol time in ms, not shortened by the Mock PLC's speed);
 * - duplicate: sent twice, the copy with a new sequence number (a second report) or the same one (a repeat);
 * - change: sent with other field values (a wrong HU, bin or result).
 */
export const FaultRuleSchema = z.discriminatedUnion('action', [
	z.strictObject({ ...RuleBase, action: z.literal('drop') }),
	z.strictObject({
		...RuleBase,
		action: z.literal('delay'),
		delayMs: z.number().int().positive().max(600_000)
	}),
	z.strictObject({ ...RuleBase, action: z.literal('duplicate'), sameSeq: z.boolean().optional() }),
	z.strictObject({
		...RuleBase,
		action: z.literal('change'),
		set: z
			.record(z.string(), z.string())
			.refine((set) => Object.keys(set).length > 0, 'set names at least one field')
	})
]);
export type FaultRule = z.infer<typeof FaultRuleSchema>;

/** What in a rule does not fit the layout: a telegram type it lacks, fields that type lacks, values too long. */
export function faultRuleProblems(layout: TelegramLayout, rule: FaultRuleInput): string[] {
	const defs = layout.telegrams[rule.type];
	if (!defs) return [`the telegram layout has no telegram "${rule.type}"`];
	const names = [
		...Object.keys(rule.fields ?? {}),
		...Object.keys(rule.action === 'change' ? rule.set : {})
	];
	const problems = [...new Set(names)]
		.filter((name) => !defs.some((def) => def.name === name))
		.map((name) => `telegram ${rule.type} has no field "${name}"`);
	if (problems.length === 0 && rule.action === 'change')
		try {
			encode(layout, rule.type, {}, rule.set);
		} catch (error) {
			problems.push(error instanceof Error ? error.message : String(error));
		}
	return problems;
}
/** A rule as written: `times` may be left out. */
export type FaultRuleInput = z.input<typeof FaultRuleSchema>;

export interface ChannelFaults {
	/** Don't acknowledge the next n received telegrams (the other side has to send them again). */
	dropAcks?: number;
	/** Stop sending life telegrams. */
	stopLife?: boolean;
	/** Rules for the telegrams this side sends; the first that matches acts, a used-up rule goes. */
	rules?: FaultRule[];
}

/** A telegram that went out and was not acknowledged. */
export type Unacknowledged = { type: string; fields: Fields };

/**
 * How many of the last received sequence numbers count as "seen". Several telegrams can be on
 * their way at once, so when their acknowledgements are lost they come again together: remembering
 * only the last number would process all but one of them twice.
 */
const SEEN = 64;

let logCounter = 0;

/** A sequence number as it is compared: without padding. */
const bare = (seq: string) => seq.trim().replace(/^0+(?=\d)/, '');

export class Channel {
	readonly name: string;
	readonly local: string;
	readonly remote: string;
	faults: ChannelFaults = {};
	lastLifeAt = 0;
	/** When the other side was last heard from at all. A healthy one sends at least life telegrams. */
	lastHeardAt = Date.now();
	#layout: TelegramLayout;
	#socket: Socket;
	#timing: ChannelTiming;
	#framer: Framer;
	#seq = 0;
	#seqLength: number;
	/** The largest number the sequence field holds. */
	#seqMax: number;
	#pending = new Map<string, { timer: NodeJS.Timeout } & Unacknowledged>();
	/** Telegrams held back by a delay rule. */
	#delayed = new Set<{ timer: NodeJS.Timeout } & Unacknowledged>();
	#unacknowledged: Unacknowledged[] = [];
	#seenIn = new Set<string>();
	#lifeTimer: NodeJS.Timeout | undefined;
	#closed = false;
	#log: (entry: LogEntry) => void;
	#onTelegram: (telegram: Telegram) => void;

	constructor(options: {
		name: string;
		local: string;
		remote: string;
		layout: TelegramLayout;
		socket: Socket;
		timing: ChannelTiming;
		log: (entry: LogEntry) => void;
		onTelegram: (telegram: Telegram) => void;
		/** Called once when the connection has ended, with the telegrams the other side never acknowledged. */
		onClose?: (unacknowledged: Unacknowledged[]) => void;
	}) {
		this.name = options.name;
		this.local = options.local;
		this.remote = options.remote;
		this.#layout = options.layout;
		this.#socket = options.socket;
		this.#timing = options.timing;
		this.#framer = new Framer(options.layout);
		const { seqField } = options.layout.roles;
		this.#seqLength = options.layout.header.find((def) => def.name === seqField)?.length ?? 4;
		this.#seqMax = 10 ** Math.min(this.#seqLength, 15) - 1;
		this.#log = options.log;
		this.#onTelegram = options.onTelegram;
		this.#socket.setEncoding('latin1');
		this.#socket.on('data', (chunk: string) => this.#receive(chunk));
		this.#socket.on('error', () => undefined);
		this.#socket.on('close', () => {
			this.#stop();
			options.onClose?.(this.#unacknowledged);
		});
		// Lets the operating system notice a peer that vanished without closing the connection.
		this.#socket.setKeepAlive(true, this.#timing.lifeIntervalMs);
		this.#lifeTimer = setInterval(() => {
			if (this.faults.stopLife) return;
			// Runs from a timer: a telegram that cannot be built must not end the program.
			try {
				this.#write(this.#layout.roles.life, {}, { technical: true });
			} catch {
				// Nothing to tell: without life telegrams the other side notices by itself.
			}
		}, this.#timing.lifeIntervalMs);
	}

	get open(): boolean {
		return !this.#closed;
	}

	/**
	 * Sends a telegram that the other side must acknowledge, unless a fault rule changes what happens. A telegram
	 * sent again after a reconnect has been through the rules once already: `rules: false` sends it as it is.
	 */
	send(type: string, fields: Fields, options: { rules?: boolean } = {}): void {
		const rule = options.rules === false ? undefined : this.#ruleFor(type, fields);
		if (!rule) {
			this.#sendNow(type, fields);
			return;
		}
		if (rule.action === 'drop') {
			this.#entry(this.local, this.remote, type, '', fields, 'dropped (fault rule): never sent', {
				notSent: true
			});
			return;
		}
		if (rule.action === 'change') {
			const changed = Object.keys(rule.set).join(', ');
			this.#sendNow(type, { ...fields, ...rule.set }, `${changed} changed (fault rule)`);
			return;
		}
		if (rule.action === 'delay') {
			// Built once now, so a telegram that cannot be built fails here, for the caller, as it would undelayed.
			encode(this.#layout, type, {}, fields);
			const held = {
				type,
				fields,
				timer: setTimeout(() => {
					this.#delayed.delete(held);
					// Runs from a timer: a telegram that cannot be built must not end the program.
					try {
						this.#sendNow(type, fields, `delayed ${rule.delayMs} ms (fault rule)`);
					} catch (error) {
						const reason = error instanceof Error ? error.message : String(error);
						this.#entry(this.local, this.remote, type, '', fields, `not sent: ${reason}`, {
							notSent: true
						});
					}
				}, rule.delayMs)
			};
			this.#delayed.add(held);
			return;
		}
		const seq = this.#sendNow(type, fields);
		if (seq === undefined) return;
		// The copy with the same number is a repeat the other side must recognise; with a new number it is a
		// second report of the same thing. Either way only the first waits for its acknowledgement.
		if (rule.sameSeq)
			this.#write(type, fields, { seq, note: 'sent again, same sequence number (fault rule)' });
		else this.#write(type, fields, { note: 'sent twice, new sequence number (fault rule)' });
	}

	/**
	 * Writes text to the connection exactly as given: start and end characters, sequence number, padding and
	 * all, or a broken telegram on purpose. Nothing waits for an acknowledgement.
	 */
	sendRaw(text: string): void {
		if (this.#closed) throw new TelegramError(`${this.name}: not connected`);
		this.#socket.write(text, 'latin1');
		let type = '?';
		let seq = '';
		let fields: Fields = { raw: JSON.stringify(text) };
		try {
			const [frame] = new Framer(this.#layout).push(text).frames;
			if (frame !== undefined) {
				const telegram = decode(this.#layout, frame);
				({ type, fields } = telegram);
				seq = telegram.header[this.#layout.roles.seqField] ?? '';
			}
		} catch {
			// Not a telegram of this layout: logged as the text that went out.
		}
		this.#entry(this.local, this.remote, type, seq, fields, 'raw, sent as written');
	}

	#sendNow(type: string, fields: Fields, note?: string): string | undefined {
		const seq = this.#write(type, fields, { note });
		if (seq !== undefined) this.#expectAck(seq, type, fields, 1);
		return seq;
	}

	/**
	 * Drops the telegrams a delay rule still holds, so that they never go out: for a fresh start, when what
	 * they report no longer exists.
	 */
	dropDelayed(reason: string): void {
		for (const { timer, type, fields } of this.#delayed) {
			clearTimeout(timer);
			this.#entry(this.local, this.remote, type, '', fields, `dropped while delayed: ${reason}`, {
				notSent: true
			});
		}
		this.#delayed.clear();
	}

	/** The first rule for this telegram; uses up one of its times. */
	#ruleFor(type: string, fields: Fields): FaultRule | undefined {
		const rules = this.faults.rules;
		const defs = this.#layout.telegrams[type] ?? [];
		// A numeric field matches by its value: "7" is the task number that travels as "000000000007".
		const same = (name: string, value: string) => {
			const actual = fields[name] ?? '';
			return defs.find((def) => def.name === name)?.type === 'numc'
				? bare(actual) === bare(value)
				: actual === value;
		};
		const index =
			rules?.findIndex(
				(rule) =>
					rule.type === type &&
					Object.entries(rule.fields ?? {}).every(([name, value]) => same(name, value))
			) ?? -1;
		const rule = rules?.[index];
		if (!rules || !rule) return undefined;
		rule.times--;
		if (rule.times <= 0) rules.splice(index, 1);
		return rule;
	}

	/** Closes the connection, as if the cable were pulled. */
	close(): void {
		this.#socket.destroy();
		this.#stop();
	}

	#stop() {
		if (this.#closed) return;
		this.#closed = true;
		clearInterval(this.#lifeTimer);
		for (const { timer, type, fields } of this.#pending.values()) {
			clearTimeout(timer);
			this.#unacknowledged.push({ type, fields });
		}
		this.#pending.clear();
		// Held back by a delay rule, so never sent: they go out after a reconnect like unacknowledged ones.
		for (const { timer, type, fields } of this.#delayed) {
			clearTimeout(timer);
			this.#unacknowledged.push({ type, fields });
		}
		this.#delayed.clear();
	}

	/** Counts up to the largest number the sequence field holds, then starts again at 1. */
	#nextSeq(): string {
		this.#seq = (this.#seq % this.#seqMax) + 1;
		return String(this.#seq);
	}

	#write(
		type: string,
		fields: Fields,
		options: {
			seq?: string;
			note?: string;
			technical?: boolean;
			/** Header fields that differ from an ordinary telegram of this side (an echoed acknowledgement). */
			header?: Fields;
		} = {}
	): string | undefined {
		if (this.#closed) return undefined;
		const seq = options.seq ?? this.#nextSeq();
		const { roles, handshake } = this.#layout;
		const header: Fields = {
			[roles.senderField]: this.local,
			[roles.receiverField]: this.remote,
			[roles.seqField]: seq,
			// Asks the other side to send this telegram back as its acknowledgement.
			...(handshake.mode === 'echo' ? { [handshake.field]: handshake.request } : {}),
			...options.header
		};
		const frame = encode(this.#layout, type, header, fields);
		this.#socket.write(frame, 'latin1');
		this.#entry(this.local, this.remote, type, seq, fields, options.note, {
			technical: options.technical
		});
		return seq;
	}

	#expectAck(seq: string, type: string, fields: Fields, tries: number) {
		const key = bare(seq);
		const timer = setTimeout(() => {
			this.#pending.delete(key);
			if (this.#closed) return;
			if (tries > this.#timing.maxResends) {
				this.#entry(
					this.local,
					this.remote,
					type,
					seq,
					fields,
					`no acknowledgement after ${tries} tries, given up`,
					{ notSent: true }
				);
				return;
			}
			this.#write(type, fields, { seq, note: `resent (try ${tries + 1}): no acknowledgement` });
			this.#expectAck(seq, type, fields, tries + 1);
		}, this.#timing.ackTimeoutMs);
		this.#pending.set(key, { timer, type, fields });
	}

	#receive(chunk: string) {
		this.lastHeardAt = Date.now();
		const { frames, garbage } = this.#framer.push(chunk);
		for (const bytes of garbage)
			this.#entry(
				this.remote,
				this.local,
				'?',
				'',
				{ bytes: JSON.stringify(bytes) },
				'bytes outside a telegram'
			);
		for (const frame of frames) {
			let telegram: Telegram;
			try {
				telegram = decode(this.#layout, frame);
			} catch (error) {
				const message = error instanceof TelegramError ? error.message : String(error);
				this.#entry(
					this.remote,
					this.local,
					'?',
					'',
					{ frame: JSON.stringify(frame) },
					`decode error: ${message}`
				);
				continue;
			}
			this.#handle(telegram);
		}
	}

	#handle(telegram: Telegram) {
		const { roles, handshake } = this.#layout;
		const seq = bare(telegram.header[roles.seqField] ?? '');
		const isAck =
			handshake.mode === 'telegram'
				? telegram.type === handshake.type
				: telegram.header[handshake.field] === handshake.confirm;
		if (isAck) {
			const acked =
				handshake.mode === 'telegram' ? bare(telegram.fields[handshake.seqField] ?? '') : seq;
			clearTimeout(this.#pending.get(acked)?.timer);
			this.#pending.delete(acked);
			this.#entry(
				this.remote,
				this.local,
				telegram.type,
				seq,
				telegram.fields,
				handshake.mode === 'echo' ? 'acknowledgement' : undefined,
				{ technical: true }
			);
			return;
		}
		// An echo layout marks the telegrams that want an acknowledgement; life telegrams are among them.
		const wantsAck =
			handshake.mode === 'telegram'
				? telegram.type !== roles.life
				: telegram.header[handshake.field] === handshake.request;
		if (telegram.type === roles.life) {
			this.lastLifeAt = Date.now();
			this.#entry(this.remote, this.local, telegram.type, seq, telegram.fields, undefined, {
				technical: true
			});
			if (wantsAck) this.#acknowledge(telegram, seq);
			return;
		}
		const duplicate = this.#seenIn.has(seq);
		this.#entry(
			this.remote,
			this.local,
			telegram.type,
			seq,
			telegram.fields,
			duplicate ? 'repeated sequence number: acknowledged again, not processed' : undefined
		);
		if (wantsAck) {
			if (this.faults.dropAcks && this.faults.dropAcks > 0) {
				this.faults.dropAcks--;
				this.#entry(
					this.local,
					this.remote,
					handshake.mode === 'telegram' ? handshake.type : telegram.type,
					handshake.mode === 'telegram' ? '' : seq,
					handshake.mode === 'telegram' ? { [handshake.seqField]: seq } : telegram.fields,
					'acknowledgement withheld (fault)',
					{ technical: true, notSent: true }
				);
			} else {
				this.#acknowledge(telegram, seq);
			}
		}
		if (duplicate) return;
		this.#seenIn.add(seq);
		// A Set keeps insertion order: its first entry is the oldest number.
		const [oldest] = this.#seenIn;
		// Never more than half the numbers there are: a short sequence field comes round again soon, and a number
		// still remembered then would be taken for a repeat.
		const remembered = Math.min(SEEN, Math.floor(this.#seqMax / 2));
		if (this.#seenIn.size > remembered && oldest !== undefined) this.#seenIn.delete(oldest);
		this.#onTelegram(telegram);
	}

	#acknowledge(telegram: Telegram, seq: string) {
		const { roles, handshake } = this.#layout;
		// Acknowledging runs from the socket: a telegram that cannot be built must not end the program.
		try {
			if (handshake.mode === 'telegram') {
				this.#write(handshake.type, { [handshake.seqField]: seq }, { technical: true });
				return;
			}
			// The telegram goes back as it came, marked as confirmed and with its own sequence number.
			const back = handshake.swapAddresses
				? { [roles.senderField]: this.local, [roles.receiverField]: this.remote }
				: {};
			this.#write(telegram.type, telegram.fields, {
				seq,
				note: 'acknowledgement',
				technical: true,
				header: { ...telegram.header, ...back, [handshake.field]: handshake.confirm }
			});
		} catch (error) {
			this.#entry(
				this.local,
				this.remote,
				telegram.type,
				seq,
				telegram.fields,
				`acknowledgement not sent: ${error instanceof Error ? error.message : String(error)}`,
				{ technical: true, notSent: true }
			);
		}
	}

	#entry(
		from: string,
		to: string,
		type: string,
		seq: string,
		fields: Fields,
		note?: string,
		flags: { technical?: boolean; notSent?: boolean } = {}
	) {
		this.#log({
			n: ++logCounter,
			at: Date.now(),
			channel: this.name,
			from,
			to,
			type,
			seq: seq && bare(seq).padStart(this.#seqLength, '0'),
			fields,
			note,
			...(flags.technical ? { technical: true } : {}),
			...(flags.notSent ? { notSent: true } : {})
		});
	}
}
