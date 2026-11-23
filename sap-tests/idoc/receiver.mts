// The IDoc receiver: plays the partner system SAP sends IDocs to. SAP posts IDoc-XML to it through an XML HTTP
// port (WE21) and a type G destination (SM59) pointing at https://<host>/idoc/<partner>. Two listeners, like the
// Mock PLC:
// - the IDoc endpoint, which SAP must reach: HTTPS, with a login (basic authentication) or SAP's client
//   certificate (mutual TLS);
// - the control API, for tests and the app: list and clear the inbox, set the reply per partner, and send IDocs
//   into SAP in CPI's place (sender.mts) when an SAP system is set. It stays on this computer unless a token
//   protects it.
import {
	createServer as createHttpServer,
	type IncomingMessage,
	type Server,
	type ServerResponse
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { timingSafeEqual } from 'node:crypto';
import { TLSSocket } from 'node:tls';
import {
	authorize,
	fail,
	isLoopback,
	json,
	readBody,
	requestTarget,
	UserError
} from '../mfs/http.mts';
import { IdocError, type Idoc } from './idoc.mts';
import { z } from 'zod';
import {
	IdocBodySchema,
	IdocFilterSchema,
	IdocInbox,
	ReplySchema,
	type Reply,
	type SentIdocs
} from './inbox.mts';
import type { RunningFakeSap } from './fake-sap.mts';
import {
	asInbound,
	checkTarget,
	SAP_SYSTEM_TITLES,
	SAP_SYSTEMS,
	sendToSap,
	type SapSystem,
	type SapTarget,
	type SendResult
} from './sender.mts';
import { parseIdocXml, toIdocXml } from './xml.mts';

export interface ReceiverOptions {
	/** Address of the IDoc endpoint (default 127.0.0.1). */
	host?: string;
	/** Port of the IDoc endpoint (default 0: a free port). */
	port?: number;
	/** Server certificate and key (PEM). With `ca`, SAP must present a client certificate signed by it. */
	tls?: {
		cert: string | Buffer;
		key: string | Buffer;
		ca?: string | Buffer;
		/** SHA-256 fingerprint of SAP's client certificate (hex, colons optional): only that certificate gets
		 * in, not every one the CA signed. */
		clientFingerprint?: string;
	};
	/** The user and password of the type G destination. */
	basicAuth?: { user: string; password: string };
	controlHost?: string;
	controlPort?: number;
	/** Every control API request must carry `Authorization: Bearer <token>`. */
	controlToken?: string;
	inbox?: IdocInbox;
	/** Largest request SAP may send, in bytes (default 10 MB). */
	maxBody?: number;
	/** The SAP systems `POST /send` sends IDocs into. Without any, the receiver only receives. */
	sap?: SapDestinations;
}

/** Where `POST /send` takes the IDocs for one SAP system. */
export interface SapDestination {
	target: SapTarget;
	/** `target` is this stand-in of fake-sap.mts, not the SAP system: `/info` says so, and
	 * `PUT /fake-sap/<system>/reply` sets how it answers. */
	standIn?: RunningFakeSap;
}
export type SapDestinations = Partial<Record<SapSystem, SapDestination>>;

const FakeReplySchema = z.discriminatedUnion('mode', [
	z.object({ mode: z.literal('accept') }),
	z.object({
		mode: z.literal('reject'),
		status: z.number().int().min(400).max(599).default(500),
		message: z.string().min(1).max(500).default('Rejected by the stand-in for SAP')
	})
]);

/** What `/info` tells about an SAP system IDocs are sent to: never the login itself. */
export interface SapTargetInfo {
	system: SapSystem;
	/** S/4HANA or EWM. */
	title: string;
	url: string;
	client?: string;
	service: 'soap' | 'xml';
	login: 'none' | 'user' | 'certificate' | 'user-and-certificate';
	/** The stand-in of fake-sap.mts, not an SAP system. */
	standIn: boolean;
}

const SendBodySchema = z.object({
	/** IDoc-XML, plain or in SOAP; or the IDocs themselves. */
	xml: z.string().min(1).optional(),
	idocs: z.array(IdocBodySchema).min(1).optional(),
	/** The SAP system to send them into. */
	to: z.enum(SAP_SYSTEMS).default('s4'),
	by: z.enum(['test', 'person']).default('person')
});
/** Largest send body: IDocs for a test are small, but a pasted document may hold several. */
const MAX_SEND = 5 * 1024 * 1024;

function targetInfo(system: SapSystem, { target, standIn }: SapDestination): SapTargetInfo {
	const user = Boolean(target.basicAuth);
	const certificate = Boolean(target.tls?.cert);
	return {
		system,
		title: SAP_SYSTEM_TITLES[system],
		url: checkTarget(target).origin,
		client: target.client,
		service: target.service ?? 'soap',
		standIn: Boolean(standIn),
		login:
			user && certificate
				? 'user-and-certificate'
				: user
					? 'user'
					: certificate
						? 'certificate'
						: 'none'
	};
}

/** Sends into SAP and records it, also when SAP refused or couldn't be reached (status 0). */
async function sendAndRecord(
	inbox: IdocInbox,
	sap: SapTarget,
	body: z.output<typeof SendBodySchema>
): Promise<SentIdocs> {
	if (Boolean(body.xml) === Boolean(body.idocs))
		throw new UserError('send either "xml" or "idocs"');
	// Everything that can be refused before anything goes out: then nothing is recorded.
	let idocs: Idoc[];
	try {
		idocs = (body.idocs ?? parseIdocXml(body.xml!).idocs).map(asInbound);
		toIdocXml(idocs);
	} catch (error) {
		if (error instanceof IdocError) throw new UserError(error.message);
		throw error;
	}
	const service = sap.service ?? 'soap';
	let result: SendResult;
	const started = Date.now();
	try {
		result = await sendToSap(sap, idocs);
	} catch (error) {
		if (!(error instanceof IdocError)) throw error;
		// SAP couldn't be reached or didn't answer in time.
		result = {
			ok: false,
			status: 0,
			service,
			idocNumbers: [],
			reason: error.message,
			body: '',
			durationMs: Date.now() - started
		};
	}
	return inbox.recordSent({ by: body.by, to: body.to, idocs, result });
}

export interface RunningReceiver {
	/** Base address of the IDoc endpoint; SAP posts to `${idocUrl}/idoc/<partner>`. */
	idocUrl: string;
	controlUrl: string;
	inbox: IdocInbox;
	close(): Promise<void>;
}

const PARTNER = /^[A-Za-z0-9_.-]{1,40}$/;
const OWNER = /^[A-Za-z0-9_-]{1,64}$/;
/** What SAP sends IDoc-XML as. A web page can't send these to another address without asking it first (CORS),
 * which the receiver never allows. */
const XML_TYPES = new Set(['text/xml', 'application/xml', 'application/soap+xml']);
const SOAP_ENV = 'http://schemas.xmlsoap.org/soap/envelope/';

const sameText = (a: string, b: string) => {
	const [left, right] = [Buffer.from(a), Buffer.from(b)];
	return left.length === right.length && timingSafeEqual(left, right);
};

function soapEnvelope(body: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="${SOAP_ENV}"><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;
}

const escapeXml = (text: string) =>
	text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/**
 * Reads the whole body as bytes, then decodes it in the encoding its XML declaration names (UTF-8 if none).
 * `counted.bytes` follows the reading, so a refused request is logged with its size too.
 */
async function readXml(
	request: IncomingMessage,
	maxBody: number,
	counted: { bytes: number }
): Promise<{ text: string; body: Buffer; encoding: string }> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
		counted.bytes += buffer.length;
		if (counted.bytes > maxBody)
			throw new UserError(`the request is larger than ${maxBody} bytes`, 413);
		chunks.push(buffer);
	}
	const body = Buffer.concat(chunks);
	const declared = /^\s*<\?xml[^>]*encoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(
		body.subarray(0, 200).toString('latin1')
	)?.[1];
	let decoder: TextDecoder;
	try {
		decoder = new TextDecoder(declared ?? 'utf-8', { fatal: true });
	} catch {
		throw new UserError(`unknown encoding "${declared}" in the XML declaration`, 415);
	}
	try {
		return { text: decoder.decode(body), body, encoding: declared ?? 'utf-8' };
	} catch {
		throw new UserError(`the body is not valid ${declared ?? 'UTF-8'}`, 400);
	}
}

