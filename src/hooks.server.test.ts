import type { RequestEvent } from '@sveltejs/kit';
import { expect, test } from 'vitest';
import { handle } from './hooks.server.js';

const PAGE = new Response('the app');

/** Sends one request through the hook; `resolve` stands for the rest of the app. */
function request(url: string, host?: string) {
	const event = {
		url: new URL(url),
		request: new Request(url, { headers: host ? { host } : {} })
	};
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the hook reads only these two
	return handle({ event: event as RequestEvent, resolve: () => Promise.resolve(PAGE) });
}

test('a request to localhost reaches the app', async () => {
	expect(await request('http://localhost:4180/', 'localhost:4180')).toBe(PAGE);
});

test('a request under another name is refused before it reaches the app', async () => {
	const response = await request('http://localhost:4180/', 'evil.example:4180');
	expect(response.status).toBe(403);
	expect(await response.text()).toContain('TEST_APP_ALLOWED_HOSTS');
});

test('without a Host header (HTTP/2) the host of the URL decides', async () => {
	expect(await request('https://localhost:5180/tests')).toBe(PAGE);
	expect((await request('https://evil.example/tests')).status).toBe(403);
});
