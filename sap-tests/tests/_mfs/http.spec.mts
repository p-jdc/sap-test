// KI-generiert, geprüft von: <Name>
// Who may use the Mock PLC's control API (mfs/http.mts).
import type { IncomingMessage } from 'node:http';
import { test, expect } from '../../sap-plugin';
import { authorize, isLoopback, UserError } from '../../mfs/http.mts';

/** A request as far as the check looks at it. */
const request = (method: string, url: string, headers: Record<string, string> = {}) =>
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only these three are read
	({ method, url, headers }) as IncomingMessage;

const status = (run: () => void): number => {
	try {
		run();
		return 200;
	} catch (error) {
		return error instanceof UserError ? error.status : 500;
	}
};

const json = { 'content-type': 'application/json' };

test('without a token, reading is open and changes must be JSON', () => {
	expect(status(() => authorize(request('GET', '/state'), undefined))).toBe(200);
	expect(status(() => authorize(request('POST', '/hus', json), undefined))).toBe(200);
	// What a form on a web page could send to a local port.
	expect(status(() => authorize(request('POST', '/hus'), undefined))).toBe(415);
	expect(
		status(() => authorize(request('POST', '/hus', { 'content-type': 'text/plain' }), undefined))
	).toBe(415);
});

test('with a token, every request needs it except the health check', () => {
	const bearer = { authorization: 'Bearer s3cret' };
	expect(status(() => authorize(request('GET', '/health'), 's3cret'))).toBe(200);
	expect(status(() => authorize(request('GET', '/state'), 's3cret'))).toBe(401);
	expect(status(() => authorize(request('GET', '/state', bearer), 's3cret'))).toBe(200);
	expect(
		status(() => authorize(request('GET', '/state', { authorization: 'Bearer wrong!' }), 's3cret'))
	).toBe(401);
	expect(
		status(() => authorize(request('GET', '/state', { authorization: 's3cret' }), 's3cret'))
	).toBe(401);
	expect(status(() => authorize(request('POST', '/hus', { ...json, ...bearer }), 's3cret'))).toBe(
		200
	);
	expect(status(() => authorize(request('POST', '/hus', bearer), 's3cret'))).toBe(415);
});

test('only this computer counts as local', () => {
	expect(['127.0.0.1', '127.1.2.3', 'localhost', '::1'].map(isLoopback)).toEqual([
		true,
		true,
		true,
		true
	]);
	expect(['0.0.0.0', '10.0.0.5', '::', 'mfs.example.com'].map(isLoopback)).toEqual([
		false,
		false,
		false,
		false
	]);
});
