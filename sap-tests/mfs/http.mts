// Small helpers for the JSON control APIs of the emulator and the fake EWM.
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';

/** An error caused by the request (wrong input, unknown object): answered with its status, not 500. */
export class UserError extends Error {
	status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}

export function json(response: ServerResponse, status: number, body: unknown) {
	response.writeHead(status, { 'content-type': 'application/json' });
	response.end(JSON.stringify(body));
}

/** Answers a failed request: UserError with its status and message, anything else with 500. */
export function fail(response: ServerResponse, error: unknown) {
	const status = error instanceof UserError ? error.status : 500;
	json(response, status, { error: error instanceof Error ? error.message : String(error) });
}

/** The control API's bodies are a few fields; anything larger is not meant for it. */
const MAX_BODY = 64 * 1024;

const sameText = (a: string, b: string) => {
	const [left, right] = [Buffer.from(a), Buffer.from(b)];
	return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * Who may use the control API. It puts HUs in, switches devices off and breaks connections, so:
 * - with a token set, every request must carry it (`Authorization: Bearer <token>`); only
 *   `GET /health` is open, for the cluster's probes;
 * - a request that changes something must be JSON. A web page open in a browser on the same
 *   computer can send plain forms to any local port, but not JSON, without the server allowing it.
 */
export function authorize(request: IncomingMessage, token: string | undefined): void {
	const { method, path } = requestTarget(request);
	if (method === 'GET' && path === '/health') return;
	if (token) {
		const given = request.headers.authorization ?? '';
		if (!sameText(given, `Bearer ${token}`))
			throw new UserError('the control token is missing or wrong', 401);
	}
	const type = request.headers['content-type'] ?? '';
	if (method !== 'GET' && !type.toLowerCase().startsWith('application/json'))
		throw new UserError('send the body as JSON (content-type: application/json)', 415);
}

/** A host name or address that always means this computer. */
export function isLoopback(host: string): boolean {
	return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** Reads a JSON body and checks it against a schema. */
export async function readBody<T>(request: IncomingMessage, schema: z.ZodType<T>): Promise<T> {
	let text = '';
	for await (const chunk of request) {
		text += String(chunk);
		if (text.length > MAX_BODY) throw new UserError('the request body is too large', 413);
	}
	let value: unknown;
	try {
		value = text ? JSON.parse(text) : {};
	} catch {
		throw new UserError('body is not valid JSON');
	}
	const result = schema.safeParse(value);
	if (!result.success) throw new UserError(z.prettifyError(result.error));
	return result.data;
}

/** A path part without its percent-encoding. A broken one (`%`, `%zz`) is the caller's mistake. */
function decodePart(part: string): string {
	try {
		return decodeURIComponent(part);
	} catch {
		throw new UserError(`"${part}" in the path is not valid percent-encoding`);
	}
}

/** The request's path split into decoded parts, its method and its query parameters. */
export function requestTarget(request: IncomingMessage) {
	const url = new URL(request.url ?? '/', 'http://localhost');
	return {
		method: request.method ?? 'GET',
		path: url.pathname,
		parts: url.pathname.split('/').filter(Boolean).map(decodePart),
		params: url.searchParams
	};
}
