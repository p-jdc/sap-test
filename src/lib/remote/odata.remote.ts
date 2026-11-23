import { command, query } from '$app/server';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import {
	clearOdataRequests,
	ODATA_NAME,
	odataEntitySets,
	odataRequest,
	odataRows,
	resetOdataData,
	setOdataAnswer,
	startOdataMock,
	stopOdataMock,
	useOdataMockForTests,
	watchOdata
} from '#lib/server/odata.js';

const name = z.string().regex(ODATA_NAME, 'Not a service or entity set name');

/** Runs an action against the mock; its refusal (not running, bad input, …) reaches the page as a 409. */
async function act<T>(action: () => Promise<T>): Promise<T> {
	try {
		return await action();
	} catch (e) {
		// `error` throws; the return only tells the linter that nothing comes after it.
		return error(409, e instanceof Error ? e.message : String(e));
	}
}

export const watchOdataLive = query.live(() => watchOdata());

export const getOdataRequest = query(z.number().int().positive(), (seq) =>
	act(() => odataRequest(seq))
);

export const getOdataEntitySets = query(name, (service) => act(() => odataEntitySets(service)));

export const getOdataRows = query(
	z.object({ service: name, set: name, top: z.number().int().min(1).max(200) }),
	({ service, set, top }) => act(() => odataRows(service, set, top))
);

export const startOdata = command(() => act(() => startOdataMock()));

export const stopOdata = command(() => ({ stopped: stopOdataMock() }));

export const clearOdataLog = command(() => act(() => clearOdataRequests()));

export const resetOdata = command(() => act(() => resetOdataData()));

/** Whether the API tests this app starts call the mock instead of the system in the settings. */
export const setOdataForTests = command(z.boolean(), (use) =>
	act(() => {
		useOdataMockForTests(use);
		return Promise.resolve();
	})
);

/** How the mock answers a service's requests, for everyone using it, until it is set back. */
export const setOdataServiceAnswer = command(
	z.object({
		service: name,
		answer: z
			.discriminatedUnion('mode', [
				z.object({
					mode: z.literal('fail'),
					status: z.number().int().min(400).max(599),
					message: z.string().trim().min(1).max(500)
				}),
				z.object({ mode: z.literal('slow'), delayMs: z.number().int().min(1).max(300_000) })
			])
			.nullable()
	}),
	({ service, answer }) => act(() => setOdataAnswer(service, answer))
);
