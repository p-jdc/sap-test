// A mock setup: the warehouse layout an emulator runs (PLCs, communication points, devices) plus the telegram
// layout its PLCs speak. Setups live in setups/<name>/setup.json; later they are generated from a warehouse's
// MFS Customizing instead of written by hand.
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { TelegramLayoutSchema, type TelegramLayout } from './telegram.mts';

/** An id or name: a non-empty string. */
const key = z.string().min(1);
const ms = z.number().positive();

export const PointSchema = z.object({
	id: key,
	role: z.enum(['gr', 'id-point', 'clearing', 'infeed', 'outfeed', 'gi', 'pick-point', 'transfer'])
});

/** Moves HUs from one point to another, several at a time, in order. */
const ConveyorSchema = z.object({
	id: key,
	plc: key,
	type: z.literal('conveyor'),
	from: key,
	to: key,
	travelMs: ms,
	capacity: z.number().int().positive(),
	/** Moves every arriving HU on without waiting for a warehouse task (like an infeed conveyor). */
	automatic: z.boolean().optional()
});

/** Reads the HU arriving at its point and reports it to EWM with the result of its checks. */
const IdPointSchema = z.object({
	id: key,
	plc: key,
	type: z.literal('id-point'),
	point: key,
	checks: z.array(z.string())
});

/** Moves one HU at a time between any two of its stops. */
const TransferCarSchema = z.object({
	id: key,
	plc: key,
	type: z.literal('transfer-car'),
	stops: z.array(key).min(2),
	msPerStop: ms
});

/** Stores HUs from its infeed into a bin of its aisle and retrieves them to its outfeed, one at a time. */
const StackerCraneSchema = z.object({
	id: key,
	plc: key,
	type: z.literal('stacker-crane'),
	aisle: key,
	infeed: key,
	outfeed: key,
	stacks: z.number().int().positive().max(99),
	levels: z.number().int().positive().max(99),
	travelMs: ms
});

const Position = z.object({ x: z.number(), y: z.number() });

/** Where things are drawn in the app's layout diagram. Optional: a setup without it runs, but isn't drawn. */
const ViewSchema = z.object({
	width: z.number().positive(),
	height: z.number().positive(),
	points: z.record(z.string(), Position),
	/** Stacker crane id → top-left corner of its rack. */
	racks: z.record(z.string(), Position),
	/** Transfer car id → the height of its rail. */
	rails: z.record(z.string(), z.object({ y: z.number() })).optional()
});

export const SetupSchema = z.object({
	name: key,
	description: z.string(),
	telegramLayout: key,
	/** The sender/receiver id EWM uses in telegrams. */
	ewm: key,
	plcs: z.array(z.object({ id: key, description: z.string() })).min(1),
	points: z.array(PointSchema),
	devices: z.array(
		z.discriminatedUnion('type', [
			ConveyorSchema,
			IdPointSchema,
			TransferCarSchema,
			StackerCraneSchema
		])
	),
	view: ViewSchema.optional()
});

export type PointDef = z.infer<typeof PointSchema>;
export type PointRole = PointDef['role'];
export type ConveyorDef = z.infer<typeof ConveyorSchema>;
export type IdPointDef = z.infer<typeof IdPointSchema>;
export type TransferCarDef = z.infer<typeof TransferCarSchema>;
export type StackerCraneDef = z.infer<typeof StackerCraneSchema>;
export type Setup = z.infer<typeof SetupSchema>;
export type DeviceDef = Setup['devices'][number];
/** Devices that move HUs (an identification point only reads them). */
export type MovingDeviceDef = ConveyorDef | TransferCarDef | StackerCraneDef;

export const isMoving = (device: DeviceDef): device is MovingDeviceDef =>
	device.type !== 'id-point';

export interface LoadedSetup extends Setup {
	layout: TelegramLayout;
}

const mfsDir = new URL('./', import.meta.url);

/** A setup or layout is a folder or file name here, never a path: it comes from the environment or a request. */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function fileName(name: string, what: string): string {
	if (!FILE_NAME.test(name) || name.includes('..'))
		throw new Error(`"${name}" is not the name of a ${what}`);
	return encodeURIComponent(name);
}

export function loadSetup(name: string): LoadedSetup {
	const setup = readJson(
		new URL(`setups/${fileName(name, 'mock setup')}/setup.json`, mfsDir),
		SetupSchema
	);
	const layout = readJson(
		new URL(`layouts/${fileName(setup.telegramLayout, 'telegram layout')}.telegram.json`, mfsDir),
		TelegramLayoutSchema
	);
	const errors = validateSetup(setup);
	const idLength = layout.header.find((def) => def.name === layout.roles.senderField)?.length ?? 0;
	for (const id of [setup.ewm, ...setup.plcs.map((plc) => plc.id)])
		if (id.length > idLength)
			errors.push(`"${id}" is longer than the sender field (${idLength} characters)`);
	if (errors.length > 0) throw new Error(`setup ${name} is invalid:\n- ${errors.join('\n- ')}`);
	return { ...setup, layout };
}

