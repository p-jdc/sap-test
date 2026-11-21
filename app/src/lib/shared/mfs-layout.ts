// Geometry of the Mock PLC layout diagram: where points, rack bins, rails and HUs are drawn. Pure functions,
// so the diagram component stays a plain renderer.
import type { MfsSetup, MfsState } from './mfs.js';

export const CELL = 16;

type View = NonNullable<MfsSetup['view']>;
type Device = MfsSetup['devices'][number];
type Xy = { x: number; y: number };

export type Rack = {
	crane: string;
	aisle: string;
	x: number;
	y: number;
	stacks: number;
	levels: number;
	infeed?: string;
	outfeed?: string;
};

export function racks(setup: MfsSetup, view: View): Rack[] {
	return setup.devices.flatMap((device) => {
		const at = view.racks[device.id];
		if (device.type !== 'stacker-crane' || !at || !device.aisle) return [];
		const { stacks = 1, levels = 1, aisle, infeed, outfeed } = device;
		return [{ crane: device.id, aisle, ...at, stacks, levels, infeed, outfeed }];
	});
}

/** The cell of a bin like A2-03-01 (aisle, stack, level), level 1 at the bottom of the rack. */
export function binCell(rackList: Rack[], bin: string): (Xy & { rack: Rack }) | undefined {
	const match = /^(.+)-(\d{2})-(\d{2})$/.exec(bin);
	if (!match) return undefined;
	const rack = rackList.find((candidate) => candidate.aisle === match[1]);
	const stack = Number(match[2]);
	const level = Number(match[3]);
	if (!rack || stack < 1 || stack > rack.stacks || level < 1 || level > rack.levels)
		return undefined;
	return { rack, x: rack.x + (stack - 1) * CELL, y: rack.y + (rack.levels - level) * CELL };
}

/** Centre of a point or of a bin cell. */
export function positionOf(view: View, rackList: Rack[], location: string): Xy | undefined {
	const point = view.points[location];
	if (point) return point;
	const cell = binCell(rackList, location);
	return cell ? { x: cell.x + CELL / 2, y: cell.y + CELL / 2 } : undefined;
}

export type Rail = {
	car: string;
	y: number;
	x1: number;
	x2: number;
	stops: Xy[];
	/** Where the car is while it carries an HU, and which HU. */
	at?: number;
	hu?: string;
};

/** A transfer car's rail, its stops, and where the car is while it carries an HU. */
export function rails(setup: MfsSetup, view: View, state?: MfsState): Rail[] {
	return setup.devices.flatMap((device: Device) => {
		const rail = view.rails?.[device.id];
		if (device.type !== 'transfer-car' || !rail || !device.stops) return [];
		const stops = device.stops.flatMap((stop) => (view.points[stop] ? [view.points[stop]] : []));
		const xs = stops.map((stop) => stop.x);
		const carried = state?.hus.find((hu) => hu.moving?.device === device.id);
		const moving = carried?.moving;
		const from = moving && view.points[moving.src];
		const to = moving && view.points[moving.dst];
		return [
			{
				car: device.id,
				y: rail.y,
				x1: Math.min(...xs),
				x2: Math.max(...xs),
				stops,
				at: from && to ? (from.x + to.x) / 2 : undefined,
				hu: carried?.hu
			}
		];
	});
}

export type HuMarker = Xy & { hu: string; moving: boolean };

/**
 * Where to draw each HU that is in the layout and not in a bin (stored HUs fill their bin cell instead). Several
 * HUs at one point are stacked; a moving HU is drawn halfway between source and destination. HUs riding a
 * transfer car are left out: the car shows them (see rails).
 */
export function huMarkers(
	setup: MfsSetup,
	view: View,
	rackList: Rack[],
	state: MfsState | undefined
): HuMarker[] {
	const cars = new Set(
		setup.devices.filter((device) => view.rails?.[device.id]).map((device) => device.id)
	);
	const markers: HuMarker[] = [];
	const perPoint = new Map<string, number>();
	for (const hu of state?.hus ?? []) {
		if (hu.left) continue;
		if (hu.moving) {
			if (cars.has(hu.moving.device)) continue;
			const from = positionOf(view, rackList, hu.moving.src);
			const to = positionOf(view, rackList, hu.moving.dst);
			if (from && to)
				markers.push({ hu: hu.hu, x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, moving: true });
			continue;
		}
		const point = hu.at ? view.points[hu.at] : undefined;
		if (!hu.at || !point) continue;
		const index = perPoint.get(hu.at) ?? 0;
		perPoint.set(hu.at, index + 1);
		markers.push({ hu: hu.hu, x: point.x, y: point.y - 18 - index * 16, moving: false });
	}
	return markers;
}

/** A line from `from` to `to`, shortened at both ends so it stops at the edge of the point circles. */
export function between(
	from: Xy,
	to: Xy,
	gap: number
): { x1: number; y1: number; x2: number; y2: number } {
	const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
	const dx = ((to.x - from.x) / length) * gap;
	const dy = ((to.y - from.y) / length) * gap;
	return { x1: from.x + dx, y1: from.y + dy, x2: to.x - dx, y2: to.y - dy };
}

/** Bins holding an HU, for filling the rack cells. */
export function occupiedBins(rackList: Rack[], state: MfsState | undefined): Map<string, string> {
	const bins = new Map<string, string>();
	for (const hu of state?.hus ?? [])
		if (!hu.left && hu.at && binCell(rackList, hu.at)) bins.set(hu.at, hu.hu);
	return bins;
}
