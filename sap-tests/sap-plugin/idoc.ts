// IDocs for tests: what SAP sent to the IDoc receiver (idoc/receiver.mts). Specs that check IDocs import `test` and
// `expect` from here; the OData fixtures and the SAP locators stay available, so one test can run a business step
// in the UI or over the API and then wait for the IDoc it produced.
import { z } from 'zod';
import { test as base, expect } from './odata';
import { isInsecureHttp } from './secure-url';
// Types only from idoc/: its ES modules must not be loaded through this CommonJS file as well, or a worker that
// also loads the receiver (tests/_idoc) gets two copies of them, and the second has no named exports.
import type { Segment } from '../idoc/idoc.mts';
import type { ReceivedIdoc, ReplyInput } from '../idoc/inbox.mts';

export type { ReceivedIdoc, ReplyInput } from '../idoc/inbox.mts';

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
	/** How the receiver answers this partner's IDocs, until the end of the test; then the partner's reply from
	 * before the test is back. */
	reply(partner: string, reply: ReplyInput): Promise<void>;
}

export interface IdocFixtures {
	/** The IDoc receiver's inbox: IDOC_HUB_URL (its control API) and, beyond this computer, IDOC_HUB_TOKEN.
	 * Skips the test when IDOC_HUB_URL is not set. */
	idocInbox: IdocInbox;
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
	reply: z.enum(['accept', 'reject', 'slow']),
	idoc: z.object({ control: z.record(z.string(), z.string()), segments: z.array(SegmentSchema) })
});
const ListSchema = z.object({ cursor: z.number().int(), idocs: z.array(ReceivedSchema) });
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
		const { cursor, idocs } = ListSchema.parse(await this.call('GET', `/idocs?${query}`));
		return { cursor, idocs: match.where ? idocs.filter(match.where) : idocs };
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

export const test = base.extend<IdocFixtures>({
	// oxlint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form
	idocInbox: async ({}, use, testInfo) => {
		const url = process.env.IDOC_HUB_URL;
		testInfo.skip(!url, 'missing env: IDOC_HUB_URL');
		const token = process.env.IDOC_HUB_TOKEN || undefined;
		if (token && isInsecureHttp(url!))
			throw new Error(
				'IDOC_HUB_URL must start with https://: over http:// the control token would cross the network unencrypted.'
			);
		const client = new InboxClient(url!, token);
		// Everything before this point belongs to earlier tests.
		let { cursor: start } = await client.list({}, Number.MAX_SAFE_INTEGER);
		/** The IDocs since the test started. A receiver that restarted meanwhile numbers from 1 again: then
		 * everything it holds arrived during the test. */
		const sinceStart = async (match: IdocMatch) => {
			const found = await client.list(match, start);
			if (found.cursor >= start) return found.idocs;
			start = 0;
			return (await client.list(match, start)).idocs;
		};
		/** The reply each changed partner had before, restored after the test, so another run's or a person's
		 * setting on a shared receiver survives. */
		const previousReplies = new Map<string, unknown>();

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
					const path = `/replies/${encodeURIComponent(partner)}`;
					if (!previousReplies.has(partner))
						previousReplies.set(partner, await client.call('GET', path));
					await client.call('PUT', path, reply);
				})
		});

		for (const [partner, previous] of previousReplies)
			await client.call('PUT', `/replies/${encodeURIComponent(partner)}`, previous);
	}
});

export { expect };
export type { Locator, Page } from './index';