const normalizeFingerprint = (value: string) => value.replaceAll(':', '').toUpperCase();

/** With a pinned fingerprint, only that client certificate may send, not every one its CA signed. */
function checkClientCertificate(request: IncomingMessage, fingerprint: string | undefined): void {
	if (!fingerprint) return;
	const socket = request.socket;
	const given =
		socket instanceof TLSSocket ? socket.getPeerCertificate().fingerprint256 : undefined;
	if (!given || !sameText(normalizeFingerprint(given), normalizeFingerprint(fingerprint)))
		throw new UserError('this client certificate is not the one allowed to send IDocs', 403);
}

function checkLogin(request: IncomingMessage, login: ReceiverOptions['basicAuth']): void {
	if (!login) return;
	const expected = `Basic ${Buffer.from(`${login.user}:${login.password}`).toString('base64')}`;
	if (!sameText(request.headers.authorization ?? '', expected))
		throw new UserError('user or password missing or wrong', 401);
}

/** Waits `ms`, or less if the caller hangs up first. True when it hung up. */
function delayUnlessClosed(response: ServerResponse, ms: number): Promise<boolean> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			response.off('close', onClose);
			resolve(false);
		}, ms);
		const onClose = () => {
			clearTimeout(timer);
			resolve(true);
		};
		response.once('close', onClose);
	});
}