/** Reads a JSON file and checks it against a schema; the error names the file and every wrong field. */
export function readJson<T>(file: URL, schema: z.ZodType<T>): T {
	const result = schema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
	if (!result.success)
		throw new Error(`${file.pathname} is invalid:\n${z.prettifyError(result.error)}`);
	return result.data;
}

/** Bin ids of a stacker crane's aisle: <aisle>-<stack>-<level>, e.g. A1-03-02. */
export function craneBins(crane: StackerCraneDef): string[] {
	const bins: string[] = [];
	for (let stack = 1; stack <= crane.stacks; stack++)
		for (let level = 1; level <= crane.levels; level++)
			bins.push(
				`${crane.aisle}-${String(stack).padStart(2, '0')}-${String(level).padStart(2, '0')}`
			);
	return bins;
}

export function isBinOf(crane: StackerCraneDef, location: string): boolean {
	const match = new RegExp(`^${crane.aisle}-(\\d{2})-(\\d{2})$`).exec(location);
	if (!match) return false;
	const stack = Number(match[1]);
	const level = Number(match[2]);
	return stack >= 1 && stack <= crane.stacks && level >= 1 && level <= crane.levels;
}

/**
 * The device that physically connects `src` to `dst`, or undefined when the layout has no such connection. The
 * emulator refuses a warehouse task without one: EWM's routing (layout-oriented storage control) and the real
 * conveyors disagree, which is a Customizing error worth finding before it reaches a real warehouse.
 */
export function deviceFor(setup: Setup, src: string, dst: string): MovingDeviceDef | undefined {
	for (const device of setup.devices) {
		switch (device.type) {
			case 'conveyor':
				if (device.from === src && device.to === dst) return device;
				break;
			case 'transfer-car':
				if (src !== dst && device.stops.includes(src) && device.stops.includes(dst)) return device;
				break;
			case 'stacker-crane':
				if (src === device.infeed && isBinOf(device, dst)) return device;
				if (isBinOf(device, src) && dst === device.outfeed) return device;
				break;
			case 'id-point':
				break;
		}
	}
	return undefined;
}

export function travelMs(device: MovingDeviceDef, src: string, dst: string): number {
	if (device.type !== 'transfer-car') return device.travelMs;
	const stops = Math.abs(device.stops.indexOf(src) - device.stops.indexOf(dst));
	return Math.max(1, stops) * device.msPerStop;
}

export function validateSetup(setup: Setup): string[] {
	const errors: string[] = [];
	const plcs = new Set(setup.plcs.map((plc) => plc.id));
	const points = new Set(setup.points.map((point) => point.id));
	const knownPoint = (owner: string, id: string) => {
		if (!points.has(id)) errors.push(`${owner}: unknown point "${id}"`);
	};
	const ids = new Set<string>();
	for (const device of setup.devices) {
		if (ids.has(device.id)) errors.push(`device id "${device.id}" is used twice`);
		ids.add(device.id);
		if (!plcs.has(device.plc)) errors.push(`${device.id}: unknown PLC "${device.plc}"`);
		switch (device.type) {
			case 'conveyor':
				knownPoint(device.id, device.from);
				knownPoint(device.id, device.to);
				break;
			case 'id-point':
				knownPoint(device.id, device.point);
				break;
			case 'transfer-car':
				for (const stop of device.stops) knownPoint(device.id, stop);
				break;
			case 'stacker-crane':
				knownPoint(device.id, device.infeed);
				knownPoint(device.id, device.outfeed);
				break;
		}
	}
	if (setup.view) {
		for (const point of Object.keys(setup.view.points)) knownPoint('view', point);
		for (const point of points)
			if (!setup.view.points[point]) errors.push(`view: no position for point "${point}"`);
		const devices = new Map(setup.devices.map((device) => [device.id, device.type]));
		for (const crane of Object.keys(setup.view.racks))
			if (devices.get(crane) !== 'stacker-crane')
				errors.push(`view: "${crane}" is not a stacker crane`);
		for (const car of Object.keys(setup.view.rails ?? {}))
			if (devices.get(car) !== 'transfer-car') errors.push(`view: "${car}" is not a transfer car`);
	}
	return errors;
}
