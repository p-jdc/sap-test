import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { must } from '../../test/must.js';
import { byteRange, fileResponse } from './file-response.js';

function fileWith(name: string, content: string): string {
	const file = join(mkdtempSync(join(tmpdir(), 'file-response-')), name);
	writeFileSync(file, content);
	return file;
}

describe('byteRange', () => {
	test.each([
		['bytes=0-3', { start: 0, end: 3 }],
		['bytes=4-', { start: 4, end: 9 }],
		['bytes=-3', { start: 7, end: 9 }],
		['bytes=-50', { start: 0, end: 9 }],
		['bytes=8-50', { start: 8, end: 9 }]
	])('%s of ten bytes', (header, expected) => {
		expect(byteRange(header, 10)).toEqual(expected);
	});

	test.each(['bytes=10-', 'bytes=12-14', 'bytes=5-2', 'bytes=-0'])(
		'%s lies outside ten bytes',
		(header) => {
			expect(byteRange(header, 10)).toBe('unsatisfiable');
		}
	);

	test.each([null, '', 'bytes=-', 'items=0-3', 'bytes=0-1,4-5', 'bytes=a-b'])(
		'%s asks for the whole file',
		(header) => {
			expect(byteRange(header, 10)).toBeNull();
		}
	);
});

describe('fileResponse', () => {
	test('sends a whole file with its type and length', async () => {
		const response = await fileResponse(fileWith('video.webm', '0123456789'), null);
		expect(response.status).toBe(200);
		expect(Object.fromEntries(response.headers)).toMatchObject({
			'content-type': 'video/webm',
			'content-length': '10',
			'accept-ranges': 'bytes'
		});
		expect(await response.text()).toBe('0123456789');
	});

	test('sends only the requested part', async () => {
		const response = await fileResponse(fileWith('video.webm', '0123456789'), 'bytes=2-5');
		expect(response.status).toBe(206);
		expect(response.headers.get('content-range')).toBe('bytes 2-5/10');
		expect(response.headers.get('content-length')).toBe('4');
		expect(await response.text()).toBe('2345');
	});

	test('refuses a part outside the file', async () => {
		const response = await fileResponse(fileWith('trace.zip', '0123456789'), 'bytes=20-');
		expect(response.status).toBe(416);
		expect(response.headers.get('content-range')).toBe('bytes */10');
	});

	test('sends an empty file and an unknown type as plain bytes', async () => {
		const response = await fileResponse(fileWith('data.bin', ''), null);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/octet-stream');
		expect(await response.text()).toBe('');
	});
});

describe('a large file', () => {
	test('arrives complete, in several chunks', async () => {
		const content = 'abcdefghij'.repeat(30_000);
		const response = await fileResponse(fileWith('trace.zip', content), null);
		const chunks = await Array.fromAsync(must(response.body));
		expect(chunks.length).toBeGreaterThan(1);
		expect(Buffer.concat(chunks).toString()).toBe(content);
	});

	test('can be abandoned after the first chunk', async () => {
		const response = await fileResponse(fileWith('trace.zip', 'x'.repeat(300_000)), null);
		const reader = must(response.body).getReader();
		expect((await reader.read()).done).toBe(false);
		await expect(reader.cancel()).resolves.toBeUndefined();
	});
});
