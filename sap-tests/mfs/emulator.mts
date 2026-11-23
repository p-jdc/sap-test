// The PLC emulator: plays every PLC of a mock setup towards EWM. Each PLC listens on its own TCP port (one
// communication channel); EWM connects and sends warehouse tasks, the emulator moves the HUs through the layout
// and reports back with telegrams, the way the conveyors, the identification point and the cranes would.
// EWM decides the routes; the emulator only checks that each task is physically possible.
import {
	createServer as createHttpServer,
	type IncomingMessage,
	type Server as HttpServer,
	type ServerResponse
} from 'node:http';
import { createServer, type Server } from 'node:net';
import { z } from 'zod';
import { fail, json, readBody, requestTarget, UserError } from './http.mts';
import {
	Channel,
	faultRuleProblems,
	FaultRuleSchema,
	type ChannelFaults,
	type ChannelTiming,
	type FaultRuleInput,
	type LogEntry
} from './channel.mts';
import {
	deviceFor,
	isBinOf,
	isMoving,
	travelMs,
	type DeviceDef,
	type LoadedSetup
} from './setup.mts';
import {
	checkValue,
	encode,
	fromWire,
	toWire,
	wireCode,
	type Fields,
	type MessageKind,
	type Telegram
} from './telegram.mts';

/**
 * Results the emulator reports for an HU at the identification point. These are the emulator's names; the code
 * that travels in the telegram is the telegram layout's (messages.scan.codes).
 */
export const ScanResultSchema = z.enum(['OK', 'NORD', 'CONT', 'WGHT']);
export type ScanResult = z.infer<typeof ScanResultSchema>;

/** Per-HU behaviour a test (or a tester) sets before the HU enters. */
export const HuScriptSchema = z.object({
	/** What the identification point reports for this HU: NORD = no read, CONT = contour error, WGHT = overweight. */
	idPoint: ScanResultSchema.optional(),
	/** The crane finds the destination bin occupied on the next putaway of this HU. */
	binOccupied: z.boolean().optional()
});
export type HuScript = z.infer<typeof HuScriptSchema>;

const SCAN_CODE = { OK: 'ok', NORD: 'noRead', CONT: 'contour', WGHT: 'overweight' } as const;

const EnterBody = z.object({
	hu: z.string().min(1),
	at: z.string().optional(),
	script: HuScriptSchema.optional()
});
const StatusBody = z.object({ status: z.enum(['UP', 'DOWN']) });
const FaultsBody = z.object({
	dropAcks: z.number().int().nonnegative().optional(),
	stopLife: z.boolean().optional(),
	disconnect: z.boolean().optional(),
	/** Replaces the PLC's fault rules; [] clears them. */
	rules: z.array(FaultRuleSchema).max(100).optional()
});
/** A telegram the PLC sends on request: built from type and fields, or raw text exactly as given. */
export const SendBodySchema = z.union([
	z.strictObject({ type: z.string().min(1), fields: z.record(z.string(), z.string()).default({}) }),
	z.strictObject({ raw: z.string().min(1).max(10_000) })
]);
export type SendBody = z.input<typeof SendBodySchema>;

export interface HuState {
	hu: string;
	/** Current location (point or bin); undefined while moving. */
	at: string | undefined;
	moving: { device: string; src: string; dst: string } | undefined;
	left: boolean;
	script: HuScript;
	path: string[];
}

/**
 * What happened, as a kind and fields. Scenarios and tests match on these; the text is for people and may change.
 */
export const EventKindSchema = z.enum([
	'hu-entered',
	'hu-left', // goods issue
	'task-taken',
	'task-refused',
	'delivered',
	'bin-occupied', // `to` is the bin
	'scanned',
	'device-status',
	'ewm-connected',
	'ewm-disconnected',
	'connection-refused', // a second connection while EWM is alive
	'connection-replaced', // a silent connection made way for a new one
	'connection-dropped', // closed by a fault
	'telegrams-kept', // unacknowledged when EWM went away, sent again when it is back
	'telegram-queued', // EWM not connected
	'telegrams-dropped', // the oldest queued ones, EWM away too long
	'telegram-not-sent', // could not be built
	'telegram-ignored', // not one a PLC handles
	'no-telegram', // `message`: the report the layout has no telegram for
	'reset'
]);
export type EventKind = z.infer<typeof EventKindSchema>;

