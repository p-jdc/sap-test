// A stand-in for SAP's inbound IDoc services (/sap/bc/srt/idoc and /sap/bc/idoc_xml), for testing the sender
// without an SAP system. It numbers the IDocs it takes and answers the way the sender expects SAP to; how a real
// system answers is still to be checked (README, "Still to check against a real system"). Never a model of what
// SAP does with an IDoc after that.
import {
	createServer as createHttpServer,
	type IncomingMessage,
	type Server,
	type ServerResponse
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { IdocError, type Idoc } from './idoc.mts';
import { SAP_PATHS, type SapService } from './sender.mts';
import { parseIdocXml } from './xml.mts';

export interface FakeSapOptions {
	/** The only client it accepts (`sap-client`); any if not set. */
	client?: string;
	/** The user and password it requires. */
	basicAuth?: { user: string; password: string };
	/** HTTPS with this certificate; with `ca`, a client certificate signed by it is required. */
	tls?: { cert: string | Buffer; key: string | Buffer; ca?: string | Buffer };
}

export interface FakeSapIdoc {
	/** The number it gave the IDoc, 16 digits like SAP's DOCNUM. */
	docnum: string;
	service: SapService;
	client?: string;
	idoc: Idoc;
}

export interface FakeSapReply {
	/** `reject`: answer with this HTTP status and message (a SOAP fault for SOAP), keep nothing. */
	mode: 'accept' | 'reject';
	status?: number;
	message?: string;
}

export interface RunningFakeSap {
	url: string;
	/** What it took, oldest first. */
	received: FakeSapIdoc[];
	/** How it answers the next requests. */
	reply: FakeSapReply;
	close(): Promise<void>;
}

const SOAP_ENV = 'http://schemas.xmlsoap.org/soap/envelope/';
const MAX_BODY = 10 * 1024 * 1024;

const escapeXml = (text: string) =>
	text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const envelope = (body: string) =>
	`<?xml version="1.0" encoding="utf-8"?><soap-env:Envelope xmlns:soap-env="${SOAP_ENV}"><soap-env:Header/><soap-env:Body>${body}</soap-env:Body></soap-env:Envelope>`;

function send(response: ServerResponse, status: number, soap: boolean, text: string) {
	response.writeHead(status, {
		'content-type': soap ? 'text/xml; charset=utf-8' : 'text/plain; charset=utf-8'
	});
	response.end(text);
}

function fault(response: ServerResponse, status: number, soap: boolean, message: string) {
	send(
		response,
		status,
		soap,
		soap
			? envelope(
					`<soap-env:Fault><faultcode>soap-env:Server</faultcode><faultstring>${escapeXml(message)}</faultstring></soap-env:Fault>`
				)
			: message
	);
}

async function readText(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
		size += buffer.length;
		if (size > MAX_BODY) throw new IdocError('the request is too large');
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString('utf8');
}

export async function startFakeSap(options: FakeSapOptions = {}): Promise<RunningFakeSap> {
	let next = 1;
	const state: Pick<RunningFakeSap, 'received' | 'reply'> = {
		received: [],
		reply: { mode: 'accept' }
	};

	const handle = async (request: IncomingMessage, response: ServerResponse) => {
		const url = new URL(request.url ?? '/', 'http://fake-sap');
		const path = url.pathname.replace(/\/+$/, '');
		const service: SapService | undefined =
			path === SAP_PATHS.soap ? 'soap' : path === SAP_PATHS.xml ? 'xml' : undefined;
		if (request.method !== 'POST' || !service)
			return fault(response, 404, false, `no service ${request.method} ${url.pathname}`);
		const soap = service === 'soap';
		if (options.basicAuth) {
			const { user, password } = options.basicAuth;
			const expected = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
			if (request.headers.authorization !== expected) {
				response.setHeader('www-authenticate', 'Basic realm="SAP NetWeaver Application Server"');
				return fault(response, 401, false, 'Logon failed');
			}
		}
		const client = url.searchParams.get('sap-client') ?? undefined;
		if (options.client && client !== options.client)
			return fault(response, 401, false, `Logon failed: client ${client ?? '(none)'}`);

		let idocs: Idoc[];
		try {
			const parsed = parseIdocXml(await readText(request));
			if (parsed.soap !== soap)
				throw new IdocError(
					soap ? 'expected IDoc-XML in a SOAP envelope' : 'expected IDoc-XML without SOAP'
				);
			idocs = parsed.idocs;
		} catch (error) {
			return fault(response, 500, soap, error instanceof Error ? error.message : String(error));
		}
		if (state.reply.mode === 'reject')
			return fault(
				response,
				state.reply.status ?? 500,
				soap,
				state.reply.message ?? 'Rejected by the fake SAP'
			);
		const taken = idocs.map((idoc) => ({
			docnum: String(next++).padStart(16, '0'),
			service,
			client,
			idoc
		}));
		state.received.push(...taken);
		if (!soap) return send(response, 200, false, '');
		const assigned = taken
			.map(({ docnum }, index) => `<TransferId>${index + 1}</TransferId><DbId>${docnum}</DbId>`)
			.join('');
		send(
			response,
			200,
			true,
			envelope(
				`<n0:idocAssign xmlns:n0="urn:sap-com:document:sap:idoc:soap:messages">${assigned}</n0:idocAssign>`
			)
		);
	};
	const listener = (request: IncomingMessage, response: ServerResponse) => {
		handle(request, response).catch((error: unknown) => {
			fault(response, 500, false, error instanceof Error ? error.message : String(error));
		});
	};
	const server: Server = options.tls
		? createHttpsServer(
				{
					cert: options.tls.cert,
					key: options.tls.key,
					ca: options.tls.ca,
					requestCert: Boolean(options.tls.ca),
					rejectUnauthorized: Boolean(options.tls.ca)
				},
				listener
			)
		: createHttpServer(listener);
	const port = await new Promise<number>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			resolve(typeof address === 'object' && address ? address.port : 0);
		});
	});
	const fake: RunningFakeSap = {
		url: `${options.tls ? 'https' : 'http'}://127.0.0.1:${port}`,
		get received() {
			return state.received;
		},
		get reply() {
			return state.reply;
		},
		set reply(value) {
			state.reply = value;
		},
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			})
	};
	return fake;
}
