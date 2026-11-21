// A stand-in for EWM, so the emulator can run and be tested without an SAP system. It does what EWM's MFS does
// in the simplest form: connects to each PLC channel, reacts to identification results, finds a bin, sends one
// warehouse task per stage between communication points (like layout-oriented storage control) and moves on when
// the PLC confirms. Real EWM replaces it; nothing here is meant to imitate EWM's Customizing or strategies.
import { connect } from 'node:net';
import { Channel, type ChannelTiming, type LogEntry } from './channel.mts';
import { craneBins, deviceFor, type LoadedSetup, type StackerCraneDef } from './setup.mts';
import { fromWire, toWire, type Fields, type Telegram } from './telegram.mts';

export type EwmHuStatus =
	| 'routing'
	| 'stored'
	| 'in-clearing'
	| 'at-pick-point'
	| 'shipped'
	| 'error';

export interface EwmTask {
	tanum: string;
	hu: string;
	src: string;
	dst: string;
	plc: string;
	status: 'open' | 'confirmed' | 'failed';
	result?: string;
	/** Sent with sendTask: not part of an HU's route, so its result doesn't change the HU. */
	raw?: boolean;
}

export interface EwmHu {
	/** The HU ident, or NOREAD-<n> for an HU the identification point couldn't read. */
	hu: string;
	status: EwmHuStatus;
	location: string;
	bin?: string;
	/** Locations confirmed by the PLCs, in order. */
	path: string[];
	/** The identification result EWM received. */
	scan?: string;
	error?: string;
}

interface Plan {
	stages: { src: string; dst: string }[];
	final: EwmHuStatus;
}

export class FakeEwm {
	readonly tasks = new Map<string, EwmTask>();
	readonly hus = new Map<string, EwmHu>();
	#setup: LoadedSetup;
	#timing: ChannelTiming;
	#channels = new Map<string, Channel>();
	#plans = new Map<string, Plan>();
	#craneDown = new Set<string>();
	#reserved = new Set<string>();
	#tanum = 0;
	#noRead = 0;
	#nextAisle = 0;
	#log: (entry: LogEntry) => void;
	#outbox = new Map<string, { type: string; fields: Fields }[]>();
	#timers = new Set<NodeJS.Timeout>();
	#closed = false;
	#reconnectMs: number;

	constructor(options: {
		setup: LoadedSetup;
		timing?: Partial<ChannelTiming>;
		log?: (entry: LogEntry) => void;
		/** Wait before connecting again after a PLC dropped the connection. */
		reconnectMs?: number;
	}) {
		this.#setup = options.setup;
		this.#timing = { ackTimeoutMs: 2000, maxResends: 3, lifeIntervalMs: 10_000, ...options.timing };
		this.#log = options.log ?? (() => undefined);
		this.#reconnectMs = options.reconnectMs ?? 1000;
	}

