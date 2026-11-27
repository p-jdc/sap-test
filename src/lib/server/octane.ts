import { z } from 'zod';
import { OctaneError } from './octane-error.js';
import { OCTANE_SETTINGS, type OctaneSetting, type OctaneTestKind } from '#lib/shared/octane.js';

/**
 * A client for the REST API of OpenText Octane (formerly ALM Octane), as far as the importer needs
 * it: sign in with an API access key, search the tests of one workspace and read their scripts.
 * https://admhelp.microfocus.com/octane/en/latest/Online/Content/API/articles_API2.htm
 */

export interface OctaneConfig {
	/** The server's address without a trailing slash, e.g. https://octane.example.com. */
	url: string;
	sharedSpace: string;
	workspace: string;
	clientId: string;
	clientSecret: string;
}

/** The importer's settings from the app's settings, or the names of those not set. */
export function octaneConfig(
	settings: Record<string, string>
): { config: OctaneConfig; missing?: never } | { config?: never; missing: OctaneSetting[] } {
	const missing = OCTANE_SETTINGS.filter((name) => !settings[name]?.trim());
	if (missing.length > 0) return { missing };
	const value = (name: OctaneSetting) => settings[name]?.trim() ?? '';
	return {
		config: {
			url: value('OCTANE_URL').replace(/\/+$/, ''),
			sharedSpace: value('OCTANE_SHARED_SPACE'),
			workspace: value('OCTANE_WORKSPACE'),
			clientId: value('OCTANE_CLIENT_ID'),
			clientSecret: settings.OCTANE_CLIENT_SECRET ?? ''
		}
	};
}

/** The test in Octane's web UI. */
export function octaneLink(config: OctaneConfig, id: string): string {
	const p = `${config.sharedSpace}/${config.workspace}`;
	return `${config.url}/ui/entity-navigation?p=${p}&entityType=test&id=${encodeURIComponent(id)}`;
}

const Named = z.object({ name: z.string().optional(), full_name: z.string().optional() });
const NamedList = z.object({ data: z.array(Named) });

const TestEntity = z.object({
	id: z.union([z.string(), z.number()]).transform(String),
	name: z.string().default(''),
	subtype: z.string().optional(),
	description: z.string().nullish(),
	phase: Named.nullish(),
	owner: Named.nullish(),
	product_areas: NamedList.nullish(),
	user_tags: NamedList.nullish()
});
export type OctaneTest = z.infer<typeof TestEntity>;

const TestCollection = z.object({
	total_count: z.number().optional(),
	data: z.array(TestEntity)
});

const Script = z.object({ script: z.string().nullish() });

/** Octane's subtype for each kind of test the importer reads. */
const SUBTYPES: Record<OctaneTestKind, string> = { manual: 'test_manual', gherkin: 'gherkin_test' };

export function testKind(test: Pick<OctaneTest, 'subtype'>): OctaneTestKind | undefined {
	if (test.subtype === SUBTYPES.manual) return 'manual';
	if (test.subtype === SUBTYPES.gherkin) return 'gherkin';
	return undefined;
}

/**
 * The fields the importer reads. Older or customised workspaces may lack one of the references
 * (product_areas used to be application_modules); Octane then refuses the whole request, so it
 * is asked again with the basic fields only.
 */
const FIELDS =
	'id,name,subtype,description,phase{name},owner{name,full_name},product_areas{name},user_tags{name}';
const BASIC_FIELDS = 'id,name,subtype,description';

/** A string inside an Octane query (`^…^`), with the characters the query language escapes. */
export function queryString(value: string): string {
	return `^${value.replaceAll(/[\\^"']/g, (c) => `\\${c}`)}^`;
}

/** The query for a search: manual and Gherkin tests, by id (digits only) or a part of the name. */
export function searchQuery(text: string): string {
	const kinds = `(${Object.values(SUBTYPES)
		.map((s) => `subtype EQ ^${s}^`)
		.join('||')})`;
	const term = text.trim();
	if (!term) return kinds;
	if (/^\d+$/.test(term)) return `${kinds};id EQ ${term}`;
	return `${kinds};name EQ ${queryString(`*${term}*`)}`;
}

export const PAGE_SIZE = 50;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Reads the message of an Octane error response, which is JSON with `description` where it can be. */
async function failure(response: Response, what: string): Promise<OctaneError> {
	const text = await response.text().catch(() => '');
	let detail = text.slice(0, 300);
	try {
		const body: unknown = JSON.parse(text);
		const parsed = z
			.object({ description: z.string().optional(), error_code: z.string().optional() })
			.safeParse(body);
		if (parsed.success && parsed.data.description) detail = parsed.data.description;
	} catch {
		// Not JSON: an HTML error page from a proxy, say. Its first characters are enough.
	}
	if (response.status === 401)
		return new OctaneError(
			`${what}: Octane did not accept the API access key (client ID and secret) or the session expired.`,
			401
		);
	if (response.status === 403)
		return new OctaneError(
			`${what}: the API access key has no access to shared space or workspace (403).`,
			403
		);
	return new OctaneError(
		`${what}: Octane answered ${response.status}${detail ? `: ${detail}` : ''}`,
		response.status
	);
}

