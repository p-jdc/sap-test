// The IDoc sender: posts IDocs into SAP the way SAP Cloud Integration (CPI) does, over HTTPS. Two inbound services
// on the SAP side:
// - `soap`: /sap/bc/srt/idoc, IDoc-XML in a SOAP envelope. This is what CPI's IDoc receiver adapter calls. The
//   service is registered in SRTIDOC and active in SICF. SAP answers with the numbers it gave the IDocs.
// - `xml`: /sap/bc/idoc_xml, plain IDoc-XML.
// Both take the client from `sap-client`, and a user and password (basic authentication) or a client certificate
// (mutual TLS) mapped to a user in SAP.
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { rootCertificates } from 'node:tls';
import { XMLParser } from 'fast-xml-parser';
import { IdocError, type Idoc } from './idoc.mts';
import { toIdocXml } from './xml.mts';

export type SapService = 'soap' | 'xml';

export const SAP_PATHS: Record<SapService, string> = {
	soap: '/sap/bc/srt/idoc',
	xml: '/sap/bc/idoc_xml'
};

export interface SapTarget {
	/** The SAP system's address, for example https://s4dev.example.com:44300. Only the origin is used. */
	url: string;
	/** The client (`sap-client`); without it, SAP takes its default client. */
	client?: string;
	/** Which inbound service. `soap` (default) is the one CPI uses. */
	service?: SapService;
	basicAuth?: { user: string; password: string };
	tls?: {
		/** Client certificate and key (PEM) for mutual TLS: SAP maps the certificate to a user. */
		cert?: string | Buffer;
		key?: string | Buffer;
		/** CA (PEM) to trust for SAP's server certificate, besides the usual ones. */
		ca?: string | Buffer;
	};
	/** How long to wait for SAP's answer (default 60 s). */
	timeoutMs?: number;
}

export interface SendResult {
	/** True when SAP took the IDocs: HTTP 2xx and, for SOAP, no fault. */
	ok: boolean;
	status: number;
	service: SapService;
	/** The numbers SAP gave the IDocs (DOCNUM), in the order sent, when its answer names them. */
	idocNumbers: string[];
	/** Why SAP refused: a SOAP fault's message, or the start of its answer. */
	reason?: string;
	/** SAP's answer, cut off after 4,000 characters. */
	body: string;
	durationMs: number;
}

/** Largest answer read from SAP; an error page is a few kilobytes. */
const MAX_ANSWER = 256 * 1024;
const SHOWN = 4000;

const isLoopbackHost = (hostname: string) => {
	const name = hostname.replaceAll(/^\[|\]$/g, '').toLowerCase();
	return (
		name === 'localhost' ||
		name.endsWith('.localhost') ||
		name === '::1' ||
		/^127(?:\.\d{1,3}){3}$/.test(name)
	);
};