	/**
	 * Connects to every PLC (`ports` as returned by Emulator.start). Like EWM, it connects again when a PLC drops
	 * the connection, and keeps telegrams it could not send until then.
	 */
	async connect(ports: Record<string, number>, host = '127.0.0.1'): Promise<void> {
		this.#closed = false;
		await Promise.all(
			this.#setup.plcs.map((plc) => {
				const port = ports[plc.id];
				if (port === undefined) return Promise.reject(new Error(`no port for PLC ${plc.id}`));
				return this.#open(plc.id, port, host);
			})
		);
	}

	#open(plc: string, port: number, host: string): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const socket = connect(port, host, () => {
				const channel = new Channel({
					name: plc,
					local: this.#setup.ewm,
					remote: plc,
					layout: this.#setup.layout,
					socket,
					timing: this.#timing,
					log: this.#log,
					onTelegram: (telegram) => this.#onTelegram(telegram),
					onClose: () => {
						if (!this.#closed) this.#reconnect(plc, port, host);
					}
				});
				this.#channels.set(plc, channel);
				const waiting = this.#outbox.get(plc) ?? [];
				this.#outbox.delete(plc);
				for (const { type, fields } of waiting) channel.send(type, fields);
				resolve();
			});
			socket.once('error', (error) => {
				reject(error);
				// A refused reconnect is retried, like the first lost connection.
				if (this.#channels.has(plc) && !this.#closed) this.#reconnect(plc, port, host);
			});
		});
	}

	#reconnect(plc: string, port: number, host: string) {
		const retry = setTimeout(() => {
			this.#timers.delete(retry);
			// The timer callback only starts the attempt; a failed attempt schedules the next one itself.
			this.#open(plc, port, host).catch(() => undefined);
		}, this.#reconnectMs);
		this.#timers.add(retry);
	}

	close(): void {
		this.#closed = true;
		for (const timer of this.#timers) clearTimeout(timer);
		this.#timers.clear();
		for (const channel of this.#channels.values()) channel.close();
	}

	/** Forgets every HU, task and blocked bin: the warehouse EWM knows is empty again (demo scenarios). */
	reset(): void {
		this.tasks.clear();
		this.hus.clear();
		this.#plans.clear();
		this.#craneDown.clear();
		this.#reserved.clear();
		this.#noRead = 0;
		this.#nextAisle = 0;
	}

	hu(hu: string): EwmHu | undefined {
		return this.hus.get(hu);
	}

	/** HUs and the most recent tasks, for the control API. */
	snapshot(lastTasks = 100) {
		return { hus: [...this.hus.values()], tasks: [...this.tasks.values()].slice(-lastTasks) };
	}

	/** Sends a warehouse task as is, without checking it: for tests of the emulator's own checks. */
	sendTask(plc: string, hu: string, src: string, dst: string): string {
		const tanum = this.#newTanum();
		this.tasks.set(tanum, { tanum, hu, src, dst, plc, status: 'open', raw: true });
		this.#sendTask(plc, hu, src, dst, tanum);
		return tanum;
	}

	/** Removes a stored HU to goods issue or to the pick point. */
	retrieve(hu: string, to: string): void {
		const record = this.hus.get(hu);
		if (record?.status !== 'stored' || !record.bin) throw new Error(`HU ${hu} is not stored`);
		const crane = this.#craneOfBin(record.bin);
		this.#start(record, {
			stages: [
				{ src: record.bin, dst: crane.outfeed },
				{ src: crane.outfeed, dst: to }
			],
			final: this.#role(to) === 'pick-point' ? 'at-pick-point' : 'shipped'
		});
	}

	/** Picking at the pick point is done: the rest goes back into storage. */
	picked(hu: string): void {
		const record = this.hus.get(hu);
		if (record?.status !== 'at-pick-point') throw new Error(`HU ${hu} is not at the pick point`);
		this.#putaway(record);
	}

	#onTelegram(telegram: Telegram) {
		const message = fromWire(this.#setup.layout, telegram);
		if (!message) return;
		const { values, code } = message;
		switch (message.kind) {
			case 'scan':
				return this.#onScan(
					values.point ?? '',
					values.hu ?? '',
					code === 'ok',
					values.result ?? ''
				);
			case 'confirmation':
				return this.#onConfirmation(this.#taskOf(values), code, values.result ?? '');
			case 'status':
				if (code === 'down') this.#craneDown.add(values.device ?? '');
				else this.#craneDown.delete(values.device ?? '');
				return;
			default:
				return;
		}
	}

	#onScan(cp: string, hu: string, ok: boolean, result: string) {
		const id = hu || `NOREAD-${++this.#noRead}`;
		const record: EwmHu = { hu: id, status: 'routing', location: cp, path: [cp], scan: result };
		this.hus.set(id, record);
		if (ok && hu) return this.#putaway(record);
		const clearing = this.#setup.points.find((point) => point.role === 'clearing');
		if (!clearing)
			return this.#fail(
				record,
				`HU at ${cp} failed identification (${result}) and there is no clearing point`
			);
		this.#start(record, { stages: [{ src: cp, dst: clearing.id }], final: 'in-clearing' });
	}

	#putaway(record: EwmHu) {
		const crane = this.#chooseCrane();
		if (!crane) return this.#fail(record, 'no stacker crane available');
		const bin = this.#freeBin(crane);
		if (!bin) return this.#fail(record, `aisle ${crane.aisle} is full`);
		this.#reserved.add(bin);
		record.bin = bin;
		this.#start(record, {
			stages: [
				{ src: record.location, dst: crane.infeed },
				{ src: crane.infeed, dst: bin }
			],
			final: 'stored'
		});
	}

	#start(record: EwmHu, plan: Plan) {
		record.status = 'routing';
		this.#plans.set(record.hu, plan);
		this.#next(record);
	}

	#next(record: EwmHu) {
		const plan = this.#plans.get(record.hu);
		const stage = plan?.stages.shift();
		if (!plan || !stage) {
			record.status = plan?.final ?? record.status;
			this.#plans.delete(record.hu);
			return;
		}
		const device = deviceFor(this.#setup, stage.src, stage.dst);
		if (!device) return this.#fail(record, `no route from ${stage.src} to ${stage.dst}`);
		// An HU without ident (no read) is addressed by its position: the task carries no HU number.
		const hu = record.hu.startsWith('NOREAD-') ? '' : record.hu;
		const tanum = this.#newTanum();
		this.tasks.set(tanum, {
			tanum,
			hu: record.hu,
			src: stage.src,
			dst: stage.dst,
			plc: device.plc,
			status: 'open'
		});
		this.#sendTask(device.plc, hu, stage.src, stage.dst, tanum);
	}

	/**
	 * The task a confirmation belongs to: by its number, or, in a layout whose telegrams carry none, the oldest
	 * open task for the same move.
	 */
	#taskOf(values: Record<string, string | undefined>): EwmTask | undefined {
		// Numeric telegram fields arrive with leading zeros.
		if (values.task !== undefined) return this.tasks.get(values.task.replace(/^0+(?=\d)/, ''));
		return [...this.tasks.values()].find(
			(task) =>
				task.status === 'open' && task.src === values.source && task.dst === values.destination
		);
	}

	#onConfirmation(task: EwmTask | undefined, code: string | undefined, result: string) {
		if (!task) return;
		const { tanum } = task;
		task.result = result;
		const record = task.raw ? undefined : this.hus.get(task.hu);
		if (code !== 'ok') {
			task.status = 'failed';
			if (!record) return;
			// The crane found the bin occupied: block it and route the HU to another bin of the same aisle.
			if (code === 'occupied' && record.bin === task.dst) {
				const crane = this.#craneOfBin(task.dst);
				const bin = this.#freeBin(crane);
				if (!bin)
					return this.#fail(
						record,
						`bin ${task.dst} occupied and aisle ${crane.aisle} has no other free bin`
					);
				this.#reserved.add(bin);
				record.bin = bin;
				this.#plans.set(record.hu, { stages: [{ src: task.src, dst: bin }], final: 'stored' });
				return this.#next(record);
			}
			return this.#fail(record, `task ${tanum} ${task.src} → ${task.dst} failed: ${result}`);
		}
		task.status = 'confirmed';
		if (!record) return;
		if (record.bin && task.src === record.bin) {
			this.#reserved.delete(record.bin);
			record.bin = undefined;
		}
		record.location = task.dst;
		record.path.push(task.dst);
		this.#next(record);
	}

	#fail(record: EwmHu, error: string) {
		record.status = 'error';
		record.error = error;
		this.#plans.delete(record.hu);
	}

	#cranes(): StackerCraneDef[] {
		return this.#setup.devices.filter(
			(device): device is StackerCraneDef => device.type === 'stacker-crane'
		);
	}

	/** Round robin over the aisles whose crane is up. */
	#chooseCrane(): StackerCraneDef | undefined {
		const cranes = this.#cranes();
		for (let i = 0; i < cranes.length; i++) {
			const crane = cranes[(this.#nextAisle + i) % cranes.length];
			if (crane && !this.#craneDown.has(crane.id)) {
				this.#nextAisle = (this.#nextAisle + i + 1) % cranes.length;
				return crane;
			}
		}
		return undefined;
	}

	#freeBin(crane: StackerCraneDef): string | undefined {
		return craneBins(crane).find((bin) => !this.#reserved.has(bin));
	}

	#craneOfBin(bin: string): StackerCraneDef {
		const crane = this.#cranes().find((candidate) => bin.startsWith(`${candidate.aisle}-`));
		if (!crane) throw new Error(`no crane serves bin ${bin}`);
		return crane;
	}

	#role(point: string) {
		return this.#setup.points.find((candidate) => candidate.id === point)?.role;
	}

	#sendTask(plc: string, hu: string, source: string, destination: string, task: string) {
		const telegram = toWire(this.#setup.layout, 'task', { hu, source, destination, task });
		if (telegram) this.#send(plc, telegram.type, telegram.fields);
	}

	/** Sends now, or once the PLC is connected again. */
	#send(plc: string, type: string, fields: Fields) {
		const channel = this.#channels.get(plc);
		if (channel?.open) return channel.send(type, fields);
		this.#outbox.set(plc, [...(this.#outbox.get(plc) ?? []), { type, fields }]);
	}

	#newTanum(): string {
		return String(++this.#tanum);
	}
}
