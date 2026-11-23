// IDocs for tests: what SAP sent to the IDoc receiver (idoc/receiver.mts), and IDocs sent into SAP through it in
// CPI's place. Specs that check IDocs import `test` and `expect` from here; the OData fixtures and the SAP locators
// stay available, so one test can run a business step in the UI or over the API and then wait for the IDoc it
// produced, or send an IDoc and check the document SAP made from it.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { test as base, expect } from './odata';
import { isInsecureHttp } from './secure-url';
// Types only from idoc/: its ES modules must not be loaded through this CommonJS file as well, or a worker that
// also loads the receiver (tests/_idoc) gets two copies of them, and the second has no named exports.
import type { Idoc, Segment } from '../idoc/idoc.mts';
import type { ReceivedIdoc, ReplyInput, SentIdocs } from '../idoc/inbox.mts';
import type { SapSystem, SendResult } from '../idoc/sender.mts';

export type { ReceivedIdoc, ReplyInput, SentIdocs } from '../idoc/inbox.mts';
export type { Idoc } from '../idoc/idoc.mts';

export interface IdocMatch {
	/** The partner in the receiver's address (/idoc/<partner>), for example PWMOCK. */
	partner?: string;
	/** MESTYP, for example ORDRSP. */
	messageType?: string;
	/** IDOCTYP or CIMTYP, for example ORDERS05. */
	idocType?: string;
	/** Any further condition, for example on a document number in a segment. */
	where?: (received: ReceivedIdoc) => boolean;
}

export interface IdocInbox {
	/**
	 * Waits for the first IDoc received since the test started that matches, and returns it. Fails after the
	 * timeout (default 60 s: SAP may send IDocs in a scheduled job) and lists what did arrive.
	 */
	waitFor(match: IdocMatch, options?: { timeout?: number }): Promise<ReceivedIdoc>;
	/** The IDocs received since the test started that match, oldest first. */
	received(match?: IdocMatch): Promise<ReceivedIdoc[]>;
	/** How the receiver answers this partner's IDocs, until the end of the test. Then the reply that applied
	 * without this test is back, also when other tests set replies meanwhile. */
	reply(partner: string, reply: ReplyInput): Promise<void>;
}

export interface IdocSender {
	/**
	 * Sends IDocs into SAP through the receiver, as CPI's IDoc adapter would: IDoc-XML (a sample file's text), one
	 * IDoc or several of one type. TABNAM and DIRECT 2 are filled in. Fails unless SAP took them; with
	 * `{ expectOk: false }` it returns SAP's refusal instead, for negative tests.
	 * `result.idocNumbers` holds the numbers SAP gave the IDocs, for checking them in WE02 or BD87.
	 * `to` names the SAP system: `s4` (default) or `ewm`.
	 */
	send(
		idocs: string | Idoc | Idoc[],
		options?: { to?: SapSystem; expectOk?: boolean }
	): Promise<SentIdocs>;
}

export interface IdocFixtures {
	/** The IDoc receiver's inbox: IDOC_HUB_URL (its control API) and, beyond this computer, IDOC_HUB_TOKEN.
	 * Skips the test when IDOC_HUB_URL is not set. */
	idocInbox: IdocInbox;
	/** Sends IDocs into SAP through the same receiver, which holds the SAP system and its login
	 * (IDOC_S4_URL, IDOC_EWM_URL and the rest there). Skips the test when IDOC_HUB_URL is not set. */
	idocSender: IdocSender;
}

// The receiver's answers, checked. The type annotations make the compiler catch any drift from idoc/inbox.mts.
const SegmentSchema: z.ZodType<Segment> = z.lazy(() =>
	z.object({
		name: z.string(),
		fields: z.record(z.string(), z.string()),
		children: z.array(SegmentSchema)
	})
);
const ReceivedSchema: z.ZodType<ReceivedIdoc> = z.object({
	seq: z.number().int(),
	receivedAt: z.string(),
	partner: z.string(),
	request: z.number().int(),
	soap: z.boolean(),
	root: z.string(),
	accepted: z.boolean(),
	answered: z.boolean(),
	reply: z.enum(['accept', 'reject', 'slow']),
	idoc: z.object({ control: z.record(z.string(), z.string()), segments: z.array(SegmentSchema) })
});
const ListSchema = z.object({
	/** Changes when the receiver restarts. */
	instance: z.string(),
	cursor: z.number().int(),
	idocs: z.array(ReceivedSchema)
});
const SendResultSchema: z.ZodType<SendResult> = z.object({
	ok: z.boolean(),
	status: z.number().int(),
	service: z.enum(['soap', 'xml']),
	idocNumbers: z.array(z.string()),
	reason: z.string().optional(),
	body: z.string(),
	durationMs: z.number()
});
const SentSchema: z.ZodType<SentIdocs> = z.object({
	seq: z.number().int(),
	sentAt: z.string(),
	by: z.enum(['test', 'person']),
	to: z.enum(['s4', 'ewm']),
	idocs: z.array(
		z.object({ control: z.record(z.string(), z.string()), segments: z.array(SegmentSchema) })
	),
	result: SendResultSchema
});
const POLL_MS = 1000;

class InboxClient {
	private readonly url: string;
	private readonly token: string | undefined;

	constructor(url: string, token: string | undefined) {
		this.url = url.replace(/\/+$/, '');
		this.token = token;
	}