const MOVE = ['plc', 'device', 'hu', 'from', 'to', 'task'] as const;
/** The fields each kind of event carries. A scenario condition may only name these. */
export const EVENT_FIELDS = {
	'hu-entered': ['hu', 'point'],
	'hu-left': ['hu', 'point'],
	'task-taken': MOVE,
	'task-refused': ['plc', 'hu', 'from', 'to', 'task', 'result'],
	delivered: MOVE,
	'bin-occupied': MOVE,
	scanned: ['plc', 'device', 'hu', 'point', 'result'],
	'device-status': ['plc', 'device', 'status'],
	'ewm-connected': ['plc'],
	'ewm-disconnected': ['plc'],
	'connection-refused': ['plc'],
	'connection-replaced': ['plc'],
	'connection-dropped': ['plc'],
	'telegrams-kept': ['plc', 'count'],
	'telegram-queued': ['plc', 'telegram'],
	'telegrams-dropped': ['plc', 'count'],
	'telegram-not-sent': ['plc', 'telegram'],
	'telegram-ignored': ['plc', 'telegram'],
	'no-telegram': ['plc', 'message'],
	reset: []
} as const satisfies Record<EventKind, readonly (keyof EventFacts)[]>;

/** The results an event can report: the emulator's names, the same with any telegram layout. */
export const EVENT_RESULTS: Partial<Record<EventKind, readonly string[]>> = {
	'task-refused': ['noRoute', 'wrongPlc', 'noHu'],
	scanned: ScanResultSchema.options
};

/** The fields an event can carry. Locations: `from`, `to` for a move, `point` for where an HU is. */
export interface EventFacts {
	plc?: string;
	device?: string;
	hu?: string;
	from?: string;
	to?: string;
	point?: string;
	task?: string;
	result?: string;
	status?: string;
	telegram?: string;
	message?: string;
	count?: number;
}
export interface EmulatorEvent extends EventFacts {
	n: number;
	/** When it happened (epoch ms). */
	at: number;
	kind: EventKind;
	text: string;
}

interface Job {
	hu: HuState;
	/** The HU field of the task as EWM sent it (empty after a no-read); the confirmation echoes it. */
	taskHu: string | undefined;
	src: string;
	dst: string;
	/** The task number as EWM sent it; the confirmation echoes it. */
	task: string | undefined;
	/** Moved on by the device itself (no warehouse task, no confirmation). */
	automatic: boolean;
}

interface DeviceState {
	def: DeviceDef;
	status: 'UP' | 'DOWN';
	active: number;
	queue: Job[];
}

interface PlcState {
	id: string;
	server: Server;
	port: number;
	channel: Channel | undefined;
	/** Telegrams for when EWM connects again. `ruled`: it went through the fault rules before, so not again. */
	outbox: { type: string; fields: Fields; ruled?: boolean }[];
	faults: ChannelFaults;
}

export interface EmulatorOptions {
	setup: LoadedSetup;
	host?: string;
	/** First PLC port; the PLCs get consecutive ports in setup order. 0 = random free ports. */
	basePort?: number;
	/** Divides every travel time: 10 runs the warehouse ten times faster. */
	speed?: number;
	timing?: Partial<ChannelTiming>;
	logSize?: number;
}

/** A channel that was silent for this many life intervals is taken for dead. */
const SILENT_INTERVALS = 3;
/** Telegrams kept per PLC while EWM is not connected. */
const OUTBOX_SIZE = 1000;

const defaultTiming: ChannelTiming = { ackTimeoutMs: 2000, maxResends: 3, lifeIntervalMs: 10_000 };

export class Emulator {
	readonly setup: LoadedSetup;
	#host: string;
	#basePort: number;
	#speed: number;
	#timing: ChannelTiming;
	#logSize: number;
	#plcs = new Map<string, PlcState>();
	#devices = new Map<string, DeviceState>();
	#hus = new Map<string, HuState>();
	#log: LogEntry[] = [];
	#events: EmulatorEvent[] = [];
	#eventCounter = 0;
	#timers = new Set<NodeJS.Timeout>();
	#control: HttpServer | undefined;
	#logListeners = new Set<(entry: LogEntry) => void>();
	#eventListeners = new Set<(event: EmulatorEvent) => void>();

