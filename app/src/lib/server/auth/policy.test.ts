import { describe, expect, test } from 'vitest';
import {
	authMode,
	exposureProblem,
	foreignOrigin,
	isPublicPath,
	listensLocally,
	localAuthHosts,
	safeRedirect,
	signedOutResponse
} from './policy.js';

describe('authMode', () => {
	test('off unless set to passkey; anything else is a mistake, not off', () => {
		expect(authMode('')).toBe('off');
		expect(authMode('OFF')).toBe('off');
		expect(authMode(' passkey ')).toBe('passkey');
		expect(() => authMode('true')).toThrow('TEST_APP_AUTH must be');
	});
});

describe('exposureProblem', () => {
	test('listening on this computer needs no sign-in', () => {
		for (const host of [undefined, '', '127.0.0.1', '127.0.0.5', 'localhost', '::1', '[::1]'])
			expect(listensLocally(host)).toBe(true);
		expect(exposureProblem('off', '127.0.0.1')).toBeNull();
	});

	test('the network without sign-in is refused, with sign-in allowed', () => {
		for (const host of ['0.0.0.0', '::', '10.1.2.3', 'lab.example.com'])
			expect(exposureProblem('off', host)).toContain('TEST_APP_AUTH=passkey');
		expect(exposureProblem('passkey', '0.0.0.0', 'https://lab.example.com')).toBeNull();
	});

	test('on the network, sign-in needs the https address of the app', () => {
		expect(exposureProblem('passkey', '0.0.0.0', '')).toContain('BETTER_AUTH_URL');
		expect(exposureProblem('passkey', '0.0.0.0', 'http://lab.example.com')).toContain(
			'BETTER_AUTH_URL'
		);
		expect(exposureProblem('passkey', '127.0.0.1', '')).toBeNull();
	});
});

describe('sign-in on a laptop', () => {
	test("this computer's names and the configured ones, each with and without a port", () => {
		expect(localAuthHosts(['sap-lab'])).toEqual([
			'localhost',
			'localhost:*',
			'127.0.0.1',
			'127.0.0.1:*',
			'[::1]',
			'[::1]:*',
			'sap-lab',
			'sap-lab:*'
		]);
	});

	test('cookies are used only from the origin of the request, not another local port', () => {
		const url = 'http://localhost:5173/api/auth/sign-out';
		expect(
			foreignOrigin(url, new Headers({ cookie: 'a=1', origin: 'http://localhost:5173' }))
		).toBe(false);
		expect(
			foreignOrigin(url, new Headers({ cookie: 'a=1', origin: 'http://localhost:9999' }))
		).toBe(true);
		expect(foreignOrigin(url, new Headers({ origin: 'http://localhost:9999' }))).toBe(false);
		expect(foreignOrigin(url, new Headers({ cookie: 'a=1' }))).toBe(false);
	});
});

describe('requests without a session', () => {
	test('only the sign-in page and what it calls are public', () => {
		for (const path of [
			'/signin',
			'/api/auth/passkey/generate-authenticate-options',
			'/api/signin-state'
		])
			expect(isPublicPath(path)).toBe(true);
		for (const path of [
			'/',
			'/settings',
			'/signin-x',
			'/api/signin-state/x',
			'/api/authx',
			'/runs/1/files/trace.zip'
		])
			expect(isPublicPath(path)).toBe(false);
	});

	test('a page goes to the sign-in page and back; data gets 401', () => {
		const page = signedOutResponse(
			new Request('http://localhost/runs/1?x=2', { headers: { accept: 'text/html' } }),
			new URL('http://localhost/runs/1?x=2')
		);
		expect(page.status).toBe(303);
		expect(page.headers.get('location')).toBe('/signin?redirect=%2Fruns%2F1%3Fx%3D2');

		const home = signedOutResponse(
			new Request('http://localhost/', { headers: { accept: 'text/html' } }),
			new URL('http://localhost/')
		);
		expect(home.headers.get('location')).toBe('/signin');

		const data = signedOutResponse(
			new Request('http://localhost/_app/remote/abc/getRuns', { method: 'POST' }),
			new URL('http://localhost/_app/remote/abc/getRuns')
		);
		expect(data.status).toBe(401);
	});

	test('after signing in, the browser goes back only to a path on this app', () => {
		expect(safeRedirect('/runs/1?x=2')).toBe('/runs/1?x=2');
		for (const target of [null, '', 'https://evil.example', '//evil.example', '/\\evil.example'])
			expect(safeRedirect(target)).toBe('/');
	});
});