/** Answers SAP in the form it sent: a SOAP envelope (or fault) for SOAP, plain text otherwise. */
function answer(response: ServerResponse, soap: boolean, reply: Reply, count: number) {
	if (reply.mode === 'reject') {
		if (soap) {
			response.writeHead(reply.status, { 'content-type': 'text/xml; charset=utf-8' });
			response.end(
				soapEnvelope(
					`<soapenv:Fault><faultcode>soapenv:Server</faultcode><faultstring>${escapeXml(reply.message)}</faultstring></soapenv:Fault>`
				)
			);
		} else {
			response.writeHead(reply.status, { 'content-type': 'text/plain; charset=utf-8' });
			response.end(reply.message);
		}
		return;
	}
	if (soap) {
		response.writeHead(200, { 'content-type': 'text/xml; charset=utf-8' });
		response.end(soapEnvelope(''));
	} else {
		response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
		response.end(`${count} IDoc(s) received`);
	}
}

function idocHandler(inbox: IdocInbox, options: ReceiverOptions) {
	const maxBody = options.maxBody ?? 10 * 1024 * 1024;
	return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		const { method, path, parts } = requestTarget(request);
		// For the cluster's probes; says nothing about the inbox.
		if (method === 'GET' && path === '/health') return json(response, 200, { ok: true });
		const partner = parts[1] ?? '';
		if (method !== 'POST' || parts[0] !== 'idoc' || parts.length !== 2)
			throw new UserError('SAP sends IDocs with POST to /idoc/<partner>', 404);
		const counted = { bytes: 0 };
		try {
			if (!PARTNER.test(partner))
				throw new UserError(`"${partner}" is not a partner name (letters, digits, _ . -)`, 404);
			checkClientCertificate(request, options.tls?.clientFingerprint);
			checkLogin(request, options.basicAuth);
			// Without a login, on this computer: turn away what a web page open in a browser could send.
			if (!options.basicAuth && !options.tls?.ca) {
				checkHost(request);
				const type = (request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
				if (!XML_TYPES.has(type))
					throw new UserError(`send IDoc-XML as text/xml, not as "${type || 'nothing'}"`, 415);
			}
			const { text, body, encoding } = await readXml(request, maxBody, counted);
			const parsed = parseIdocXml(text);
			const reply = inbox.replyFor(partner);
			const added = inbox.add(partner, parsed, { body, encoding }, reply);
			// SAP gave up waiting: for SAP the IDoc was not sent.
			if (reply.mode === 'slow' && (await delayUnlessClosed(response, reply.delayMs))) {
				inbox.markUnanswered(added.map((idoc) => idoc.seq));
				return;
			}
			answer(response, parsed.soap, reply, parsed.idocs.length);
			if (reply.mode === 'slow') inbox.markAnswered(added.map((idoc) => idoc.seq));
		} catch (error) {
			const status =
				error instanceof UserError ? error.status : error instanceof IdocError ? 400 : 500;
			const message = error instanceof Error ? error.message : String(error);
			inbox.fail({ partner, status, error: message, bytes: counted.bytes });
			if (status === 401) response.setHeader('www-authenticate', 'Basic realm="IDoc mock"');
			response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
			response.end(message);
		}
	};
}

/**
 * Without a token or login, the receiver answers only requests addressed to this computer by name. A web page that
 * points its own domain at 127.0.0.1 (DNS rebinding) sends its domain in the Host header and is turned away.
 */
function checkHost(request: IncomingMessage): void {
	const header = request.headers.host ?? '';
	// The port is not checked: a port forward (kubectl, ssh) arrives with its own local port.
	const name =
		/^(\[[^\]]+\]|[^:]+)(?::\d+)?$/
			.exec(header)?.[1]
			?.replace(/^\[|\]$/g, '')
			.toLowerCase() ?? '';
	if (!(name.endsWith('.localhost') || isLoopback(name)))
		throw new UserError(
			`without a login, the receiver answers only requests to this computer, not to "${header}"`,
			403
		);
}

