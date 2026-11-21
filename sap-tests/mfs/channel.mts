// One MFS communication channel: a TCP connection between EWM and a PLC that carries telegrams. Both the
// emulator (PLC side) and the fake EWM use it, so the protocol rules live in one place:
// - every telegram gets a sequence number;
// - every telegram except acknowledgements and life telegrams is acknowledged with its sequence number;
// - an unacknowledged telegram is sent again with the same number, a few times;
// - a repeated number from the other side is acknowledged again but not processed twice;
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

let logCounter = 0;

export class Channel {
	readonly name: string;
	readonly local: string;
	readonly remote: string;
	faults: ChannelFaults = {};
	lastLifeAt = 0;
	#layout: TelegramLayout;
	#socket: Socket;
	#timing: ChannelTiming;
	#framer: Framer;
	#seq = 0;
	#pending = new Map<string, NodeJS.Timeout>();
	#lastSeqIn: string | undefined;
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
		onClose?: () => void;
	}) {
		this.name = options.name;
		this.local = options.local;
		this.remote = options.remote;
		this.#layout = options.layout;
		this.#socket = options.socket;
		this.#timing = options.timing;
		this.#framer = new Framer(options.layout);
		this.#log = options.log;
		this.#onTelegram = options.onTelegram;
		this.#socket.setEncoding('latin1');
		this.#socket.on('data', (chunk: string) => this.#receive(chunk));
		this.#socket.on('error', () => undefined);
		this.#socket.on('close', () => {
			this.#stop();
			options.onClose?.();
		});
		this.#lifeTimer = setInterval(() => {
			if (!this.faults.stopLife) this.#write(this.#layout.roles.life, {});
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
		this.#closed = true;
		clearInterval(this.#lifeTimer);
		for (const timer of this.#pending.values()) clearTimeout(timer);
		this.#pending.clear();
	}

	#nextSeq(): string {
		this.#seq = (this.#seq % 9999) + 1;
		return String(this.#seq);
	}

	#header(seq: string): Fields {
		const { senderField, receiverField, seqField } = this.#layout.roles;
		return { [senderField]: this.local, [receiverField]: this.remote, [seqField]: seq };
	}

	#write(type: string, fields: Fields, seq = this.#nextSeq(), note?: string): string | undefined {
		if (this.#closed) return undefined;
		const frame = encode(this.#layout, type, this.#header(seq), fields);
		this.#socket.write(frame, 'latin1');
		this.#entry(this.local, this.remote, type, seq.padStart(4, '0'), fields, note);
		return seq;
	}

	#expectAck(seq: string, type: string, fields: Fields, tries: number) {
		const key = seq.padStart(4, '0');
		const timer = setTimeout(() => {
			this.#pending.delete(key);
			if (this.#closed) return;
			if (tries > this.#timing.maxResends) {
				this.#entry(
					this.local,
					this.remote,
					type,
					key,
					fields,
					`no acknowledgement after ${tries} tries, given up`
				);
				return;
			}
			this.#write(type, fields, seq, `resent (try ${tries + 1}): no acknowledgement`);
			this.#expectAck(seq, type, fields, tries + 1);
		}, this.#timing.ackTimeoutMs);
		this.#pending.set(key, timer);
	}

	#receive(chunk: string) {
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
		const { roles } = this.#layout;
		const seq = telegram.header[roles.seqField] ?? '';
		if (telegram.type === roles.ack) {
			const acked = telegram.fields[roles.ackSeqField] ?? '';
			clearTimeout(this.#pending.get(acked));
			this.#pending.delete(acked);
			this.#entry(this.remote, this.local, telegram.type, seq, telegram.fields);
			return;
		}
		if (telegram.type === roles.life) {
			this.lastLifeAt = Date.now();
			this.#entry(this.remote, this.local, telegram.type, seq, telegram.fields);
			return;
		}
		const duplicate = seq === this.#lastSeqIn;
		this.#entry(
			this.remote,
			this.local,
			telegram.type,
			seq,
			telegram.fields,
			duplicate ? 'repeated sequence number: acknowledged again, not processed' : undefined
		);
		if (this.faults.dropAcks && this.faults.dropAcks > 0) {
			this.faults.dropAcks--;
			this.#entry(
				this.local,
				this.remote,
				roles.ack,
				'',
				{ [roles.ackSeqField]: seq },
				'acknowledgement withheld (fault)'
			);
		} else {
			this.#write(roles.ack, { [roles.ackSeqField]: seq });
		}
		if (duplicate) return;
		this.#lastSeqIn = seq;
		this.#onTelegram(telegram);
	}

	#entry(from: string, to: string, type: string, seq: string, fields: Fields, note?: string) {
		this.#log({
			n: ++logCounter,
			at: Date.now(),
			channel: this.name,
			from,
			to,
			type,
			seq,
			fields,
			note
		});
	}
}
