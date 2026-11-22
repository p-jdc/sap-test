// What the IDoc receiver (sap-tests/idoc) reports over its control API, checked on arrival: the receiver is a
// separate process (later a separate service), so its answers are outside data like any other.
import { z } from 'zod';

export type IdocSegment = { name: string; fields: Record<string, string>; children: IdocSegment[] };

const SegmentSchema: z.ZodType<IdocSegment> = z.lazy(() =>
	z.object({
		name: z.string(),
		fields: z.record(z.string(), z.string()),
		children: z.array(SegmentSchema)
	})
);

export const IdocReplySchema = z.discriminatedUnion('mode', [
	z.object({ mode: z.literal('accept') }),
	z.object({ mode: z.literal('reject'), status: z.number().int(), message: z.string() }),
	z.object({ mode: z.literal('slow'), delayMs: z.number().int() })
]);

const ReceivedIdocSchema = z.object({
	seq: z.number().int(),
	receivedAt: z.string(),
	partner: z.string(),
	request: z.number().int(),
	soap: z.boolean(),
	root: z.string(),
	accepted: z.boolean(),
	reply: z.enum(['accept', 'reject', 'slow']),
	idoc: z.object({
		control: z.record(z.string(), z.string()),
		segments: z.array(SegmentSchema)
	})
});

export const IdocListSchema = z.object({
	instance: z.string(),
	cursor: z.number().int(),
	idocs: z.array(ReceivedIdocSchema)
});

export const IdocFailureSchema = z.object({
	at: z.string(),
	partner: z.string(),
	status: z.number().int(),
	error: z.string(),
	bytes: z.number().int()
});

export const IdocInfoSchema = z.object({ idocUrl: z.string(), instance: z.string() });

export type IdocReply = z.infer<typeof IdocReplySchema>;
export type ReceivedIdoc = z.infer<typeof ReceivedIdocSchema>;
type IdocFailure = z.infer<typeof IdocFailureSchema>;

export type IdocStatus = {
	running: boolean;
	/** Run elsewhere (IDOC_HUB_URL): the app only watches and controls it. */
	external: boolean;
	startedAt?: string;
	/** Why the last start failed or the receiver stopped unexpectedly. */
	error?: string;
};

/** How SAP reaches the receiver: what the SM59 destination needs. */
export type IdocEndpoint = {
	/** Base address; SAP posts to `${url}/idoc/<partner>`. */
	url: string;
	https: boolean;
	login: 'none' | 'user' | 'certificate' | 'user-and-certificate';
};

/** One live update for the Mock IDoc page. */
export type IdocSnapshot = {
	status: IdocStatus;
	endpoint?: IdocEndpoint;
	/** Newest last. */
	idocs: ReceivedIdoc[];
	replies: Record<string, IdocReply>;
	failures: IdocFailure[];
	/** Whether the page may post a sample IDoc itself: only to a receiver it started, on this computer, without
	 * TLS. */
	canSendSamples: boolean;
};

/** A sample IDoc from sap-tests/idoc/samples, for trying the receiver without SAP. */
export type IdocSample = {
	/** The file name. */
	name: string;
	/** The first sentence of the file's leading comment, if it has one. */
	description?: string;
};

/** The receiver's answer to a sample, as SAP would get it. */
export type IdocSampleAnswer = {
	status: number;
	/** The reason it gave when refusing: the plain text, or a SOAP fault's message. */
	reason?: string;
	/** The answer as sent. */
	body: string;
};