function controlHandler(
	inbox: IdocInbox,
	token: string | undefined,
	idocUrl: () => string,
	sap: SapDestinations
) {
	return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		if (!token) checkHost(request);
		authorize(request, token);
		const { method, path, parts, params } = requestTarget(request);
		if (method === 'GET' && path === '/health') return json(response, 200, { ok: true });
		if (method === 'GET' && path === '/info')
			return json(response, 200, {
				idocUrl: idocUrl(),
				instance: inbox.instance,
				sap: SAP_SYSTEMS.flatMap((system) => {
					const destination = sap[system];
					return destination ? [targetInfo(system, destination)] : [];
				})
			});

		if (method === 'POST' && path === '/send') {
			const body = await readBody(request, SendBodySchema, MAX_SEND);
			const destination = sap[body.to];
			if (!destination)
				throw new UserError(
					`no ${SAP_SYSTEM_TITLES[body.to]} system to send to: start the receiver with IDOC_${body.to.toUpperCase()}_URL (or IDOC_FAKE_SAP=1)`,
					409
				);
			return json(response, 200, await sendAndRecord(inbox, destination.target, body));
		}
		// Only with a stand-in: how it answers, to test a refusal from "SAP".
		if (method === 'PUT' && parts[0] === 'fake-sap' && parts[2] === 'reply' && parts.length === 3) {
			const system = SAP_SYSTEMS.find((s) => s === parts[1]);
			if (!system)
				throw new UserError(`no SAP system "${parts[1]}": ${SAP_SYSTEMS.join(' or ')}`, 404);
			const fake = sap[system]?.standIn;
			if (!fake)
				throw new UserError(
					`${SAP_SYSTEM_TITLES[system]} has no stand-in (IDOC_FAKE_SAP=1 without IDOC_${system.toUpperCase()}_URL)`,
					409
				);
			fake.reply = await readBody(request, FakeReplySchema);
			return json(response, 200, fake.reply);
		}
		if (path === '/sent') {
			if (method === 'GET') {
				const after = Number(params.get('after') ?? 0);
				if (!Number.isInteger(after)) throw new UserError('after must be a number');
				return json(response, 200, inbox.sent(after));
			}
			if (method === 'DELETE') return json(response, 200, (inbox.clearSent(), { ok: true }));
		}

		if (parts[0] === 'idocs') {
			if (parts.length === 1) {
				if (method === 'GET') {
					const filter = IdocFilterSchema.safeParse(Object.fromEntries(params));
					if (!filter.success) throw new UserError(filter.error.issues[0]?.message ?? 'bad filter');
					return json(response, 200, {
						instance: inbox.instance,
						cursor: inbox.cursor,
						idocs: inbox.list(filter.data)
					});
				}
				if (method === 'DELETE') return json(response, 200, (inbox.clear(), { ok: true }));
			}
			const seq = Number(parts[1]);
			const idoc = Number.isInteger(seq) ? inbox.get(seq) : undefined;
			if (method === 'GET' && parts.length === 2) {
				if (!idoc) throw new UserError(`no IDoc ${parts[1]} (cleared, or never received)`, 404);
				return json(response, 200, idoc);
			}
			if (method === 'GET' && parts.length === 3 && parts[2] === 'raw') {
				const raw = Number.isInteger(seq) ? inbox.rawOf(seq) : undefined;
				if (raw === undefined) throw new UserError(`no raw request kept for IDoc ${parts[1]}`, 404);
				// The bytes as SAP sent them. Whoever can post to the IDoc endpoint decides what they hold, so a
				// browser must neither guess another type nor run anything in them.
				response.writeHead(200, {
					'content-type': `application/xml; charset=${raw.encoding}`,
					'x-content-type-options': 'nosniff',
					'content-security-policy': "default-src 'none'; sandbox"
				});
				response.end(raw.body);
				return;
			}
		}

		if (method === 'GET' && path === '/replies') return json(response, 200, inbox.allReplies());
		if (parts[0] === 'replies' && parts.length === 2) {
			const partner = parts[1];
			if (!PARTNER.test(partner)) throw new UserError(`"${partner}" is not a partner name`);
			// ?owner=<id>: a reply that holds only until the same owner takes it back (a running test).
			const owner = params.get('owner') ?? undefined;
			if (owner !== undefined && !OWNER.test(owner))
				throw new UserError(`"${owner}" is not an owner id (letters, digits, _ -)`);
			if (method === 'GET') return json(response, 200, inbox.replyFor(partner));
			if (method === 'PUT')
				return json(
					response,
					200,
					inbox.setReply(partner, await readBody(request, ReplySchema), owner)
				);
			if (method === 'DELETE')
				return json(response, 200, (inbox.resetReply(partner, owner), { ok: true }));
		}
		if (method === 'GET' && path === '/failures') return json(response, 200, inbox.failures());
		throw new UserError(`no route ${method} ${path}`, 404);
	};
}

