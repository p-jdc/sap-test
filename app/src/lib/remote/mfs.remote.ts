import { command, query } from '$app/server';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import {
	listSetups,
	mfsAction,
	SETUP_NAME,
	startEmulator,
	stopEmulator,
	watchMfs
} from '#lib/server/mfs.js';

const huNumber = z
	.string()
	.regex(/^[A-Za-z0-9-]{1,20}$/, 'HU numbers have up to 20 letters, digits or dashes');
/** A PLC, device or point id. */
const objectId = z.string().regex(/^[A-Za-z0-9-]{1,20}$/);

/** Runs an action against the Mock PLC; its refusal (unknown HU, wrong state, …) reaches the page as a 409. */
async function act(path: string, body: unknown) {
	try {
		await mfsAction(path, body);
	} catch (e) {
		error(409, e instanceof Error ? e.message : String(e));
	}
}

export const getMfsSetups = query(() => listSetups());

export const watchMfsLive = query.live(() => watchMfs());

export const startMfs = command(
	z.object({
		setup: z.string().regex(SETUP_NAME),
		mode: z.enum(['ewm', 'demo']),
		speed: z.number().min(0.1).max(100)
	}),
	async (input) => {
		try {
			await startEmulator(input);
		} catch (e) {
			error(409, e instanceof Error ? e.message : String(e));
		}
	}
);

export const stopMfs = command(() => ({ stopped: stopEmulator() }));

export const enterHu = command(
	z.object({
		hu: huNumber,
		idPoint: z.enum(['OK', 'NORD', 'CONT', 'WGHT']),
		binOccupied: z.boolean()
	}),
	({ hu, idPoint, binOccupied }) =>
		act('/hus', { hu, script: { idPoint, ...(binOccupied ? { binOccupied } : {}) } })
);

export const setDeviceStatus = command(
	z.object({ id: objectId, status: z.enum(['UP', 'DOWN']) }),
	({ id, status }) => act(`/devices/${encodeURIComponent(id)}/status`, { status })
);

export const setPlcFaults = command(
	z.object({
		plc: objectId,
		dropAcks: z.number().int().min(0).max(10).optional(),
		stopLife: z.boolean().optional(),
		disconnect: z.boolean().optional()
	}),
	({ plc, ...faults }) => act(`/plcs/${encodeURIComponent(plc)}/faults`, faults)
);

/** Demo only: what a warehouse clerk would trigger in EWM. */
export const ewmRetrieve = command(z.object({ hu: huNumber, to: objectId }), ({ hu, to }) =>
	act(`/ewm/hus/${encodeURIComponent(hu)}/retrieve`, { to })
);

/** Demo only: picking at the pick point is done. */
export const ewmPicked = command(z.object({ hu: huNumber }), ({ hu }) =>
	act(`/ewm/hus/${encodeURIComponent(hu)}/picked`, {})
);