/** A signed-in Octane session. */
export class OctaneSession {
	private readonly cookies = new Map<string, string>();

	constructor(
		private readonly config: OctaneConfig,
		private readonly fetchFn: Fetch
	) {}

	private get base() {
		return `${this.config.url}/api/shared_spaces/${encodeURIComponent(this.config.sharedSpace)}/workspaces/${encodeURIComponent(this.config.workspace)}`;
	}

	private keepCookies(response: Response) {
		for (const cookie of response.headers.getSetCookie()) {
			const [pair = ''] = cookie.split(';');
			const at = pair.indexOf('=');
			if (at > 0) this.cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
		}
	}

	private async send(url: string, what: string, init: RequestInit = {}): Promise<Response> {
		const headers = new Headers(init.headers);
		headers.set('Accept', 'application/json');
		if (this.cookies.size > 0)
			headers.set(
				'Cookie',
				[...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
			);
		let response: Response;
		try {
			response = await this.fetchFn(url, {
				...init,
				headers,
				redirect: 'manual',
				signal: AbortSignal.timeout(30_000)
			});
		} catch (e) {
			const reason = e instanceof Error ? e.message : String(e);
			throw new OctaneError(`${what}: could not reach ${new URL(url).origin} (${reason}).`);
		}
		// The session cookie is renewed on the way (Authenticate.htm): keep the newest.
		this.keepCookies(response);
		if (response.status >= 300 && response.status < 400)
			throw new OctaneError(
				`${what}: Octane redirected to ${response.headers.get('location') ?? 'another page'}. Check the address in Settings: the server itself, without /ui.`,
				response.status
			);
		if (!response.ok) throw await failure(response, what);
		return response;
	}

	async signIn(): Promise<void> {
		await this.send(`${this.config.url}/authentication/sign_in`, 'Signing in to Octane', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				client_id: this.config.clientId,
				client_secret: this.config.clientSecret
			})
		});
		if (this.cookies.size === 0)
			throw new OctaneError('Signing in to Octane: the answer carried no session cookie.');
	}

	async signOut(): Promise<void> {
		await this.send(`${this.config.url}/authentication/sign_out`, 'Signing out', {
			method: 'POST'
		}).catch(() => null);
	}

	private async tests(query: string, params: Record<string, string>, what: string) {
		const read = async (fields: string) => {
			const search = new URLSearchParams({ ...params, fields });
			// The query keeps its own encoding rules; URLSearchParams would turn spaces into `+`.
			const url = `${this.base}/tests?query=${encodeURIComponent(`"${query}"`)}&${search.toString()}`;
			const response = await this.send(url, what);
			return TestCollection.parse(await response.json());
		};
		try {
			return await read(FIELDS);
		} catch (e) {
			if (e instanceof OctaneError && e.status === 400) return read(BASIC_FIELDS);
			throw e;
		}
	}

	/** One page of the manual and Gherkin tests that match `text` (an id or a part of the name). */
	async search(text: string, offset = 0): Promise<{ tests: OctaneTest[]; total: number }> {
		const collection = await this.tests(
			searchQuery(text),
			{ limit: String(PAGE_SIZE), offset: String(offset), order_by: 'name' },
			'Searching Octane'
		);
		return { tests: collection.data, total: collection.total_count ?? collection.data.length };
	}

	/** The tests with these ids, in no particular order; ids Octane does not know are left out. */
	async byIds(ids: string[]): Promise<OctaneTest[]> {
		if (ids.length === 0) return [];
		// Written into the query as they are, so digits only.
		if (!ids.every((id) => /^\d+$/.test(id))) throw new OctaneError('Octane ids are numbers.');
		const collection = await this.tests(
			`id IN ${ids.join(',')}`,
			{ limit: String(ids.length) },
			'Reading the tests'
		);
		return collection.data;
	}

	/** The script of a test: the steps of a manual test, the feature file of a Gherkin test. */
	async script(id: string): Promise<string> {
		const response = await this.send(
			`${this.base}/tests/${encodeURIComponent(id)}/script`,
			`Reading the steps of test ${id}`
		);
		return Script.parse(await response.json()).script ?? '';
	}
}

/** Signs in, runs `work`, and signs out again whatever happened. */
export async function withOctane<T>(
	config: OctaneConfig,
	work: (session: OctaneSession) => Promise<T>,
	fetchFn: Fetch = fetch
): Promise<T> {
	const session = new OctaneSession(config, fetchFn);
	await session.signIn();
	try {
		return await work(session);
	} finally {
		await session.signOut();
	}
}
