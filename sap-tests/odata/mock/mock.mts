// The OData mock: serves every service in odata/metadata/options-per-service.json at its basePath, with the
// fixed data in odata/mock/data/<service>/<EntitySet>.json, through SAP's mock server (@sap-ux/fe-mockserver-core).
// Writes are kept in memory until the data is reset or the mock stops.
//
// Two listeners, like the IDoc receiver and the Mock PLC:
// - the OData endpoint, which tests and apps call in SAP's place. It keeps a log of the requests it answered (of the
//   headers, only the values of known harmless ones), and can be told to fail a service's requests, all or a share
//   of them, or to answer them late;
// - the control API, for the app's Mock OData page and for tests: the log, the answers, the data, a reset.
// Both only listen on this computer: the OData endpoint has no login (any user and password get in).
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
	createServer,
	type IncomingHttpHeaders,
	type IncomingMessage,
	type OutgoingHttpHeaders,
	type Server,
	type ServerResponse
} from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
	authorize,
	fail,
	isLoopback,
	json,
	readBody,
	requestTarget,
	UserError
} from '../../mfs/http.mts';

type Router = (request: IncomingMessage, response: ServerResponse, next: () => void) => void;
/** The part of SAP's mock server used here. Its own type declarations need packages it doesn't install, so the
 * package is loaded with `require` and described by this instead. */
type MockServer = { isReady: Promise<void>; getRouter(): Router; dispose(): Promise<void> };
type MockServerClass = new (configuration: {
	services: {
		urlPath: string;
		metadataPath: string;
		mockdataPath: string;
		generateMockData: boolean;
		/** How a data script reaches another service: `this.base.getEntityInterface(set, alias)`. */
		alias: string;
	}[];
}) => MockServer;
const isMockServerClass = (value: unknown): value is MockServerClass => typeof value === 'function';
const mockserverPackage: unknown = createRequire(import.meta.url)('@sap-ux/fe-mockserver-core');
const exported =
	typeof mockserverPackage === 'object' &&
	mockserverPackage !== null &&
	'default' in mockserverPackage
		? mockserverPackage.default
		: undefined;
if (!isMockServerClass(exported))
	throw new Error('@sap-ux/fe-mockserver-core does not export its mock server class as expected.');
const FEMockserver = exported;

const ROOT = new URL('../../', import.meta.url);
const path = (relative: string) => fileURLToPath(new URL(relative, ROOT));

/** Requests the log keeps. */
const KEEP = 500;
/** Request and response bodies are kept up to this size. */
const BODY_KEPT = 16 * 1024;
/** Rows the control API returns from an entity set at most. */
const MAX_ROWS = 200;
/** A request body larger than this is refused: the mock serves small test data. */
const MAX_REQUEST = 10 * 1024 * 1024;

export type MockService = {
	/** The folder of its data under odata/mock/data, used as its name. */
	name: string;
	/** Where it is served, e.g. /sap/opu/odata/IWBEP/GWSAMPLE_BASIC. */
	basePath: string;
	metadataPath: string;
	dataPath: string;
};

/** The services of options-per-service.json (the file the client generator reads as well). */
export function configuredServices(): MockService[] {
	const services = z
		.record(z.string(), z.object({ directoryName: z.string(), basePath: z.string() }))
		.parse(JSON.parse(readFileSync(path('odata/metadata/options-per-service.json'), 'utf8')));
	return Object.entries(services).map(([file, { directoryName, basePath }]) => ({
		name: directoryName,
		basePath: basePath.replace(/\/+$/, ''),
		metadataPath: path(file),
		dataPath: path(`odata/mock/data/${directoryName}`)
	}));
}

