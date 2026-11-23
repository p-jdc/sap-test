// The receiver's memory: every IDoc it was sent, the reply it gave per partner and the requests it refused.
// In memory only, so a run of tests and the receiver must share one process or one running receiver. Shared
// storage follows with the app's database.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Idoc, Segment } from './idoc.mts';
import { SAP_SYSTEMS, type SendResult } from './sender.mts';
import type { ParsedIdocXml } from './xml.mts';

/** How the receiver answers a partner's IDocs. SAP sets status 03 on an accepted IDoc and an error status
 * (for example 02) on a rejected one; a slow answer tests SAP's timeout. */
export const ReplySchema = z.discriminatedUnion('mode', [
	z.object({ mode: z.literal('accept') }),
	z.object({
		mode: z.literal('reject'),
		status: z.number().int().min(400).max(599).default(500),
		message: z.string().max(500).default('Rejected by the IDoc mock')
	}),
	z.object({ mode: z.literal('slow'), delayMs: z.number().int().min(1).max(300_000) })
]);

export type Reply = z.output<typeof ReplySchema>;
export type ReplyInEffect = Reply & { setBy: 'test' | 'person' };
export type ReplyInput = z.input<typeof ReplySchema>;

const ACCEPT: Reply = { mode: 'accept' };

const SegmentSchema: z.ZodType<Segment> = z.lazy(() =>
	z.object({
		name: z.string(),
		fields: z.record(z.string(), z.string()),
		children: z.array(SegmentSchema)
	})
);

export const ReceivedIdocSchema = z.object({
	/** Increases with every IDoc received; a cursor for "everything after this one". */
	seq: z.number().int(),
	receivedAt: z.string(),
	/** The partner in the address SAP sent to: /idoc/<partner>. */
	partner: z.string(),
	/** IDocs that came in the same request share it. */
	request: z.number().int(),
	soap: z.boolean(),
	root: z.string(),
	/** False when SAP sees an error instead of a sent IDoc: the partner's reply mode rejected it, or SAP hung up
	 * before a slow answer came. */
	accepted: z.boolean(),
	/** False while a slow answer is still on its way: whether SAP waits for it is not known yet. */
	answered: z.boolean(),
	reply: z.enum(['accept', 'reject', 'slow']),
	idoc: z.object({ control: z.record(z.string(), z.string()), segments: z.array(SegmentSchema) })
});

export type ReceivedIdoc = z.infer<typeof ReceivedIdocSchema>;

export const FailureSchema = z.object({
	at: z.string(),
	partner: z.string(),
	status: z.number().int(),
	error: z.string(),
	bytes: z.number().int()
});

/** A request the receiver refused before any IDoc was read from it: not IDoc-XML, too large, wrong login. */
export type Failure = z.infer<typeof FailureSchema>;

export const IdocFilterSchema = z.object({
	partner: z.string().optional(),
	/** MESTYP, for example ORDRSP. */
	messageType: z.string().optional(),
	/** IDOCTYP or CIMTYP, for example ORDERS05. */
	idocType: z.string().optional(),
	/** Only IDocs with a higher seq. */
	after: z.coerce.number().int().optional(),
	limit: z.coerce.number().int().min(0).max(1000).optional()
});

export type IdocFilter = z.infer<typeof IdocFilterSchema>;

const ControlSchema = z.record(z.string(), z.string());

export const IdocBodySchema = z.object({
	control: ControlSchema,
	segments: z.array(SegmentSchema)
});

export const SendResultSchema: z.ZodType<SendResult> = z.object({
	ok: z.boolean(),
	status: z.number().int(),
	service: z.enum(['soap', 'xml']),
	idocNumbers: z.array(z.string()),
	reason: z.string().optional(),
	body: z.string(),
	durationMs: z.number()
});

