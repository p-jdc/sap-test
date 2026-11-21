// Small helpers for the JSON control APIs of the emulator and the fake EWM.
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

/** Reads a JSON body and checks it against a schema. */
export async function readBody<T>(request: IncomingMessage, schema: z.ZodType<T>): Promise<T> {
	let text = '';
	for await (const chunk of request) text += String(chunk);
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