export const AnswerSchema = z.discriminatedUnion('mode', [
	z.object({
		mode: z.literal('fail'),
		status: z.number().int().min(400).max(599),
		message: z.string().trim().min(1).max(500),
		/** Share of the service's requests that fail, in percent (default 100); the others are answered normally. */
		rate: z.number().int().min(1).max(100).optional(),
		/** Sent as Retry-After: the seconds a client should wait before it tries again (with 429 or 503). */
		retryAfterSeconds: z.number().int().min(0).max(86_400).optional()
	}),
	z
		.object({
			mode: z.literal('slow'),
			delayMs: z.number().int().min(1).max(300_000),
			/** With it, each request waits a random time from delayMs to maxDelayMs. */
			maxDelayMs: z.number().int().min(1).max(300_000).optional()
		})
		.refine((answer) => answer.maxDelayMs === undefined || answer.maxDelayMs >= answer.delayMs, {
			message: 'the longest delay must not be shorter than the shortest',
			path: ['maxDelayMs']
		})
]);
/** How the mock answers a service's requests, instead of normally. */
export type Answer = z.infer<typeof AnswerSchema>;

export const LoggedRequestSchema = z.object({
	seq: z.number().int(),
	at: z.string(),
	method: z.string(),
	/** Path and query, as sent. */
	url: z.string(),
	/** The service it went to; null for a path no service serves. */
	service: z.string().nullable(),
	/** 0 when the caller hung up before the answer. */
	status: z.number().int(),
	durationMs: z.number(),
	/** Whether it was answered normally or as set for its service. */
	answer: z.enum(['normal', 'fail', 'slow']),
	requestType: z.string().optional(),
	responseType: z.string().optional(),
	/** The headers as sent and answered: values only of known harmless ones (loggedHeaders). */
	requestHeaders: z.record(z.string(), z.string()),
	responseHeaders: z.record(z.string(), z.string()),
	requestBody: z.string().optional(),
	requestBodyCut: z.boolean().optional(),
	responseBody: z.string().optional(),
	responseBodyCut: z.boolean().optional()
});
export type LoggedRequest = z.infer<typeof LoggedRequestSchema>;
/** A logged request without its headers and bodies, as the list gives it: zod drops the fields it doesn't name. */
export const RequestSummarySchema = LoggedRequestSchema.omit({
	requestHeaders: true,
	responseHeaders: true,
	requestBody: true,
	requestBodyCut: true,
	responseBody: true,
	responseBodyCut: true
});

/**
 * Headers whose values the log keeps: what HTTP and OData need, none of which carries a login. Every other header
 * keeps its name only, so the log shows that it was sent. The log goes to the page, and a request from a real app
 * carries a real user's login, under names no list of secret headers can foresee (x-approuter-authorization,
 * sap-connectivity-authentication, an API gateway's subscription key, …): so the values kept are the known ones.
 */
const KEPT_HEADERS = new Set([
	'host',
	'user-agent',
	'connection',
	'keep-alive',
	'transfer-encoding',
	'cache-control',
	'pragma',
	'expect',
	'date',
	'etag',
	'if-match',
	'if-none-match',
	'if-modified-since',
	'last-modified',
	'location',
	'vary',
	'retry-after',
	'prefer',
	'preference-applied',
	'x-http-method',
	'x-requested-with',
	'dataserviceversion',
	'maxdataserviceversion',
	'mindataserviceversion',
	'sap-client',
	'sap-language',
	'sap-contextid-accept',
	'sap-message'
]);
const KEPT_PREFIX = /^(?:content-|accept|odata-)/i;
/** The values of SAP's CSRF header that are no token: a request asking for one, an answer saying one is needed. */
const CSRF_WORDS = new Set(['fetch', 'required']);

/** A header's value as the log keeps it: whole, its login scheme only, or nothing. */
function keptValue(name: string, value: string): string {
	if (KEPT_HEADERS.has(name) || KEPT_PREFIX.test(name)) return value;
	if (name === 'x-csrf-token' && CSRF_WORDS.has(value.trim().toLowerCase())) return value;
	// The scheme (Basic, Bearer) tells which kind of login came, without the login itself.
	const scheme = /auth/i.test(name) ? /^([A-Za-z][\w-]*) +\S/.exec(value)?.[1] : undefined;
	return scheme ? `${scheme} (removed)` : '(removed)';
}

