// What the OData mock (sap-tests/odata/mock) reports over its control API, checked on arrival: the mock is a
// separate process, so its answers are outside data like any other.
import { z } from 'zod';

export const OdataAnswerSchema = z.discriminatedUnion('mode', [
	z.object({
		mode: z.literal('fail'),
		status: z.number().int(),
		message: z.string(),
		/** Percent of the requests that fail; without it, all. */
		rate: z.number().int().optional(),
		retryAfterSeconds: z.number().int().optional()
	}),
	z.object({
		mode: z.literal('slow'),
		delayMs: z.number().int(),
		/** With it, a random delay from delayMs to this. */
		maxDelayMs: z.number().int().optional()
	})
]);

/** An answer as the page may set it: the limits the mock checks too. */
export const OdataAnswerInputSchema = z.discriminatedUnion('mode', [
	z.object({
		mode: z.literal('fail'),
		status: z.number().int().min(400).max(599),
		message: z.string().trim().min(1).max(500),
		rate: z.number().int().min(1).max(100).optional(),
		retryAfterSeconds: z.number().int().min(0).max(86_400).optional()
	}),
	z
		.object({
			mode: z.literal('slow'),
			delayMs: z.number().int().min(1).max(300_000),
			maxDelayMs: z.number().int().min(1).max(300_000).optional()
		})
		.refine((answer) => answer.maxDelayMs === undefined || answer.maxDelayMs >= answer.delayMs, {
			message: 'The longest delay must not be shorter than the shortest.',
			path: ['maxDelayMs']
		})
]);

const OdataServiceSchema = z.object({ name: z.string(), basePath: z.string() });

export const OdataInfoSchema = z.object({
	instance: z.string(),
	odataUrl: z.string(),
	services: z.array(OdataServiceSchema)
});

const RequestSummarySchema = z.object({
	seq: z.number().int(),
	at: z.string(),
	method: z.string(),
	url: z.string(),
	service: z.string().nullable(),
	/** 0 when the caller hung up before the answer. */
	status: z.number().int(),
	durationMs: z.number(),
	answer: z.enum(['normal', 'fail', 'slow']),
	requestType: z.string().optional(),
	responseType: z.string().optional()
});

export const OdataRequestListSchema = z.object({
	instance: z.string(),
	cursor: z.number().int(),
	/** The oldest request the mock still holds; null when its log is empty. */
	oldest: z.number().int().nullable(),
	requests: z.array(RequestSummarySchema)
});

export const OdataRequestSchema = RequestSummarySchema.extend({
	/** As sent and answered; the mock keeps the values only of headers it knows to be harmless. */
	requestHeaders: z.record(z.string(), z.string()),
	responseHeaders: z.record(z.string(), z.string()),
	requestBody: z.string().optional(),
	requestBodyCut: z.boolean().optional(),
	responseBody: z.string().optional(),
	responseBodyCut: z.boolean().optional()
});

export const OdataEntitySetsSchema = z.array(z.object({ name: z.string(), count: z.number() }));

export const OdataRowsSchema = z.object({
	count: z.number(),
	rows: z.array(z.record(z.string(), z.unknown()))
});

export type OdataAnswer = z.infer<typeof OdataAnswerSchema>;
export type OdataService = z.infer<typeof OdataServiceSchema>;
export type OdataRequestSummary = z.infer<typeof RequestSummarySchema>;
export type OdataRequest = z.infer<typeof OdataRequestSchema>;
export type OdataEntitySet = z.infer<typeof OdataEntitySetsSchema>[number];
export type OdataRows = z.infer<typeof OdataRowsSchema>;

export type OdataStatus = {
	running: boolean;
	startedAt?: string;
	/** Why the last start failed or the mock stopped unexpectedly. */
	error?: string;
};

/** One live update for the Mock OData page. */
export type OdataSnapshot = {
	status: OdataStatus;
	/** Where the mock serves; set while it runs. */
	odataUrl?: string;
	services: OdataService[];
	/** The newest requests, newest last. */
	requests: OdataRequestSummary[];
	/** The services answered other than normally. */
	answers: Record<string, OdataAnswer>;
	/** Whether the API tests this app starts call the mock instead of the system in the settings. */
	forTests: boolean;
};