	constructor(options: EmulatorOptions) {
		this.setup = options.setup;
		this.#host = options.host ?? '127.0.0.1';
		this.#basePort = options.basePort ?? 0;
		this.#speed = options.speed ?? 1;
		this.#timing = { ...defaultTiming, ...options.timing };
		this.#logSize = options.logSize ?? 5000;
		for (const def of this.setup.devices)
			this.#devices.set(def.id, { def, status: 'UP', active: 0, queue: [] });
	}

	/** Opens one TCP port per PLC. Resolves with the port of each PLC. */
	async start(): Promise<Record<string, number>> {
		let offset = 0;
		for (const plc of this.setup.plcs) {
			const port = this.#basePort === 0 ? 0 : this.#basePort + offset++;
			const state: PlcState = {
				id: plc.id,
				server: createServer(),
				port,
				channel: undefined,
				outbox: [],
				faults: {}
			};
			state.server.on('connection', (socket) => {
				if (state.channel?.open) {
					// EWM can vanish without closing its connection (a pod or the network goes away). The
					// old channel then looks open for good, and EWM could never connect again. A channel
					// that has been silent for several life intervals makes way for the new connection.
					const silent = Date.now() - state.channel.lastHeardAt;
					if (silent <= SILENT_INTERVALS * this.#timing.lifeIntervalMs) {
						this.#event(
							'connection-refused',
							`${plc.id}: second connection refused, the channel is in use`,
							{ plc: plc.id }
						);
						socket.destroy();
						return;
					}
					this.#event(
						'connection-replaced',
						`${plc.id}: nothing heard from EWM for ${Math.round(silent / 1000)} s, the old connection makes way for a new one`,
						{ plc: plc.id }
					);
					state.channel.close();
				}
				state.channel = new Channel({
					name: plc.id,
					local: plc.id,
					remote: this.setup.ewm,
					layout: this.setup.layout,
					socket,
					timing: this.#timing,
					log: (entry) => this.#record(entry),
					onTelegram: (telegram) => this.#onTelegram(plc.id, telegram),
					onClose: (unacknowledged) => {
						this.#event('ewm-disconnected', `${plc.id}: EWM disconnected`, { plc: plc.id });
						if (unacknowledged.length === 0) return;
						// EWM never confirmed these: they go out again, first, when it is back.
						state.outbox.unshift(
							...unacknowledged.map((telegram) => ({ ...telegram, ruled: true }))
						);
						this.#trimOutbox(state);
						this.#event(
							'telegrams-kept',
							`${plc.id}: ${unacknowledged.length} unacknowledged telegram(s) kept until EWM connects again`,
							{ plc: plc.id, count: unacknowledged.length }
						);
					}
				});
				state.channel.faults = state.faults;
				this.#event('ewm-connected', `${plc.id}: EWM connected`, { plc: plc.id });
				for (const { type, fields, ruled } of state.outbox.splice(0))
					state.channel.send(type, fields, { rules: !ruled });
			});
			await new Promise<void>((resolve, reject) => {
				state.server.once('error', reject);
				state.server.listen(port, this.#host, () => resolve());
			});
			const address = state.server.address();
			state.port = typeof address === 'object' && address ? address.port : port;
			this.#plcs.set(plc.id, state);
		}
		return Object.fromEntries([...this.#plcs.values()].map((plc) => [plc.id, plc.port]));
	}

	async stop(): Promise<void> {
		for (const timer of this.#timers) clearTimeout(timer);
		this.#timers.clear();
		for (const plc of this.#plcs.values()) {
			plc.channel?.close();
			await new Promise<void>((resolve) => plc.server.close(() => resolve()));
		}
		if (this.#control) await new Promise<void>((resolve) => this.#control?.close(() => resolve()));
	}

	onLog(listener: (entry: LogEntry) => void): () => void {
		this.#logListeners.add(listener);
		return () => this.#logListeners.delete(listener);
	}

	onEvent(listener: (event: EmulatorEvent) => void): () => void {
		this.#eventListeners.add(listener);
		return () => this.#eventListeners.delete(listener);
	}

	// --- what testers and tests can do --------------------------------------------------------------------------

	/** Puts an HU onto the layout, by default at goods receipt. */
	enter(hu: string, at?: string, script: HuScript = {}): HuState {
		const point = at ?? this.setup.points.find((p) => p.role === 'gr')?.id;
		if (!point || !this.setup.points.some((p) => p.id === point))
			throw new UserError(`unknown point "${at}"`);
		// The HU number travels in telegrams. One that does not fit their layout (too long, other
		// characters) is refused here, not when a device first has to report it.
		try {
			checkValue(this.setup.layout, 'scan', 'hu', hu);
			checkValue(this.setup.layout, 'task', 'hu', hu);
		} catch (error) {
			throw new UserError(
				`HU number not possible in a telegram: ${error instanceof Error ? error.message : String(error)}`
			);
		}
		const existing = this.#hus.get(hu);
		if (existing && !existing.left)
			throw new UserError(`HU ${hu} is already in the layout (at ${existing.at ?? 'a device'})`);
		const state: HuState = {
			hu,
			at: point,
			moving: undefined,
			left: false,
			script: { ...script },
			path: [point]
		};
		this.#hus.set(hu, state);
		this.#event('hu-entered', `HU ${hu} enters at ${point}`, { hu, point });
		this.#arrive(state, point);
		return state;
	}

	/**
	 * Empties the warehouse: forgets every HU, cancels moves in progress, brings every device back up and clears
	 * all faults. For demo scenarios, which start from a known state; a real EWM would still hold its stock.
	 */
	reset(): void {
		for (const timer of this.#timers) clearTimeout(timer);
		this.#timers.clear();
		this.#hus.clear();
		for (const device of this.#devices.values()) {
			device.queue = [];
			device.active = 0;
			if (device.status === 'DOWN') this.setDeviceStatus(device.def.id, 'UP');
		}
		for (const plc of this.#plcs.values()) {
			delete plc.faults.dropAcks;
			delete plc.faults.stopLife;
			delete plc.faults.rules;
			plc.outbox = [];
			plc.channel?.dropDelayed('the warehouse was reset');
		}
		this.#event('reset', 'Reset: the warehouse is empty, all devices are up');
	}

	script(hu: string, script: HuScript): HuState {
		const state = this.#hus.get(hu);
		if (!state) throw new UserError(`unknown HU ${hu}`, 404);
		Object.assign(state.script, script);
		return state;
	}

	setDeviceStatus(id: string, status: 'UP' | 'DOWN'): void {
		const device = this.#devices.get(id);
		if (!device) throw new UserError(`unknown device ${id}`, 404);
		device.status = status;
		this.#event('device-status', `${id} is ${status === 'UP' ? 'up again' : 'down'}`, {
			plc: device.def.plc,
			device: id,
			status
		});
		this.#send(device.def.plc, 'status', { device: id, status: status === 'UP' ? 'up' : 'down' });
		if (status === 'UP') this.#pump(device);
	}

	setFaults(
		plcId: string,
		faults: Omit<ChannelFaults, 'rules'> & { disconnect?: boolean; rules?: FaultRuleInput[] }
	): void {
		const plc = this.#plcs.get(plcId);
		if (!plc) throw new UserError(`unknown PLC ${plcId}`, 404);
		const { disconnect, rules, ...rest } = faults;
		if (rules) {
			const problems = rules.flatMap((rule, index) =>
				faultRuleProblems(this.setup.layout, rule).map((problem) => `rule ${index + 1}: ${problem}`)
			);
			if (problems.length > 0)
				throw new UserError(`fault rules refused:\n- ${problems.join('\n- ')}`);
			// Parsed again: defaults filled in, and a copy, so using a rule up does not change the caller's.
			plc.faults.rules = rules.map((rule) => FaultRuleSchema.parse(rule));
		}
		Object.assign(plc.faults, rest);
		if (disconnect) {
			this.#event('connection-dropped', `${plcId}: connection closed (fault)`, { plc: plcId });
			plc.channel?.close();
		}
	}

	/**
	 * Makes a PLC send a telegram that no device reported: one built from type and fields (it goes through the
	 * fault rules and waits for its acknowledgement like any other), or raw text exactly as given.
	 */
	sendTelegram(plcId: string, body: SendBody): void {
		const plc = this.#plcs.get(plcId);
		if (!plc) throw new UserError(`unknown PLC ${plcId}`, 404);
		const channel = plc.channel;
		if (!channel?.open) throw new UserError(`${plcId}: EWM is not connected`, 409);
		const telegram = SendBodySchema.parse(body);
		if ('raw' in telegram) {
			channel.sendRaw(telegram.raw);
			return;
		}
		try {
			// Built once to check it, so a wrong field is the caller's error and not a lost telegram.
			encode(this.setup.layout, telegram.type, {}, telegram.fields);
		} catch (error) {
			throw new UserError(
				`${plcId}: telegram not possible: ${error instanceof Error ? error.message : String(error)}`
			);
		}
		channel.send(telegram.type, telegram.fields);
	}

	state() {
		return {
			setup: this.setup.name,
			plcs: [...this.#plcs.values()].map((plc) => ({
				id: plc.id,
				port: plc.port,
				connected: plc.channel?.open ?? false,
				lastLifeAt: plc.channel?.lastLifeAt ?? 0,
				faults: plc.faults
			})),
			devices: [...this.#devices.values()].map((device) => ({
				id: device.def.id,
				type: device.def.type,
				plc: device.def.plc,
				status: device.status,
				active: device.active,
				queued: device.queue.length
			})),
			hus: [...this.#hus.values()]
		};
	}

	hu(hu: string): HuState | undefined {
		return this.#hus.get(hu);
	}

	log(since = 0): LogEntry[] {
		return this.#log.filter((entry) => entry.n > since);
	}

	events(since = 0): EmulatorEvent[] {
		return this.#events.filter((event) => event.n > since);
	}

	// --- protocol and layout behaviour -------------------------------------------------------------------------

	#onTelegram(plcId: string, telegram: Telegram) {
		const message = fromWire(this.setup.layout, telegram);
		if (message?.kind === 'task') this.#onTask(plcId, message.values);
		else
			this.#event(
				'telegram-ignored',
				`${plcId}: telegram ${telegram.type} not handled by a PLC, ignored`,
				{ plc: plcId, telegram: telegram.type }
			);
	}

	#onTask(plcId: string, values: Record<string, string | undefined>) {
		const { hu, source: src = '', destination: dst = '', task } = values;
		const label = task ? `task ${task}` : 'task';
		const refuse = (result: string, reason: string) => {
			const code = wireCode(this.setup.layout, 'confirmation', result);
			this.#event(
				'task-refused',
				`${plcId}: ${label} ${src} → ${dst} refused (${code}): ${reason}`,
				{
					plc: plcId,
					hu,
					from: src,
					to: dst,
					task,
					result
				}
			);
			this.#send(plcId, 'confirmation', { hu, source: src, destination: dst, task, result });
		};
		const device = deviceFor(this.setup, src, dst);
		if (!device) return refuse('noRoute', `the layout has no connection from ${src} to ${dst}`);
		if (device.plc !== plcId)
			return refuse('wrongPlc', `${src} → ${dst} is run by ${device.plc}, not ${plcId}`);
		// No HU ident (after a no-read, or a layout whose tasks carry none): the HU standing at the source is meant.
		const state = hu
			? this.#hus.get(hu)
			: [...this.#hus.values()].find((candidate) => candidate.at === src && !candidate.left);
		if (!state || state.left || state.at !== src || this.#isQueued(state))
			return refuse('noHu', `HU ${hu || '(no ident)'} is not waiting at ${src}`);
		const deviceState = this.#devices.get(device.id);
		if (!deviceState) return refuse('noRoute', `device ${device.id} missing`);
		deviceState.queue.push({ hu: state, taskHu: hu, src, dst, task, automatic: false });
		this.#event('task-taken', `${device.id} takes ${label}: HU ${state.hu} ${src} → ${dst}`, {
			plc: plcId,
			device: device.id,
			hu: state.hu,
			from: src,
			to: dst,
			task
		});
		this.#pump(deviceState);
	}

	#isQueued(hu: HuState): boolean {
		for (const device of this.#devices.values())
			if (device.queue.some((job) => job.hu === hu)) return true;
		return false;
	}

	#capacity(def: DeviceDef): number {
		return def.type === 'conveyor' ? def.capacity : 1;
	}

	#pump(device: DeviceState) {
		while (
			device.status === 'UP' &&
			device.active < this.#capacity(device.def) &&
			device.queue.length > 0
		) {
			const job = device.queue.shift();
			if (job) this.#run(device, job);
		}
	}

	#run(device: DeviceState, job: Job) {
		const def = device.def;
		if (!isMoving(def)) return;
		device.active++;
		job.hu.at = undefined;
		job.hu.moving = { device: def.id, src: job.src, dst: job.dst };
		this.#later(travelMs(def, job.src, job.dst) / this.#speed, () => {
			device.active--;
			job.hu.moving = undefined;
			const reply = (result: string) => {
				if (!job.automatic)
					this.#send(def.plc, 'confirmation', {
						hu: job.taskHu,
						source: job.src,
						destination: job.dst,
						task: job.task,
						result
					});
			};
			const facts: EventFacts = {
				plc: def.plc,
				device: def.id,
				hu: job.hu.hu,
				from: job.src,
				to: job.dst,
				task: job.task
			};
			const putaway = def.type === 'stacker-crane' && isBinOf(def, job.dst);
			const occupiedBy = putaway ? this.#occupant(job.dst) : undefined;
			if (putaway && (job.hu.script.binOccupied || occupiedBy)) {
				job.hu.script.binOccupied = false;
				job.hu.at = job.src;
				this.#event(
					'bin-occupied',
					`${def.id}: bin ${job.dst} is occupied${occupiedBy ? ` by HU ${occupiedBy.hu}` : ''}, HU ${job.hu.hu} back at ${job.src}`,
					facts
				);
				reply('occupied');
			} else {
				job.hu.at = job.dst;
				job.hu.path.push(job.dst);
				this.#event('delivered', `${def.id} delivered HU ${job.hu.hu} to ${job.dst}`, facts);
				reply('ok');
				this.#arrive(job.hu, job.dst);
			}
			this.#pump(device);
		});
	}

	#occupant(bin: string): HuState | undefined {
		return [...this.#hus.values()].find((hu) => hu.at === bin && !hu.left);
	}

	/** What happens when an HU arrives at a point: identification, automatic conveyors, leaving the layout. */
	#arrive(hu: HuState, point: string) {
		for (const device of this.#devices.values()) {
			const def = device.def;
			if (def.type === 'id-point' && def.point === point) {
				const result = hu.script.idPoint ?? 'OK';
				this.#event('scanned', `${def.id} reads HU ${hu.hu}: ${result}`, {
					plc: def.plc,
					device: def.id,
					hu: hu.hu,
					point,
					result
				});
				this.#send(def.plc, 'scan', {
					point,
					hu: result === 'NORD' ? '' : hu.hu,
					result: SCAN_CODE[result]
				});
			}
			if (def.type === 'conveyor' && def.automatic && def.from === point) {
				device.queue.push({
					hu,
					taskHu: hu.hu,
					src: def.from,
					dst: def.to,
					task: undefined,
					automatic: true
				});
				this.#pump(device);
			}
		}
		if (this.setup.points.find((p) => p.id === point)?.role === 'gi') {
			hu.left = true;
			this.#event('hu-left', `HU ${hu.hu} leaves the automated area at ${point}`, {
				hu: hu.hu,
				point
			});
		}
	}

	/** Keeps the newest telegrams when EWM stays away for long: status reports pile up without end. */
	#trimOutbox(plc: PlcState) {
		const tooMany = plc.outbox.length - OUTBOX_SIZE;
		if (tooMany <= 0) return;
		plc.outbox.splice(0, tooMany);
		this.#event(
			'telegrams-dropped',
			`${plc.id}: ${tooMany} of the oldest queued telegram(s) dropped, EWM is away too long`,
			{ plc: plc.id, count: tooMany }
		);
	}

	/** Sends what a device has to report, as the telegram the layout has for it. */
	#send(plcId: string, kind: MessageKind, values: Record<string, string | undefined>) {
		const plc = this.#plcs.get(plcId);
		if (!plc) return;
		const telegram = toWire(this.setup.layout, kind, values);
		if (!telegram) {
			this.#event(
				'no-telegram',
				`${plcId}: the telegram layout has no ${kind} telegram, nothing reported`,
				{ plc: plcId, message: kind }
			);
			return;
		}
		const { type, fields } = telegram;
		if (!plc.channel?.open) {
			plc.outbox.push({ type, fields });
			this.#trimOutbox(plc);
			this.#event(
				'telegram-queued',
				`${plcId}: EWM not connected, ${type} queued until it connects`,
				{
					plc: plcId,
					telegram: type
				}
			);
			return;
		}
		// Sending runs from device timers: a telegram that cannot be built must not end the emulator.
		try {
			plc.channel.send(type, fields);
		} catch (error) {
			this.#event(
				'telegram-not-sent',
				`${plcId}: ${type} not sent: ${error instanceof Error ? error.message : String(error)}`,
				{ plc: plcId, telegram: type }
			);
		}
	}

	#later(ms: number, action: () => void) {
		const timer = setTimeout(() => {
			this.#timers.delete(timer);
			action();
		}, ms);
		this.#timers.add(timer);
	}

	#record(entry: LogEntry) {
		this.#log.push(entry);
		if (this.#log.length > this.#logSize) this.#log.splice(0, this.#log.length - this.#logSize);
		for (const listener of this.#logListeners) listener(entry);
	}

	#event(kind: EventKind, text: string, facts: EventFacts = {}) {
		// Fields left undefined are dropped: the event stays the same as JSON and in memory.
		const known = Object.fromEntries(
			Object.entries(facts).filter(([, value]) => value !== undefined && value !== '')
		) as EventFacts;
		const event: EmulatorEvent = { ...known, n: ++this.#eventCounter, at: Date.now(), kind, text };
		this.#events.push(event);
		if (this.#events.length > this.#logSize)
			this.#events.splice(0, this.#events.length - this.#logSize);
		for (const listener of this.#eventListeners) listener(event);
	}

	// --- control API ------------------------------------------------------------------------------------------

	/** Starts the HTTP control API used by tests, the app and testers. Resolves with its port. */
	async listenControl(port = 0): Promise<number> {
		this.#control = createHttpServer((request, response) => {
			this.handle(request, response).catch((error: unknown) => fail(response, error));
		});
		await new Promise<void>((resolve) => this.#control?.listen(port, this.#host, () => resolve()));
		const address = this.#control.address();
		return typeof address === 'object' && address ? address.port : port;
	}

	/** Answers one control API request. Errors are thrown; listenControl turns them into responses. */
	async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const { method, path, parts, params } = requestTarget(request);
		const since = Number(params.get('since') ?? 0);
		if (method === 'GET' && path === '/health') return json(response, 200, { ok: true });
		if (method === 'GET' && path === '/setup') {
			const { layout, ...setup } = this.setup;
			return json(response, 200, { ...setup, interfaceType: layout.interfaceType });
		}
		if (method === 'GET' && path === '/state') return json(response, 200, this.state());
		if (method === 'GET' && path === '/log') return json(response, 200, this.log(since));
		if (method === 'GET' && path === '/events') return json(response, 200, this.events(since));
		if (method === 'POST' && path === '/hus') {
			const body = await readBody(request, EnterBody);
			return json(response, 201, this.enter(body.hu, body.at, body.script));
		}
		if (method === 'POST' && parts[0] === 'hus' && parts[2] === 'script' && parts[1])
			return json(response, 200, this.script(parts[1], await readBody(request, HuScriptSchema)));
		if (method === 'POST' && parts[0] === 'devices' && parts[2] === 'status' && parts[1]) {
			const { status } = await readBody(request, StatusBody);
			this.setDeviceStatus(parts[1], status);
			return json(response, 200, { ok: true });
		}
		if (method === 'POST' && parts[0] === 'plcs' && parts[2] === 'faults' && parts[1]) {
			this.setFaults(parts[1], await readBody(request, FaultsBody));
			return json(response, 200, { ok: true });
		}
		if (method === 'POST' && parts[0] === 'plcs' && parts[2] === 'send' && parts[1]) {
			this.sendTelegram(parts[1], await readBody(request, SendBodySchema));
			return json(response, 200, { ok: true });
		}
		throw new UserError(`no route ${method} ${path}`, 404);
	}
}