/** Refuses settings that would expose the IDocs, a password or the control API to the network. */
function checkExposure(options: ReceiverOptions): void {
	for (const { target } of Object.values(options.sap ?? {})) {
		checkTarget(target);
		if ((target.basicAuth || target.tls?.cert) && !options.controlToken)
			throw new Error(
				'The control API can send IDocs into SAP with its login: set a control token, so only the app and its tests can.'
			);
	}
	const host = options.host ?? '127.0.0.1';
	if (!isLoopback(host)) {
		if (!options.tls)
			throw new Error(
				`The IDoc endpoint on ${host} is reachable from the network: give it a TLS certificate, or SAP sends IDocs and the password unencrypted.`
			);
		if (!options.basicAuth && !options.tls.ca)
			throw new Error(
				`The IDoc endpoint on ${host} accepts IDocs from anyone: set a user and password, or a CA for SAP's client certificate.`
			);
		if (!options.basicAuth && !options.tls.clientFingerprint)
			throw new Error(
				`The IDoc endpoint on ${host} accepts every client certificate its CA signed: set the fingerprint of SAP's certificate, or a user and password as well.`
			);
	}
	const controlHost = options.controlHost ?? '127.0.0.1';
	if (!isLoopback(controlHost)) {
		if (!options.controlToken)
			throw new Error(
				`The control API on ${controlHost} is reachable from the network: set a control token as well.`
			);
		if (!options.tls)
			throw new Error(
				`The control API on ${controlHost} is reachable from the network: give the receiver a TLS certificate, or the token and the IDocs travel unencrypted.`
			);
	}
}

function listen(server: Server, port: number, host: string): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, host, () => {
			const address = server.address();
			resolve(typeof address === 'object' && address ? address.port : port);
		});
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolve) => {
		server.close(() => resolve());
		// A slow reply would otherwise keep the server open until it is sent.
		server.closeAllConnections();
	});
}

const urlHost = (host: string) => (host.includes(':') ? `[${host}]` : host);

export async function startReceiver(options: ReceiverOptions = {}): Promise<RunningReceiver> {
	checkExposure(options);
	const inbox = options.inbox ?? new IdocInbox();
	const host = options.host ?? '127.0.0.1';
	const controlHost = options.controlHost ?? '127.0.0.1';

	const onIdoc = idocHandler(inbox, options);
	const idocListener = (request: IncomingMessage, response: ServerResponse) => {
		onIdoc(request, response).catch((error: unknown) => fail(response, error));
	};
	const idocServer = options.tls
		? createHttpsServer(
				{
					cert: options.tls.cert,
					key: options.tls.key,
					ca: options.tls.ca,
					// With a CA, the TLS handshake already turns away a caller without a certificate it signed.
					requestCert: Boolean(options.tls.ca),
					rejectUnauthorized: Boolean(options.tls.ca)
				},
				idocListener
			)
		: createHttpServer(idocListener);
	const idocPort = await listen(idocServer, options.port ?? 0, host);
	const idocUrl = `${options.tls ? 'https' : 'http'}://${urlHost(host)}:${idocPort}`;

	const onControl = controlHandler(inbox, options.controlToken, () => idocUrl, options.sap ?? {});
	const controlListener = (request: IncomingMessage, response: ServerResponse) => {
		onControl(request, response).catch((error: unknown) => fail(response, error));
	};
	// Beyond this computer over HTTPS, with the IDoc endpoint's certificate but no client certificate: the token
	// is the login.
	const controlTls = !isLoopback(controlHost) && options.tls;
	const controlServer = controlTls
		? createHttpsServer({ cert: controlTls.cert, key: controlTls.key }, controlListener)
		: createHttpServer(controlListener);
	let controlPort: number;
	try {
		controlPort = await listen(controlServer, options.controlPort ?? 0, controlHost);
	} catch (error) {
		idocServer.close();
		throw error;
	}

	return {
		idocUrl,
		controlUrl: `${controlTls ? 'https' : 'http'}://${urlHost(controlHost)}:${controlPort}`,
		inbox,
		close: async () => {
			await Promise.all([close(idocServer), close(controlServer)]);
		}
	};
}
