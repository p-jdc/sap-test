import { command, query } from '$app/server';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import {
	clearInbox,
	clearSent,
	listSamples,
	PARTNER,
	rawRequest,
	SAMPLE_NAME,
	sendSample,
	sendSampleToSap,
	setPartnerReply,
	startReceiver,
	stopReceiver,
	watchIdoc
} from '#lib/server/idoc.js';

const partnerName = z
	.string()
	.trim()
	.regex(PARTNER, 'Partner names have up to 40 letters, digits, dots, dashes or underscores');

/** Runs an action against the receiver; its refusal (not running, bad input, …) reaches the page as a 409. */
async function act<T>(action: () => Promise<T>): Promise<T> {
	try {
		return await action();
	} catch (e) {
		// `error` throws; the return only tells the linter that nothing comes after it.
		return error(409, e instanceof Error ? e.message : String(e));
	}
}

export const watchIdocLive = query.live(() => watchIdoc());

export const getIdocSamples = query(() => listSamples());

export const getRawIdoc = query(z.number().int().positive(), (seq) => act(() => rawRequest(seq)));

export const startIdocReceiver = command(() => act(() => startReceiver()));

export const stopIdocReceiver = command(() => ({ stopped: stopReceiver() }));

export const clearIdocInbox = command(() => act(() => clearInbox()));

/** How the receiver answers a partner's IDocs, for everyone using it, until it is set back. */
export const setIdocReply = command(
	z.object({
		partner: partnerName,
		reply: z
			.discriminatedUnion('mode', [
				z.object({ mode: z.literal('accept') }),
				z.object({
					mode: z.literal('reject'),
					status: z.number().int().min(400).max(599),
					message: z.string().trim().min(1).max(500)
				}),
				z.object({ mode: z.literal('slow'), delayMs: z.number().int().min(1).max(300_000) })
			])
			.nullable()
	}),
	({ partner, reply }) =>
		act(() => setPartnerReply(partner, reply?.mode === 'accept' ? null : reply))
);

/** Posts a sample IDoc to the receiver in SAP's place, for trying it without an SAP system. */
export const sendIdocSample = command(
	z.object({ name: z.string().regex(SAMPLE_NAME), partner: partnerName }),
	({ name, partner }) => act(() => sendSample(name, partner))
);

/** Sends a sample IDoc into SAP through the receiver, in CPI's place. */
export const sendIdocSampleToSap = command(
	z.object({ name: z.string().regex(SAMPLE_NAME) }),
	({ name }) => act(() => sendSampleToSap(name))
);

export const clearSentIdocs = command(() => act(() => clearSent()));