	async call(method: string, path: string, body?: unknown): Promise<unknown> {
		const headers = new Headers({ 'content-type': 'application/json' });
		if (this.token) headers.set('authorization', `Bearer ${this.token}`);
		const response = await fetch(`${this.url}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body)
		});
		const text = await response.text();
		if (!response.ok)
			throw new Error(`IDoc receiver: ${method} ${path} answered ${response.status}: ${text}`);
		return text ? (JSON.parse(text) as unknown) : undefined;
	}

	async list(match: IdocMatch, after: number) {
		const query = new URLSearchParams({ after: String(after) });
		if (match.partner) query.set('partner', match.partner);
		if (match.messageType) query.set('messageType', match.messageType);
		if (match.idocType) query.set('idocType', match.idocType);
		const { instance, cursor, idocs } = ListSchema.parse(await this.call('GET', `/idocs?${query}`));
		return { instance, cursor, idocs: match.where ? idocs.filter(match.where) : idocs };
	}
}

const describe = (match: IdocMatch) =>
	[
		match.idocType && `type ${match.idocType}`,
		match.messageType && `message type ${match.messageType}`,
		match.partner && `for ${match.partner}`,
		match.where && 'matching the condition'
	]
		.filter(Boolean)
		.join(', ') || 'any';

const summary = ({ seq, partner, idoc: { control } }: ReceivedIdoc) =>
	`#${seq} ${control.IDOCTYP ?? '?'}/${control.MESTYP ?? '?'} for ${partner}`;

/** The receiver's control API from IDOC_HUB_URL and IDOC_HUB_TOKEN; skips the test without it. */
function hubClient(testInfo: { skip(condition: boolean, description: string): void }) {
	const url = process.env.IDOC_HUB_URL;
	testInfo.skip(!url, 'missing env: IDOC_HUB_URL');
	const token = process.env.IDOC_HUB_TOKEN || undefined;
	if (token && isInsecureHttp(url!))
		throw new Error(
			'IDOC_HUB_URL must start with https://: over http:// the control token would cross the network unencrypted.'
		);
	return new InboxClient(url!, token);
}

const sentSummary = (idocs: string | Idoc | Idoc[]) => {
	if (typeof idocs === 'string') return 'IDoc-XML';
	const list = Array.isArray(idocs) ? idocs : [idocs];
	const { IDOCTYP, MESTYP } = list[0]?.control ?? {};
	return `${list.length} × ${IDOCTYP ?? '?'}/${MESTYP ?? '?'}`;
};

export const test = base.extend<IdocFixtures>({
	// oxlint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form
	idocSender: async ({}, use, testInfo) => {
		const client = hubClient(testInfo);
		await use({
			send: (idocs, options = {}) =>
				base.step(`idocSender.send ${sentSummary(idocs)} to ${options.to ?? 's4'}`, async () => {
					const to = options.to ?? 's4';
					const body =
						typeof idocs === 'string'
							? { xml: idocs, to, by: 'test' }
							: { idocs: Array.isArray(idocs) ? idocs : [idocs], to, by: 'test' };
					const sent = SentSchema.parse(await client.call('POST', '/send', body));
					const { ok, status, reason, idocNumbers } = sent.result;
					if ((options.expectOk ?? true) && !ok)
						throw new Error(
							`${to === 's4' ? 'S/4HANA' : 'EWM'} did not take the IDocs (${status === 0 ? 'not reached' : `HTTP ${status}`}): ${reason ?? 'no reason given'}`
						);
					if (ok && idocNumbers.length > 0)
						await testInfo.attach('IDoc numbers', { body: idocNumbers.join('\n') });
					return sent;
				})
		});
	},
	// oxlint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form
	idocInbox: async ({}, use, testInfo) => {
		const client = hubClient(testInfo);
		// Everything before this point belongs to earlier tests.
		let { instance, cursor: start } = await client.list({}, Number.MAX_SAFE_INTEGER);
		/** The IDocs since the test started. A receiver that restarted meanwhile (a new instance) numbers from 1
		 * again: then everything it holds arrived during the test. */
		const sinceStart = async (match: IdocMatch) => {
			const found = await client.list(match, start);
			if (found.instance === instance) return found.idocs;
			instance = found.instance;
			start = 0;
			return (await client.list(match, start)).idocs;
		};
		// The replies this test sets are its own: the receiver drops them when the test hands them back, and
		// whatever another run or a person set for the partner applies again.
		const owner = randomUUID();
		const repliedTo = new Set<string>();
		const replyPath = (partner: string) => `/replies/${encodeURIComponent(partner)}?owner=${owner}`;

		await use({
			waitFor: (match, options = {}) =>
				base.step(`idocInbox.waitFor ${describe(match)}`, async () => {
					const timeout = options.timeout ?? 60_000;
					const deadline = Date.now() + timeout;
					for (;;) {
						const [first] = await sinceStart(match);
						if (first) return first;
						if (Date.now() >= deadline) break;
						await new Promise((resolve) => setTimeout(resolve, POLL_MS));
					}
					const all = await sinceStart({});
					const seen = all.length > 0 ? all.map(summary).join('; ') : 'none';
					throw new Error(
						`No IDoc (${describe(match)}) arrived within ${timeout / 1000} s. Received since the test started: ${seen}.`
					);
				}),
			received: (match = {}) => sinceStart(match),
			reply: (partner, reply) =>
				base.step(`idocInbox.reply ${partner}: ${reply.mode}`, async () => {
					await client.call('PUT', replyPath(partner), reply);
					repliedTo.add(partner);
				})
		});

		for (const partner of repliedTo) await client.call('DELETE', replyPath(partner));
	}
});

export { expect };
export type { Locator, Page } from './index';
