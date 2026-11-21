// The IDoc receiver: plays the partner system SAP sends IDocs to. SAP posts IDoc-XML to it through an XML HTTP
// port (WE21) and a type G destination (SM59) pointing at https://<host>/idoc/<partner>. Two listeners, like the
// Mock PLC:
// - the IDoc endpoint, which SAP must reach: HTTPS, with a login (basic authentication) or SAP's client
//   certificate (mutual TLS);
// - the control API, for tests and the app: list and clear the inbox, set the reply per partner. It stays on this
//   computer unless a token protects it.
import {
	createServer as createHttpServer,
	type IncomingMessage,
	type Server,
	type ServerResponse
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { timingSafeEqual } from 'node:crypto';
import {
	authorize,
	fail,
	isLoopback,
	json,
	readBody,
	requestTarget,
	UserError
} from '../mfs/http.mts';
import { IdocError } from './idoc.mts';
import { IdocFilterSchema, IdocInbox, ReplySchema, type Reply } from './inbox.mts';
import { parseIdocXml } from './xml.mts';

export interface ReceiverOptions {
	/** Address of the IDoc endpoint (default 127.0.0.1). */
	host?: string;
	/** Port of the IDoc endpoint (default 0: a free port). */
	port?: number;
	/** Server certificate and key (PEM). With `ca`, SAP must present a client certificate signed by it. */
	tls?: { cert: string | Buffer; key: string | Buffer; ca?: string | Buffer };
	/** The user and password of the type G destination. */
	basicAuth?: { user: string; password: string };
	controlHost?: string;
	controlPort?: number;
	/** Every control API request must carry `Authorization: Bearer <token>`. */
	controlToken?: string;
	inbox?: IdocInbox;
	/** Largest request SAP may send, in bytes (default 10 MB). */
	maxBody?: number;
}

export interface RunningReceiver {
	/** Base address of the IDoc endpoint; SAP posts to `${idocUrl}/idoc/<partner>`. */
	idocUrl: string;
	controlUrl: string;
	inbox: IdocInbox;
	close(): Promise<void>;
}

const PARTNER = /^[A-Za-z0-9_.-]{1,40}$/;
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

/** Reads the whole body as bytes, then decodes it in the encoding its XML declaration names (UTF-8 if none). */
async function readXml(
	request: IncomingMessage,
	maxBody: number
): Promise<{ text: string; bytes: number }> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
		bytes += buffer.length;
		if (bytes > maxBody) throw new UserError(`the request is larger than ${maxBody} bytes`, 413);
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
		return { text: decoder.decode(body), bytes };
	} catch {
		throw new UserError(`the body is not valid ${declared ?? 'UTF-8'}`, 400);
	}
}

function checkLogin(request: IncomingMessage, login: ReceiverOptions['basicAuth']): void {
	if (!login) return;
	const expected = `Basic ${Buffer.from(`${login.user}:${login.password}`).toString('base64')}`;
	if (!sameText(request.headers.authorization ?? '', expected))
		throw new UserError('user or password missing or wrong', 401);
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
		let bytes = 0;
		try {
			if (!PARTNER.test(partner))
				throw new UserError(`"${partner}" is not a partner name (letters, digits, _ . -)`, 404);
			checkLogin(request, options.basicAuth);
			const body = await readXml(request, maxBody);
			bytes = body.bytes;
			const parsed = parseIdocXml(body.text);
			const reply = inbox.replyFor(partner);
			inbox.add(partner, parsed, body.text, reply);
			if (reply.mode === 'slow') await delay(reply.delayMs);
			answer(response, parsed.soap, reply, parsed.idocs.length);
		} catch (error) {
			const status =
				error instanceof UserError ? error.status : error instanceof IdocError ? 400 : 500;
			const message = error instanceof Error ? error.message : String(error);
			inbox.fail({ partner, status, error: message, bytes });
			if (status === 401) response.setHeader('www-authenticate', 'Basic realm="IDoc mock"');
			response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
			response.end(message);
		}
	};
}

function controlHandler(inbox: IdocInbox, token: string | undefined, idocUrl: () => string) {
	return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		authorize(request, token);
		const { method, path, parts, params } = requestTarget(request);
		if (method === 'GET' && path === '/health') return json(response, 200, { ok: true });
		if (method === 'GET' && path === '/info') return json(response, 200, { idocUrl: idocUrl() });

		if (parts[0] === 'idocs') {
			if (parts.length === 1) {
				if (method === 'GET') {
					const filter = IdocFilterSchema.safeParse(Object.fromEntries(params));
					if (!filter.success) throw new UserError(filter.error.issues[0]?.message ?? 'bad filter');
					return json(response, 200, { cursor: inbox.cursor, idocs: inbox.list(filter.data) });
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
				response.writeHead(200, { 'content-type': 'text/xml; charset=utf-8' });
				response.end(raw);
				return;
			}
		}

		if (method === 'GET' && path === '/replies') return json(response, 200, inbox.allReplies());
		if (parts[0] === 'replies' && parts.length === 2) {
			const partner = parts[1];
			if (!PARTNER.test(partner)) throw new UserError(`"${partner}" is not a partner name`);
			if (method === 'GET') return json(response, 200, inbox.replyFor(partner));
			if (method === 'PUT')
				return json(response, 200, inbox.setReply(partner, await readBody(request, ReplySchema)));
			if (method === 'DELETE')
				return json(response, 200, (inbox.resetReply(partner), { ok: true }));
		}
		if (method === 'GET' && path === '/failures') return json(response, 200, inbox.failures());
		throw new UserError(`no route ${method} ${path}`, 404);
	};
}

/** Refuses settings that would expose the IDocs, a password or the control API to the network. */
function checkExposure(options: ReceiverOptions): void {
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
	}
	const controlHost = options.controlHost ?? '127.0.0.1';
	if (!isLoopback(controlHost) && !options.controlToken)
		throw new Error(
			`The control API on ${controlHost} is reachable from the network: set a control token as well.`
		);
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

	const onControl = controlHandler(inbox, options.controlToken, () => idocUrl);
	const controlServer = createHttpServer((request, response) => {
		onControl(request, response).catch((error: unknown) => fail(response, error));
	});
	let controlPort: number;
	try {
		controlPort = await listen(controlServer, options.controlPort ?? 0, controlHost);
	} catch (error) {
		idocServer.close();
		throw error;
	}

	return {
		idocUrl,
		controlUrl: `http://${urlHost(controlHost)}:${controlPort}`,
		inbox,
		close: async () => {
			await Promise.all([close(idocServer), close(controlServer)]);
		}
	};
}
