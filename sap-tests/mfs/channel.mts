// One MFS communication channel: a TCP connection between EWM and a PLC that carries telegrams. Both the
// emulator (PLC side) and the fake EWM use it, so the protocol rules live in one place:
// - every telegram gets a sequence number;
// - every telegram except acknowledgements is acknowledged, the way the layout says (handshake): with a telegram
//   of its own that names the sequence number, or by sending the telegram back with a changed header field;
// - an unacknowledged telegram is sent again with the same number, a few times;
// - a number from the other side that was seen lately is acknowledged again but not processed twice;
// - telegrams still unacknowledged when the connection ends are handed back, to be sent again after a reconnect;
// - life telegrams go out at a fixed interval.
import type { Socket } from 'node:net';
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
}

export interface ChannelTiming {
	ackTimeoutMs: number;
	maxResends: number;
	lifeIntervalMs: number;
}

export interface ChannelFaults {
	/** Don't acknowledge the next n received telegrams (the other side has to send them again). */
	dropAcks?: number;
	/** Stop sending life telegrams. */
	stopLife?: boolean;
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
	#pending = new Map<string, { timer: NodeJS.Timeout } & Unacknowledged>();
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
			if (!this.faults.stopLife) this.#write(this.#layout.roles.life, {}, { technical: true });
		}, this.#timing.lifeIntervalMs);
	}

	get open(): boolean {
		return !this.#closed;
	}

	/** Sends a telegram that the other side must acknowledge. */
	send(type: string, fields: Fields): void {
		const seq = this.#write(type, fields);
		if (seq !== undefined) this.#expectAck(seq, type, fields, 1);
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
	}

	/** Counts up to the largest number the sequence field holds, then starts again at 1. */
	#nextSeq(): string {
		const max = 10 ** Math.min(this.#seqLength, 15) - 1;
		this.#seq = (this.#seq % max) + 1;
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
		this.#entry(this.local, this.remote, type, seq, fields, options.note, options.technical);
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
					`no acknowledgement after ${tries} tries, given up`
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
				true
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
			this.#entry(this.remote, this.local, telegram.type, seq, telegram.fields, undefined, true);
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
					true
				);
			} else {
				this.#acknowledge(telegram, seq);
			}
		}
		if (duplicate) return;
		this.#seenIn.add(seq);
		// A Set keeps insertion order: its first entry is the oldest number.
		const [oldest] = this.#seenIn;
		if (this.#seenIn.size > SEEN && oldest !== undefined) this.#seenIn.delete(oldest);
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
				true
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
		technical?: boolean
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
			...(technical ? { technical } : {})
		});
	}
}