export const SentIdocsSchema = z.object({
	/** Increases with every send; a cursor like the inbox's. */
	seq: z.number().int(),
	sentAt: z.string(),
	/** `test` when a running test sent them (the idocSender fixture), otherwise `person`. */
	by: z.enum(['test', 'person']),
	/** The SAP system they were sent into. */
	to: z.enum(SAP_SYSTEMS),
	/** True when a stand-in for that system took them (IDOC_FAKE_SAP), not the system itself. */
	standIn: z.boolean(),
	/** The IDocs as they went to SAP, with TABNAM and DIRECT filled in. */
	idocs: z.array(IdocBodySchema),
	result: SendResultSchema
});

/** One send into SAP: the IDocs of one request and SAP's answer. */
export type SentIdocs = z.infer<typeof SentIdocsSchema>;

/** A request body as SAP sent it, with the encoding its XML declaration named. */
export interface RawRequest {
	body: Buffer;
	encoding: string;
}

export interface InboxLimits {
	/** IDocs kept; the oldest go first. */
	keep: number;
	/** Bytes of raw request bodies kept, over all requests. */
	rawBudget: number;
	failures: number;
}

const DEFAULT_LIMITS: InboxLimits = { keep: 1000, rawBudget: 50_000_000, failures: 100 };
/** Sends kept. */
const KEEP_SENT = 200;

export class IdocInbox {
	readonly limits: InboxLimits;
	private idocs: ReceivedIdoc[] = [];
	private raw = new Map<number, RawRequest>();
	private rawSize = 0;
	/** Per partner: the reply set without an owner, and the ones tests set for as long as they run. */
	private replies = new Map<string, { base?: Reply; leases: Map<string, Reply> }>();
	private failureLog: Failure[] = [];
	private sentLog: SentIdocs[] = [];
	private nextSent = 1;
	private nextSeq = 1;
	private nextRequest = 1;
	private listeners = new Set<(idoc: ReceivedIdoc) => void>();

	/** New for every receiver start: a client that sees it change knows the numbering began again. */
	readonly instance = randomUUID();

	constructor(limits: Partial<InboxLimits> = {}) {
		this.limits = { ...DEFAULT_LIMITS, ...limits };
	}

	/** The seq of the newest IDoc received so far, 0 before the first. */
	get cursor(): number {
		return this.nextSeq - 1;
	}

	/** The newest reply a running test set for the partner, otherwise the one set without an owner, otherwise
	 * accept. */
	replyFor(partner: string): Reply {
		const entry = this.replies.get(partner);
		return (entry && [...entry.leases.values()].at(-1)) ?? entry?.base ?? ACCEPT;
	}

	/**
	 * Sets a partner's reply. With an owner (a test), it holds until that owner resets it, and other owners'
	 * replies and the one set without an owner come back then. Without an owner, it is the partner's reply for
	 * good.
	 */
	setReply(partner: string, reply: ReplyInput, owner?: string): Reply {
		const parsed = ReplySchema.parse(reply);
		const entry = this.replies.get(partner) ?? { leases: new Map<string, Reply>() };
		if (owner) {
			// Set again, it becomes the newest.
			entry.leases.delete(owner);
			entry.leases.set(owner, parsed);
		} else entry.base = parsed.mode === 'accept' ? undefined : parsed;
		this.replies.set(partner, entry);
		this.prune(partner);
		return parsed;
	}

	/** Takes back the owner's reply, or without an owner the partner's own one. */
	resetReply(partner: string, owner?: string): void {
		const entry = this.replies.get(partner);
		if (!entry) return;
		if (owner) entry.leases.delete(owner);
		else entry.base = undefined;
		this.prune(partner);
	}

	/** The partners whose reply isn't accept, with the reply they get now and who set it: a running test (an
	 * owner) or a person (without an owner). */
	allReplies(): Record<string, ReplyInEffect> {
		const result: Record<string, ReplyInEffect> = {};
		for (const [partner, entry] of this.replies) {
			const reply = this.replyFor(partner);
			if (reply.mode !== 'accept')
				result[partner] = { ...reply, setBy: entry.leases.size > 0 ? 'test' : 'person' };
		}
		return result;
	}