/** Headers for the log: one text per header, names in lower case, values only of the known harmless ones. */
export function loggedHeaders(
	headers: IncomingHttpHeaders | OutgoingHttpHeaders
): Record<string, string> {
	const logged: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value === undefined) continue;
		const text = Array.isArray(value) ? value.join(', ') : String(value);
		const lower = name.toLowerCase();
		logged[lower] = keptValue(lower, text);
	}
	return logged;
}

export type OdataMockOptions = {
	/** Address of the OData endpoint (default 127.0.0.1). Only this computer: it has no login. */
	host?: string;
	/** Its port (default 4010; 0 = a free port). */
	port?: number;
	/** Address of the control API (default 127.0.0.1). Only this computer. */
	controlHost?: string;
	/** Its port (default 0 = a free port). */
	controlPort?: number;
	/** Token every control API request must carry, except GET /health. */
	controlToken?: string;
	/** The services to serve (default: those of options-per-service.json). */
	services?: MockService[];
	/** Numbers from 0 to below 1 for the error rate and the random delays (default Math.random); for tests. */
	random?: () => number;
};

export type RunningOdataMock = {
	odataUrl: string;
	controlUrl: string;
	services: MockService[];
	/** Called for every request the log takes in. */
	onRequest(listener: (entry: LoggedRequest) => void): void;
	close(): Promise<void>;
};

function listen(server: Server, host: string, port: number): Promise<string> {
	return new Promise((done, failed) => {
		server.once('error', failed);
		server.listen(port, host, () => {
			server.off('error', failed);
			const address = server.address();
			if (address === null || typeof address === 'string') {
				failed(new Error('the server is not listening on a TCP port'));
				return;
			}
			const shown = address.family === 'IPv6' ? `[${address.address}]` : address.address;
			done(`http://${shown}:${address.port}`);
		});
	});
}

function close(server: Server): Promise<void> {
	return new Promise((done) => {
		server.close(() => done());
		server.closeAllConnections();
	});
}

async function readRequest(request: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
		size += buffer.length;
		if (size > MAX_REQUEST) throw new UserError('the request body is too large', 413);
		chunks.push(buffer);
	}
	return Buffer.concat(chunks);
}

/** Text of a body for the log: cut off beyond BODY_KEPT. Binary content isn't expected from OData. */
function kept(bytes: Buffer): { text: string; cut: boolean } | undefined {
	if (bytes.length === 0) return undefined;
	return {
		text: bytes.subarray(0, BODY_KEPT).toString('utf8'),
		cut: bytes.length > BODY_KEPT
	};
}

/** An error in the form SAP Gateway sends for OData V2 JSON, so clients show its message. */
function gatewayError(message: string) {
	return {
		error: {
			code: 'MOCK/000',
			message: { lang: 'en', value: message },
			innererror: { errordetails: [] }
		}
	};
}

const isEncoding = (value: unknown): value is BufferEncoding =>
	typeof value === 'string' && Buffer.isEncoding(value);
const isCallback = (value: unknown): value is (error?: Error | null) => void =>
	typeof value === 'function';

const sleep = (ms: number) =>
	new Promise<void>((done) => {
		setTimeout(done, ms);
	});

const RowSchema = z.record(z.string(), z.json());
type Row = z.infer<typeof RowSchema>;

/** A row as the page shows it: without OData's own fields and without navigation properties not expanded. */
function plainRow(row: Row): Row {
	return Object.fromEntries(
		Object.entries(row).filter(
			([name, value]) =>
				name !== '__metadata' &&
				!(value !== null && typeof value === 'object' && '__deferred' in value)
		)
	);
}

