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
import { Channel, type ChannelFaults, type ChannelTiming, type LogEntry } from './channel.mts';
import {
	deviceFor,
	isBinOf,
	isMoving,
	travelMs,
	type DeviceDef,
	type LoadedSetup
} from './setup.mts';
import { encode, type Fields, type Telegram } from './telegram.mts';

/** Results the emulator reports for an HU at the identification point. */
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

const EnterBody = z.object({
	hu: z.string().min(1),
	at: z.string().optional(),
	script: HuScriptSchema.optional()
});
const StatusBody = z.object({ status: z.enum(['UP', 'DOWN']) });
const FaultsBody = z.object({
	dropAcks: z.number().int().nonnegative().optional(),
	stopLife: z.boolean().optional(),
	disconnect: z.boolean().optional()
});

export interface HuState {
	hu: string;
	/** Current location (point or bin); undefined while moving. */
	at: string | undefined;
	moving: { device: string; src: string; dst: string } | undefined;
	left: boolean;
	script: HuScript;
	path: string[];
}

export interface EmulatorEvent {
	n: number;
	at: number;
	text: string;
	hu?: string;
	device?: string;
}

interface Job {
	hu: HuState;
	/** The HU field of the task as EWM sent it (empty after a no-read); the confirmation echoes it. */
	taskHu: string;
	src: string;
	dst: string;
	tanum: string;
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
	outbox: { type: string; fields: Fields }[];
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
					this.#event(`${plc.id}: second connection refused, the channel is in use`);
					socket.destroy();
					return;
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
					onClose: () => this.#event(`${plc.id}: EWM disconnected`)
				});
				state.channel.faults = state.faults;
				this.#event(`${plc.id}: EWM connected`);
				for (const { type, fields } of state.outbox.splice(0)) state.channel.send(type, fields);
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
			encode(this.setup.layout, 'SCAN', {}, { hu });
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
		this.#event(`HU ${hu} enters at ${point}`, { hu });
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
			plc.outbox = [];
		}
		this.#event('Reset: the warehouse is empty, all devices are up');
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
		this.#event(`${id} is ${status === 'UP' ? 'up again' : 'down'}`, { device: id });
		this.#send(device.def.plc, 'STAT', { device: id, status });
		if (status === 'UP') this.#pump(device);
	}

	setFaults(plcId: string, faults: ChannelFaults & { disconnect?: boolean }): void {
		const plc = this.#plcs.get(plcId);
		if (!plc) throw new UserError(`unknown PLC ${plcId}`, 404);
		const { disconnect, ...rest } = faults;
		Object.assign(plc.faults, rest);
		if (disconnect) {
			this.#event(`${plcId}: connection closed (fault)`);
			plc.channel?.close();
		}
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
		if (telegram.type === 'WT') this.#onTask(plcId, telegram.fields);
		else this.#event(`${plcId}: telegram ${telegram.type} not handled by a PLC, ignored`);
	}

	#onTask(plcId: string, fields: Fields) {
		const { hu = '', src = '', dst = '', tanum = '' } = fields;
		const refuse = (result: string, reason: string) => {
			this.#event(`${plcId}: task ${tanum} ${src} → ${dst} refused (${result}): ${reason}`, { hu });
			this.#send(plcId, 'WTCO', { hu, src, dst, tanum, result });
		};
		const device = deviceFor(this.setup, src, dst);
		if (!device) return refuse('NORT', `the layout has no connection from ${src} to ${dst}`);
		if (device.plc !== plcId)
			return refuse('WPLC', `${src} → ${dst} is run by ${device.plc}, not ${plcId}`);
		// No HU ident (after a no-read): the HU standing at the source is meant.
		const state = hu
			? this.#hus.get(hu)
			: [...this.#hus.values()].find((candidate) => candidate.at === src && !candidate.left);
		if (!state || state.left || state.at !== src || this.#isQueued(state))
			return refuse('NOHU', `HU ${hu || '(no ident)'} is not waiting at ${src}`);
		const deviceState = this.#devices.get(device.id);
		if (!deviceState) return refuse('NORT', `device ${device.id} missing`);
		deviceState.queue.push({ hu: state, taskHu: hu, src, dst, tanum, automatic: false });
		this.#event(`${device.id} takes task ${tanum}: HU ${state.hu} ${src} → ${dst}`, {
			hu: state.hu,
			device: device.id
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
					this.#send(def.plc, 'WTCO', {
						hu: job.taskHu,
						src: job.src,
						dst: job.dst,
						tanum: job.tanum,
						result
					});
			};
			const putaway = def.type === 'stacker-crane' && isBinOf(def, job.dst);
			const occupiedBy = putaway ? this.#occupant(job.dst) : undefined;
			if (putaway && (job.hu.script.binOccupied || occupiedBy)) {
				job.hu.script.binOccupied = false;
				job.hu.at = job.src;
				this.#event(
					`${def.id}: bin ${job.dst} is occupied${occupiedBy ? ` by HU ${occupiedBy.hu}` : ''}, HU ${job.hu.hu} back at ${job.src}`,
					{
						hu: job.hu.hu,
						device: def.id
					}
				);
				reply('OCCU');
			} else {
				job.hu.at = job.dst;
				job.hu.path.push(job.dst);
				this.#event(`${def.id} delivered HU ${job.hu.hu} to ${job.dst}`, {
					hu: job.hu.hu,
					device: def.id
				});
				reply('OK');
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
				this.#event(`${def.id} reads HU ${hu.hu}: ${result}`, { hu: hu.hu, device: def.id });
				this.#send(def.plc, 'SCAN', { cp: point, hu: result === 'NORD' ? '' : hu.hu, result });
			}
			if (def.type === 'conveyor' && def.automatic && def.from === point) {
				device.queue.push({
					hu,
					taskHu: hu.hu,
					src: def.from,
					dst: def.to,
					tanum: '',
					automatic: true
				});
				this.#pump(device);
			}
		}
		if (this.setup.points.find((p) => p.id === point)?.role === 'gi') {
			hu.left = true;
			this.#event(`HU ${hu.hu} leaves the automated area at ${point}`, { hu: hu.hu });
		}
	}

	#send(plcId: string, type: string, fields: Fields) {
		const plc = this.#plcs.get(plcId);
		if (!plc) return;
		if (!plc.channel?.open) {
			plc.outbox.push({ type, fields });
			this.#event(`${plcId}: EWM not connected, ${type} queued until it connects`);
			return;
		}
		// Sending runs from device timers: a telegram that cannot be built must not end the emulator.
		try {
			plc.channel.send(type, fields);
		} catch (error) {
			this.#event(
				`${plcId}: ${type} not sent: ${error instanceof Error ? error.message : String(error)}`
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

	#event(text: string, extra: { hu?: string; device?: string } = {}) {
		const event = { n: ++this.#eventCounter, at: Date.now(), text, ...extra };
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
		throw new UserError(`no route ${method} ${path}`, 404);
	}
}
