import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

const TYPES = new Map([
	['html', 'text/html; charset=utf-8'],
	['js', 'text/javascript'],
	['css', 'text/css'],
	['json', 'application/json'],
	['png', 'image/png'],
	['jpeg', 'image/jpeg'],
	['jpg', 'image/jpeg'],
	['svg', 'image/svg+xml'],
	['webm', 'video/webm'],
	['zip', 'application/zip'],
	['md', 'text/markdown; charset=utf-8'],
	['txt', 'text/plain; charset=utf-8'],
	['woff2', 'font/woff2']
]);

export type ByteRange = { start: number; end: number };

/**
 * The part of a file of `size` bytes that a `Range` header asks for (`end` inclusive):
 * null without a usable header, so the whole file is sent, and 'unsatisfiable' when the range
 * lies outside the file. Several ranges in one header are not supported and count as none.
 */
export function byteRange(header: string | null, size: number): ByteRange | 'unsatisfiable' | null {
	const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '');
	if (!match) return null;
	const [, first = '', last = ''] = match;
	if (!first && !last) return null;
	if (!first) {
		// "-500": the last 500 bytes.
		const length = Number(last);
		return length > 0 && size > 0
			? { start: Math.max(0, size - length), end: size - 1 }
			: 'unsatisfiable';
	}
	const start = Number(first);
	const end = last ? Math.min(Number(last), size - 1) : size - 1;
	return start < size && start <= end ? { start, end } : 'unsatisfiable';
}

/** Reads the file chunk by chunk as the client takes them, and closes it when the client leaves. */
function fileStream(file: string, range: ByteRange | null): ReadableStream<Uint8Array> {
	const source = createReadStream(file, range ?? undefined);
	const chunks = source[Symbol.asyncIterator]();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const next = await chunks.next();
			if (next.done) controller.close();
			else if (next.value instanceof Uint8Array) controller.enqueue(next.value);
		},
		cancel() {
			source.destroy();
		}
	});
}

/**
 * Answers a GET for a file on disk as a stream, so a video or trace of any size never sits in
 * memory as a whole. Honours a `Range` header: browsers need it to seek in a video.
 */
export async function fileResponse(file: string, rangeHeader: string | null): Promise<Response> {
	const { size } = await stat(file);
	const ext = file.split('.').pop()?.toLowerCase() ?? '';
	const headers = new Headers({
		'content-type': TYPES.get(ext) ?? 'application/octet-stream',
		'cache-control': 'private, max-age=3600',
		'accept-ranges': 'bytes'
	});
	const range = byteRange(rangeHeader, size);
	if (range === 'unsatisfiable') {
		headers.set('content-range', `bytes */${size}`);
		return new Response(null, { status: 416, headers });
	}
	if (range) headers.set('content-range', `bytes ${range.start}-${range.end}/${size}`);
	const length = range ? range.end - range.start + 1 : size;
	headers.set('content-length', String(length));
	// An empty file has no bytes to stream (and a read range of 0–-1 would be invalid).
	const body = length === 0 ? null : fileStream(file, range);
	return new Response(body, { status: range ? 206 : 200, headers });
}