	private prune(partner: string): void {
		const entry = this.replies.get(partner);
		if (entry && !entry.base && entry.leases.size === 0) this.replies.delete(partner);
	}

	/** Records one request's IDocs with the reply they get. */
	add(partner: string, parsed: ParsedIdocXml, raw: RawRequest, reply: Reply): ReceivedIdoc[] {
		const request = this.nextRequest++;
		const receivedAt = new Date().toISOString();
		const added = parsed.idocs.map((idoc: Idoc): ReceivedIdoc => ({
			seq: this.nextSeq++,
			receivedAt,
			partner,
			request,
			soap: parsed.soap,
			root: parsed.root,
			accepted: reply.mode !== 'reject',
			answered: reply.mode !== 'slow',
			reply: reply.mode,
			idoc
		}));
		this.idocs.push(...added);
		this.raw.set(request, raw);
		this.rawSize += raw.body.length;
		this.evict();
		for (const idoc of added) for (const listener of this.listeners) listener(idoc);
		return added;
	}

	/** The slow answer went out: SAP waited for it. */
	markAnswered(seqs: number[]): void {
		for (const idoc of this.idocs) if (seqs.includes(idoc.seq)) idoc.answered = true;
	}

	/** SAP hung up before the slow answer: for SAP these IDocs were not sent. */
	markUnanswered(seqs: number[]): void {
		for (const idoc of this.idocs)
			if (seqs.includes(idoc.seq)) {
				idoc.accepted = false;
				idoc.answered = true;
			}
	}

	fail(failure: Omit<Failure, 'at'>): void {
		this.failureLog.push({ at: new Date().toISOString(), ...failure });
		if (this.failureLog.length > this.limits.failures) this.failureLog.shift();
	}

	failures(): Failure[] {
		return [...this.failureLog];
	}

	/** Records a send into SAP, whatever SAP answered. */
	recordSent(entry: Omit<SentIdocs, 'seq' | 'sentAt'>): SentIdocs {
		const sent = { seq: this.nextSent++, sentAt: new Date().toISOString(), ...entry };
		this.sentLog.push(sent);
		if (this.sentLog.length > KEEP_SENT) this.sentLog.shift();
		return sent;
	}

	clearSent(): void {
		this.sentLog = [];
	}

	/** The sends after the given seq, oldest first. */
	sent(after = 0): SentIdocs[] {
		return this.sentLog.filter((entry) => entry.seq > after);
	}

	list(filter: IdocFilter = {}): ReceivedIdoc[] {
		const { partner, messageType, idocType, after = 0, limit } = filter;
		const found = this.idocs.filter(
			({ seq, partner: p, idoc: { control } }) =>
				seq > after &&
				(partner === undefined || p === partner) &&
				(messageType === undefined || control.MESTYP === messageType) &&
				(idocType === undefined || control.IDOCTYP === idocType || control.CIMTYP === idocType)
		);
		return limit === undefined ? found : found.slice(0, limit);
	}

	get(seq: number): ReceivedIdoc | undefined {
		return this.idocs.find((idoc) => idoc.seq === seq);
	}

	/** The request body an IDoc came in, as SAP sent it, while it is still kept. */
	rawOf(seq: number): RawRequest | undefined {
		const idoc = this.get(seq);
		return idoc && this.raw.get(idoc.request);
	}

	clear(): void {
		this.idocs = [];
		this.raw.clear();
		this.rawSize = 0;
		this.failureLog = [];
	}

	onIdoc(listener: (idoc: ReceivedIdoc) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private evict(): void {
		while (
			this.idocs.length > this.limits.keep ||
			(this.rawSize > this.limits.rawBudget && this.idocs.length > 0)
		) {
			const oldest = this.idocs.shift()!;
			if (this.idocs[0]?.request === oldest.request) continue;
			// The last IDoc of its request is gone, and with it the request's body.
			this.rawSize -= this.raw.get(oldest.request)?.body.length ?? 0;
			this.raw.delete(oldest.request);
		}
	}
}