export async function startOdataMock(options: OdataMockOptions = {}): Promise<RunningOdataMock> {
	const host = options.host ?? '127.0.0.1';
	const controlHost = options.controlHost ?? '127.0.0.1';
	for (const [name, value] of [
		['OData endpoint', host],
		['control API', controlHost]
	] as const)
		if (!isLoopback(value))
			throw new Error(
				`The ${name} of the OData mock only listens on this computer (127.0.0.1, ::1 or localhost), not on ${value}: it has no login.`
			);
	const services = options.services ?? configuredServices();
	const controlToken = options.controlToken;
	const random = options.random ?? Math.random;
	/** New at every start, so a reader of the log notices that its numbering began anew. */
	const instance = randomUUID();
	/** Marks the control API's own reads of the data, which stay out of the log and ignore the answers. */
	const internal = randomBytes(16).toString('hex');

	async function makeRouter(): Promise<{ mock: MockServer; router: Router }> {
		const mock = new FEMockserver({
			services: services.map((service) => ({
				urlPath: service.basePath,
				// The core's own option names (the UI5 middleware maps metadataXmlPath / mockdataRootPath).
				metadataPath: service.metadataPath,
				mockdataPath: service.dataPath,
				generateMockData: false,
				// The folder name, so that a data script of one service can read and change another's.
				alias: service.name
			}))
		});
		await mock.isReady;
		return { mock, router: mock.getRouter() };
	}
	let current = await makeRouter();

	const log: LoggedRequest[] = [];
	let seq = 0;
	const listeners: ((entry: LoggedRequest) => void)[] = [];
	const answers = new Map<string, Answer>();

	/** The service a path belongs to: the one with the longest base path that contains it. */
	const serviceOf = (pathname: string) =>
		services
			.filter((s) => pathname === s.basePath || pathname.startsWith(`${s.basePath}/`))
			.reduce<MockService | undefined>(
				(best, s) => (!best || s.basePath.length > best.basePath.length ? s : best),
				undefined
			);

	function record(entry: Omit<LoggedRequest, 'seq'>) {
		const logged = { seq: ++seq, ...entry };
		log.push(logged);
		if (log.length > KEEP) log.splice(0, log.length - KEEP);
		for (const listener of listeners) listener(logged);
	}

	async function serveOdata(request: IncomingMessage, response: ServerResponse) {
		const url = request.url ?? '/';
		const { pathname } = new URL(url, 'http://localhost');
		if (request.method === 'GET' && pathname === '/health') {
			response.end('ok');
			return;
		}
		const own = request.headers['x-odata-mock-internal'] === internal;
		const service = serviceOf(pathname);
		const set = own || !service ? undefined : answers.get(service.name);
		// With a rate, only that share fails: the others are answered normally, and logged so.
		const answer = set?.mode === 'fail' && random() * 100 >= (set.rate ?? 100) ? undefined : set;
		const started = performance.now();
		const at = new Date().toISOString();

		let body: Buffer;
		try {
			body = await readRequest(request);
		} catch (error) {
			fail(response, error);
			return;
		}
		// As the client sent it: an empty body gets a content type below, for the core only.
		const requestType = request.headers['content-type'] || undefined;

		// What goes back, kept for the log as it is written.
		const sent: Buffer[] = [];
		let sentSize = 0;
		const keep = (chunk: unknown, encoding: unknown) => {
			let buffer: Buffer | undefined;
			if (Buffer.isBuffer(chunk)) buffer = chunk;
			else if (chunk instanceof Uint8Array) buffer = Buffer.from(chunk);
			else if (typeof chunk === 'string')
				buffer = Buffer.from(chunk, isEncoding(encoding) ? encoding : 'utf8');
			// Nothing else is body: a callback in the chunk's place, or no chunk at all.
			if (!buffer) return;
			if (sentSize <= BODY_KEPT) sent.push(buffer);
			sentSize += buffer.length;
		};
		if (!own) {
			// The core writes the answer itself; these pass every call on unchanged, keeping a copy for the log.
			// Node's write and end take (chunk, encoding, callback), (chunk, callback) or (chunk); end also ().
			const write = response.write.bind(response);
			const end = response.end.bind(response);
			response.write = (chunk: unknown, second?: unknown, third?: unknown): boolean => {
				keep(chunk, second);
				if (isEncoding(second)) return write(chunk, second, isCallback(third) ? third : undefined);
				if (isCallback(second)) return write(chunk, second);
				return write(chunk);
			};
			response.end = (chunk?: unknown, second?: unknown, third?: unknown): ServerResponse => {
				if (isCallback(chunk)) return end(chunk);
				keep(chunk, second);
				if (isEncoding(second)) return end(chunk, second, isCallback(third) ? third : undefined);
				if (isCallback(second)) return end(chunk, second);
				return end(chunk);
			};
			response.once('close', () => {
				const requestBody = kept(body);
				const responseBody = kept(Buffer.concat(sent));
				const responseType = response.getHeader('content-type');
				record({
					at,
					method: request.method ?? 'GET',
					url,
					service: service?.name ?? null,
					status: response.writableFinished ? response.statusCode : 0,
					durationMs: Math.round(performance.now() - started),
					answer: answer?.mode ?? 'normal',
					requestType,
					responseType: typeof responseType === 'string' ? responseType : undefined,
					requestHeaders: loggedHeaders(request.headers),
					responseHeaders: loggedHeaders(response.getHeaders()),
					requestBody: requestBody?.text,
					requestBodyCut: requestBody?.cut || undefined,
					responseBody: responseBody?.text,
					responseBodyCut: responseBody?.cut || undefined
				});
			});
		}

		if (answer?.mode === 'fail') {
			if (answer.retryAfterSeconds !== undefined)
				response.setHeader('retry-after', String(answer.retryAfterSeconds));
			json(response, answer.status, gatewayError(answer.message));
			return;
		}
		if (answer?.mode === 'slow') {
			const { delayMs, maxDelayMs = delayMs } = answer;
			await sleep(delayMs + Math.floor(random() * (maxDelayMs - delayMs + 1)));
			// The caller gave up meanwhile: nothing to answer.
			if (response.destroyed) return;
		}
		// SAP Gateway hands out a CSRF token on request, and clients ask for one before every write. The mock
		// server core has no such endpoint (it would take the request for a write).
		if (
			request.method === 'HEAD' &&
			request.headers['x-csrf-token']?.toString().toLowerCase() === 'fetch'
		) {
			response.setHeader('x-csrf-token', 'mock-token');
			response.end();
			return;
		}
		// Read already for the log: body-parser, which the core uses, then takes it as it is. An empty
		// body goes on as an empty JSON object: as an empty string it would reach an action (a V2
		// function import, whose parameters are in the URL) as a string, and the core fails on it;
		// as no body at all, a create or change would. The core turns an empty object into '{}' and
		// parses that back only for a JSON content type.
		if (body.length === 0) {
			request.headers['content-type'] = 'application/json';
			Object.assign(request, { body: {}, _body: true });
		} else {
			Object.assign(request, { body, _body: true });
		}
		current.router(request, response, () => {
			response.statusCode = 404;
			response.end();
		});
	}

	const odataServer = createServer((request, response) => {
		serveOdata(request, response).catch((error: unknown) => {
			if (!response.headersSent) fail(response, error);
			else response.destroy();
		});
	});
	const odataUrl = await listen(odataServer, host, options.port ?? 4010);

	/** Reads from the mock's own OData endpoint, past the log and the answers. */
	async function readOwn(target: string): Promise<unknown> {
		const response = await fetch(odataUrl + target, {
			headers: { 'x-odata-mock-internal': internal, accept: 'application/json' }
		});
		const text = await response.text();
		if (!response.ok)
			throw new UserError(`the service answered ${response.status}: ${text.slice(0, 300)}`, 502);
		return target.endsWith('/$count') ? Number(text) : (JSON.parse(text) as unknown);
	}

	function serviceNamed(name: string | undefined): MockService {
		const service = services.find((s) => s.name === name);
		if (!service) throw new UserError(`there is no service "${name}"`, 404);
		return service;
	}

	async function control(request: IncomingMessage, response: ServerResponse) {
		authorize(request, controlToken);
		const { method, parts, params } = requestTarget(request);
		const [first, second, third, fourth] = parts;
		if (method === 'GET' && first === 'health' && parts.length === 1)
			return json(response, 200, { ok: true });
		if (method === 'GET' && first === 'info' && parts.length === 1)
			return json(response, 200, {
				instance,
				odataUrl,
				services: services.map(({ name, basePath }) => ({ name, basePath }))
			});

		if (first === 'requests') {
			if (method === 'GET' && parts.length === 1) {
				const after = Number(params.get('after') ?? 0);
				const limit = Math.min(Number(params.get('limit') ?? KEEP) || KEEP, KEEP);
				const newer = log.filter((entry) => entry.seq > after);
				return json(response, 200, {
					instance,
					cursor: seq,
					// The oldest request still held: a reader drops what it keeps from before (cleared or let go).
					oldest: log[0]?.seq ?? null,
					// The newest ones, if there are more than `limit`.
					requests: newer.slice(-limit).map((entry) => RequestSummarySchema.parse(entry))
				});
			}
			if (method === 'GET' && parts.length === 2) {
				const entry = log.find((e) => e.seq === Number(second));
				if (!entry) throw new UserError(`there is no request ${second} in the log`, 404);
				return json(response, 200, entry);
			}
			if (method === 'DELETE' && parts.length === 1) {
				log.length = 0;
				return json(response, 200, { ok: true });
			}
		}

		if (first === 'answers') {
			if (method === 'GET' && parts.length === 1)
				return json(response, 200, Object.fromEntries(answers));
			if (parts.length === 2) {
				const service = serviceNamed(second);
				if (method === 'PUT') {
					answers.set(service.name, await readBody(request, AnswerSchema));
					return json(response, 200, { ok: true });
				}
				if (method === 'DELETE') {
					answers.delete(service.name);
					return json(response, 200, { ok: true });
				}
			}
		}

		if (first === 'services' && method === 'GET') {
			const service = serviceNamed(second);
			if (third === 'sets' && parts.length === 3) {
				const document = z
					.object({ d: z.object({ EntitySets: z.array(z.string()) }) })
					.parse(await readOwn(`${service.basePath}/?$format=json`));
				const sets = await Promise.all(
					document.d.EntitySets.map(async (name) => ({
						name,
						count: z.number().parse(await readOwn(`${service.basePath}/${name}/$count`))
					}))
				);
				return json(response, 200, sets);
			}
			if (third === 'sets' && parts.length === 4) {
				const top = Math.min(Math.max(Number(params.get('top') ?? 50) || 50, 1), MAX_ROWS);
				const set = encodeURIComponent(fourth ?? '');
				const [count, page] = await Promise.all([
					readOwn(`${service.basePath}/${set}/$count`),
					readOwn(`${service.basePath}/${set}?$format=json&$top=${top}`)
				]);
				const rows = z.object({ d: z.object({ results: z.array(RowSchema) }) }).parse(page)
					.d.results;
				return json(response, 200, { count: z.number().parse(count), rows: rows.map(plainRow) });
			}
		}

		if (method === 'POST' && first === 'reset' && parts.length === 1) {
			// A new mock server reads the data files again; requests already under way finish on the old one.
			const previous = current;
			current = await makeRouter();
			await previous.mock.dispose();
			return json(response, 200, { ok: true });
		}

		throw new UserError(`no such request: ${method} /${parts.join('/')}`, 404);
	}

	const controlServer = createServer((request, response) => {
		control(request, response).catch((error: unknown) => fail(response, error));
	});
	let controlUrl: string;
	try {
		controlUrl = await listen(controlServer, controlHost, options.controlPort ?? 0);
	} catch (error) {
		await close(odataServer);
		throw error;
	}

	return {
		odataUrl,
		controlUrl,
		services,
		onRequest(listener) {
			listeners.push(listener);
		},
		async close() {
			await Promise.all([close(odataServer), close(controlServer)]);
			await current.mock.dispose();
		}
	};
}