/** The target's origin, checked. Throws for settings that would send a login or IDocs unencrypted. */
export function checkTarget(target: SapTarget): URL {
	let url: URL;
	try {
		url = new URL(target.url);
	} catch {
		throw new IdocError(`"${target.url}" is not an address`);
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:')
		throw new IdocError(`SAP's address must start with https://, not ${url.protocol}`);
	if (url.protocol === 'http:' && !isLoopbackHost(url.hostname))
		throw new IdocError(
			`SAP's address must start with https://: over http:// to ${url.hostname} the IDocs and the login would cross the network unencrypted`
		);
	if (url.username || url.password)
		throw new IdocError('put the user and password in the settings, not in the address');
	if (Boolean(target.tls?.cert) !== Boolean(target.tls?.key))
		throw new IdocError('a client certificate needs its key, and the key its certificate');
	if (target.tls?.cert && url.protocol !== 'https:')
		throw new IdocError('a client certificate only works over https://');
	if (
		target.timeoutMs !== undefined &&
		!(Number.isInteger(target.timeoutMs) && target.timeoutMs > 0)
	)
		throw new IdocError(`the timeout must be a positive number of milliseconds`);
	if (target.client !== undefined && !/^\d{3}$/.test(target.client))
		throw new IdocError(`"${target.client}" is not a client (three digits)`);
	return new URL(url.origin);
}

/**
 * The control record as SAP's inbound processing needs it: TABNAM EDI_DC40 and DIRECT 2 (inbound), filled in when
 * missing. An IDoc marked outbound (DIRECT 1) is refused: it was meant for the other direction.
 */
export function asInbound(idoc: Idoc): Idoc {
	const { DIRECT, TABNAM } = idoc.control;
	if (DIRECT !== undefined && DIRECT !== '2')
		throw new IdocError(
			`the IDoc is marked as outbound (DIRECT ${DIRECT}); IDocs sent into SAP have DIRECT 2`
		);
	return { ...idoc, control: { ...idoc.control, TABNAM: TABNAM || 'EDI_DC40', DIRECT: '2' } };
}

const answerParser = new XMLParser({
	ignoreAttributes: true,
	removeNSPrefix: true,
	parseTagValue: false,
	isArray: () => true
});

/** Every text value of elements with this name, at any depth, in document order. */
function textsOf(node: unknown, name: string, found: string[] = []): string[] {
	if (Array.isArray(node)) for (const item of node) textsOf(item, name, found);
	else if (typeof node === 'object' && node !== null)
		for (const [key, value] of Object.entries(node)) {
			if (key === name)
				for (const item of [value].flat())
					if (typeof item === 'string' || typeof item === 'number') found.push(String(item).trim());
			textsOf(value, name, found);
		}
	return found;
}

/**
 * Reads SAP's answer. From /sap/bc/srt/idoc it is a SOAP envelope: on success it names each IDoc's number in a
 * `DbId` element (CPI passes it on as the header SapIDocDbId), on failure it holds a SOAP fault. A SOAP send counts
 * as taken only with an envelope without a fault: a logon or error page in front of the service may come with
 * status 200 too. A web page never counts as taken, whatever its status.
 */
export function readSapAnswer(
	service: SapService,
	status: number,
	body: string
): Pick<SendResult, 'ok' | 'idocNumbers' | 'reason'> {
	let parsed: unknown;
	if (/^\s*</.test(body) && !/<!DOCTYPE/i.test(body.slice(0, 500))) {
		try {
			parsed = answerParser.parse(body);
		} catch {
			parsed = undefined;
		}
	}
	const fault = parsed === undefined ? undefined : textsOf(parsed, 'faultstring')[0];
	const envelope =
		typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && 'Envelope' in parsed;
	const page = /^\s*(<!DOCTYPE\s+html|<html[\s>])/i.test(body);
	const ok =
		status >= 200 &&
		status < 300 &&
		fault === undefined &&
		!page &&
		(service === 'xml' || envelope);
	const idocNumbers =
		ok && service === 'soap' && parsed !== undefined
			? textsOf(parsed, 'DbId').filter((n) => /^\d+$/.test(n))
			: [];
	if (ok) return { ok, idocNumbers };
	const what =
		status >= 200 && status < 300 && fault === undefined
			? page
				? 'SAP answered with a web page instead of the service (a logon page?): '
				: 'SAP answered without a SOAP envelope: '
			: '';
	const text = body
		.replaceAll(/<[^>]*>/g, ' ')
		.replaceAll(/\s+/g, ' ')
		.trim();
	return {
		ok,
		idocNumbers,
		reason: fault ?? (what + text.slice(0, 300) || `HTTP ${status}`)
	};
}

function readAnswer(response: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		response.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size <= MAX_ANSWER) chunks.push(chunk);
		});
		response.on('end', () => {
			resolve(Buffer.concat(chunks).toString('utf8'));
		});
		response.on('error', reject);
	});
}

/** Posts IDocs into SAP. All IDocs of one call must have the same type: they travel in one document. */
export async function sendToSap(target: SapTarget, idocs: Idoc | Idoc[]): Promise<SendResult> {
	const origin = checkTarget(target);
	const service = target.service ?? 'soap';
	const list = (Array.isArray(idocs) ? idocs : [idocs]).map(asInbound);
	const body = Buffer.from(toIdocXml(list, { soap: service === 'soap' }), 'utf8');

	const url = new URL(SAP_PATHS[service], origin);
	if (target.client) url.searchParams.set('sap-client', target.client);
	const headers: Record<string, string> = {
		'content-type': 'text/xml; charset=utf-8',
		'content-length': String(body.length),
		accept: 'text/xml, application/xml, */*'
	};
	if (service === 'soap') headers.soapaction = '""';
	if (target.basicAuth)
		headers.authorization = `Basic ${Buffer.from(`${target.basicAuth.user}:${target.basicAuth.password}`).toString('base64')}`;

	const started = Date.now();
	const timeout = target.timeoutMs ?? 60_000;
	const https = url.protocol === 'https:';
	const { status, text } = await new Promise<{ status: number; text: string }>(
		(resolve, reject) => {
			const options = {
				method: 'POST',
				headers,
				timeout,
				...(https && {
					cert: target.tls?.cert,
					key: target.tls?.key,
					// Node's `ca` replaces the usual CAs; they are passed along, so the given one is added to them.
					ca: target.tls?.ca ? [...rootCertificates, target.tls.ca] : undefined
				})
			};
			const onResponse = (response: IncomingMessage) => {
				readAnswer(response).then(
					(answer) => resolve({ status: response.statusCode ?? 0, text: answer }),
					reject
				);
			};
			const request = https
				? httpsRequest(url, options, onResponse)
				: httpRequest(url, options, onResponse);
			request.on('timeout', () => {
				request.destroy(new IdocError(`SAP did not answer within ${timeout / 1000} s`));
			});
			request.on('error', reject);
			request.end(body);
		}
	).catch((error: unknown) => {
		if (error instanceof IdocError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new IdocError(`could not reach SAP at ${origin.origin}: ${message}`);
	});

	return {
		...readSapAnswer(service, status, text),
		status,
		service,
		body: text.slice(0, SHOWN),
		durationMs: Date.now() - started
	};
}
