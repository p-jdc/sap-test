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

const IdocReplySchema = z.discriminatedUnion('mode', [
	z.object({ mode: z.literal('accept') }),
	z.object({ mode: z.literal('reject'), status: z.number().int(), message: z.string() }),
	z.object({ mode: z.literal('slow'), delayMs: z.number().int() })
]);

export const ReceivedIdocSchema = z.object({
	seq: z.number().int(),
	receivedAt: z.string(),
	partner: z.string(),
	request: z.number().int(),
	soap: z.boolean(),
	root: z.string(),
	accepted: z.boolean(),
	/** False while a slow answer is still on its way. */
	answered: z.boolean(),
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

/** A reply in effect, and whether a running test set it (it then holds until that test ends) or a person. */
export const IdocReplyInEffectSchema = z.intersection(
	IdocReplySchema,
	z.object({ setBy: z.enum(['test', 'person']) })
);

/** The SAP systems the receiver can send IDocs into, as sap-tests/idoc/sender.mts names them. */
export const IDOC_SAP_SYSTEMS = ['s4', 'ewm'] as const;
export type IdocSapSystem = (typeof IDOC_SAP_SYSTEMS)[number];
/** Every setting of those systems (IDOC_S4_URL, IDOC_EWM_PASSWORD and so on; sap-tests/idoc/server.mts). Only the
 * receiver gets them: tests send through it. */
export const IDOC_SAP_SETTINGS = IDOC_SAP_SYSTEMS.flatMap((system) =>
	[
		'URL',
		'CLIENT',
		'SERVICE',
		'USER',
		'PASSWORD',
		'TLS_CERT',
		'TLS_KEY',
		'TLS_CA',
		'TIMEOUT_MS'
	].map((name) => `IDOC_${system.toUpperCase()}_${name}`)
);

/** An SAP system the receiver sends IDocs into, in CPI's place: which login, never the login itself. */
const SapTargetSchema = z.object({
	system: z.enum(IDOC_SAP_SYSTEMS),
	/** S/4HANA or EWM. */
	title: z.string(),
	url: z.string(),
	client: z.string().optional(),
	service: z.enum(['soap', 'xml']),
	login: z.enum(['none', 'user', 'certificate', 'user-and-certificate']),
	/** A stand-in in the receiver's process (IDOC_FAKE_SAP), not an SAP system. */
	standIn: z.boolean().default(false)
});

export const IdocInfoSchema = z.object({
	idocUrl: z.string(),
	instance: z.string(),
	/** The SAP systems set, S/4HANA first; none when none is set. A receiver from before sending to S/4HANA
	 * and EWM existed answers differently: then none either. */
	sap: z.union([
		z.array(SapTargetSchema),
		z.unknown().transform((): z.infer<typeof SapTargetSchema>[] => [])
	])
});

const IdocBodySchema = z.object({
	control: z.record(z.string(), z.string()),
	segments: z.array(SegmentSchema)
});

/** One send into SAP and SAP's answer. */
export const SentIdocsSchema = z.object({
	seq: z.number().int(),
	sentAt: z.string(),
	by: z.enum(['test', 'person']),
	to: z.enum(IDOC_SAP_SYSTEMS),
	/** A stand-in for that system took them, not SAP. */
	standIn: z.boolean(),
	idocs: z.array(IdocBodySchema),
	result: z.object({
		ok: z.boolean(),
		/** 0 when SAP couldn't be reached or didn't answer in time. */
		status: z.number().int(),
		service: z.enum(['soap', 'xml']),
		idocNumbers: z.array(z.string()),
		reason: z.string().optional(),
		body: z.string(),
		durationMs: z.number()
	})
});

export type IdocReply = z.infer<typeof IdocReplySchema>;
export type IdocSapTarget = z.infer<typeof SapTargetSchema>;
export type SentIdocs = z.infer<typeof SentIdocsSchema>;
type IdocReplyInEffect = z.infer<typeof IdocReplyInEffectSchema>;
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
	replies: Record<string, IdocReplyInEffect>;
	failures: IdocFailure[];
	/** Whether the page may post a sample IDoc itself: only to a receiver it started, on this computer, without
	 * TLS. */
	canSendSamples: boolean;
	/** The SAP systems the receiver sends IDocs into, S/4HANA first; none when none is set. */
	sap: IdocSapTarget[];
	/** The newest sends into SAP, newest last. */
	sent: SentIdocs[];
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
