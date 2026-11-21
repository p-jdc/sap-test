// KI-generiert, geprüft von: <Name>
// The IDoc receiver (idoc/receiver.mts) on its own: each test starts a receiver in this process and posts IDocs
// to it the way SAP's XML HTTP port would. No browser, no SAP system.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import { test, expect } from '../../sap-plugin';
import { X509Certificate } from 'node:crypto';
import { hasOpenssl, makeTestCerts } from '../../idoc/certs.mts';
import { z } from 'zod';
import {
	FailureSchema,
	IdocInbox,
	ReceivedIdocSchema,
	type ReceivedIdoc
} from '../../idoc/inbox.mts';
import { startReceiver, type ReceiverOptions, type RunningReceiver } from '../../idoc/receiver.mts';

const sample = (name: string) =>
	readFileSync(new URL(`../../idoc/samples/${name}`, import.meta.url), 'utf8');
const orders = sample('orders05.xml');
const ordersSoap = sample('orders05-soap.xml');
const custom = sample('zpwmock01.xml');

let running: RunningReceiver[] = [];
async function receiver(options: ReceiverOptions = {}) {
	const started = await startReceiver(options);
	running.push(started);
	return started;
}
test.afterEach(async () => {
	await Promise.all(running.map((r) => r.close()));
	running = [];
});

function send(
	r: RunningReceiver,
	partner: string,
	body: string | Blob,
	headers: Record<string, string> = {}
) {
	return fetch(`${r.idocUrl}/idoc/${partner}`, {
		method: 'POST',
		headers: { 'content-type': 'text/xml', ...headers },
		body
	});
}

async function control(
	r: RunningReceiver,
	method: string,
	path: string,
	body?: unknown,
	token?: string
) {
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (token) headers.authorization = `Bearer ${token}`;
	const response = await fetch(`${r.controlUrl}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	return { status: response.status, body: JSON.parse(await response.text()) as unknown };
}

const ListSchema = z.object({ idocs: z.array(ReceivedIdocSchema) });

async function listed(r: RunningReceiver, query = ''): Promise<ReceivedIdoc[]> {
	const { body } = await control(r, 'GET', `/idocs${query}`);
	return ListSchema.parse(body).idocs;
}

test('an IDoc posted as SAP would is accepted and kept with its partner and raw body', async () => {
	const r = await receiver();
	const response = await send(r, 'PWMOCK', orders);
	expect(response.status).toBe(200);
	expect(await response.text()).toBe('1 IDoc(s) received');

	const [received] = await listed(r);
	expect(received).toMatchObject({
		seq: 1,
		partner: 'PWMOCK',
		soap: false,
		root: 'ORDERS05',
		accepted: true,
		reply: 'accept'
	});
	expect(received.idoc.control.DOCNUM).toBe('0000000000123456');
	expect((await control(r, 'GET', '/idocs/1')).body).toEqual(received);
	expect(await (await fetch(`${r.controlUrl}/idocs/1/raw`)).text()).toBe(orders);
});

test('an IDoc in a SOAP envelope gets a SOAP answer', async () => {
	const r = await receiver();
	const response = await send(r, 'PWMOCK', ordersSoap);
	expect(response.status).toBe(200);
	expect(response.headers.get('content-type')).toContain('text/xml');
	expect(await response.text()).toContain('<soapenv:Body></soapenv:Body>');
	expect((await listed(r))[0]).toMatchObject({ soap: true, root: 'ORDERS05' });
});

test('the inbox lists IDocs by partner, message type, IDoc type and position', async () => {
	const r = await receiver();
	await send(r, 'PWMOCK', orders);
	await send(r, 'OTHER', custom);

	const all = await listed(r);
	expect(all.map((i) => i.seq)).toEqual([1, 2, 3]);
	// The two IDocs of the custom sample came in one request.
	expect(all[1].request).toBe(all[2].request);
	expect((await listed(r, '?partner=OTHER')).map((i) => i.seq)).toEqual([2, 3]);
	expect((await listed(r, '?messageType=ORDRSP')).map((i) => i.seq)).toEqual([1]);
	expect((await listed(r, '?idocType=ZPWMOCK01')).map((i) => i.seq)).toEqual([2, 3]);
	expect((await listed(r, '?after=2')).map((i) => i.seq)).toEqual([3]);
	expect((await listed(r, '?limit=1')).map((i) => i.seq)).toEqual([1]);
	expect((await control(r, 'GET', '/idocs?after=x')).status).toBe(400);

	expect((await control(r, 'DELETE', '/idocs')).status).toBe(200);
	expect(await listed(r)).toEqual([]);
	// Numbering goes on after clearing, so a cursor taken before stays valid.
	await send(r, 'PWMOCK', orders);
	expect((await listed(r)).map((i) => i.seq)).toEqual([4]);
});

test('a partner set to reject gets the error status, and the IDoc is kept as rejected', async () => {
	const r = await receiver();
	const set = await control(r, 'PUT', '/replies/PWMOCK', {
		mode: 'reject',
		status: 503,
		message: 'Partner down'
	});
	expect(set.body).toEqual({ mode: 'reject', status: 503, message: 'Partner down' });

	const plain = await send(r, 'PWMOCK', orders);
	expect(plain.status).toBe(503);
	expect(await plain.text()).toBe('Partner down');
	const soap = await send(r, 'PWMOCK', ordersSoap);
	expect(soap.status).toBe(503);
	expect(await soap.text()).toContain('<faultstring>Partner down</faultstring>');
	// Other partners are not affected.
	expect((await send(r, 'OTHER', orders)).status).toBe(200);

	expect(
		(await listed(r)).map(({ partner, accepted, reply }) => ({ partner, accepted, reply }))
	).toEqual([
		{ partner: 'PWMOCK', accepted: false, reply: 'reject' },
		{ partner: 'PWMOCK', accepted: false, reply: 'reject' },
		{ partner: 'OTHER', accepted: true, reply: 'accept' }
	]);
	expect((await control(r, 'GET', '/replies')).body).toEqual({
		PWMOCK: { mode: 'reject', status: 503, message: 'Partner down' }
	});

	await control(r, 'DELETE', '/replies/PWMOCK');
	expect((await send(r, 'PWMOCK', orders)).status).toBe(200);
	expect((await control(r, 'PUT', '/replies/PWMOCK', { mode: 'reject', status: 200 })).status).toBe(
		400
	);
});

test('a partner set to slow gets its answer only after the delay', async () => {
	const r = await receiver();
	await control(r, 'PUT', '/replies/PWMOCK', { mode: 'slow', delayMs: 400 });
	const started = Date.now();
	const response = await send(r, 'PWMOCK', orders);
	expect(response.status).toBe(200);
	expect(Date.now() - started).toBeGreaterThanOrEqual(380);
	expect((await listed(r))[0]).toMatchObject({ accepted: true, reply: 'slow' });
});

test('an IDoc whose sender hangs up before the slow answer counts as not accepted', async () => {
	const r = await receiver();
	await control(r, 'PUT', '/replies/PWMOCK', { mode: 'slow', delayMs: 5000 });
	// SAP's HTTP timeout, much shorter than the delay.
	const sending = fetch(`${r.idocUrl}/idoc/PWMOCK`, {
		method: 'POST',
		headers: { 'content-type': 'text/xml' },
		body: orders,
		signal: AbortSignal.timeout(300)
	});
	await expect(sending).rejects.toThrow();
	await expect.poll(async () => (await listed(r))[0]?.accepted).toBe(false);
});

async function refused(response: Promise<Response>, status: number, text: RegExp) {
	const answer = await response;
	expect(answer.status).toBe(status);
	expect(await answer.text()).toMatch(text);
}

test('requests that are not IDocs are refused with a reason and logged', async () => {
	const r = await receiver({ maxBody: 1000 });
	await refused(send(r, 'PWMOCK', '<not-an-idoc/>'), 400, /holds no IDOC/);
	await refused(send(r, 'PWMOCK', 'x'.repeat(1001)), 413, /larger than 1000 bytes/);
	await refused(send(r, 'bad%20name', orders), 404, /not a partner name/);
	await refused(
		fetch(`${r.idocUrl}/somewhere`, { method: 'POST', body: orders }),
		404,
		/POST to \/idoc\/<partner>/
	);
	await refused(fetch(`${r.idocUrl}/idoc/PWMOCK`), 404, /POST/);
	await refused(
		send(r, 'PWMOCK', '<?xml version="1.0" encoding="EBCDIC-NOPE"?><X/>'),
		415,
		/unknown encoding/
	);
	expect(await listed(r)).toEqual([]);

	const { body } = await control(r, 'GET', '/failures');
	expect(
		z
			.array(FailureSchema)
			.parse(body)
			.map(({ status, bytes }) => ({ status, bytes }))
	).toEqual([
		{ status: 400, bytes: 14 },
		// Counted up to where reading stopped.
		{ status: 413, bytes: 1001 },
		{ status: 404, bytes: 0 },
		{ status: 415, bytes: 48 }
	]);
});

test('an IDoc in ISO-8859-1, as its XML declaration says, is decoded as such', async () => {
	const r = await receiver();
	const latin1 = Buffer.from(orders.replace('encoding="UTF-8"', 'encoding="ISO-8859-1"'), 'latin1');
	// One byte per umlaut: read as UTF-8 this would not decode.
	expect(latin1.includes(Buffer.from('ü', 'latin1'))).toBe(true);
	expect((await send(r, 'PWMOCK', new Blob([new Uint8Array(latin1)]))).status).toBe(200);
	const [received] = await listed(r);
	expect(received.idoc.segments[3].fields.NAME1).toBe('Müller & Söhne GmbH');

	// The raw request comes back as the bytes SAP sent, in their encoding, and a browser may not run it.
	const raw = await fetch(`${r.controlUrl}/idocs/${received.seq}/raw`);
	expect(raw.headers.get('content-type')).toBe('application/xml; charset=ISO-8859-1');
	expect(raw.headers.get('x-content-type-options')).toBe('nosniff');
	expect(raw.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
	expect(Buffer.from(await raw.arrayBuffer()).equals(latin1)).toBe(true);
});

const basic = (login: string) => ({
	authorization: `Basic ${Buffer.from(login).toString('base64')}`
});

test('with a login set, SAP must send the user and password of its destination', async () => {
	const r = await receiver({ basicAuth: { user: 'SAPIDOC', password: 'secret-1' } });

	const none = await send(r, 'PWMOCK', orders);
	expect(none.status).toBe(401);
	expect(none.headers.get('www-authenticate')).toBe('Basic realm="IDoc mock"');
	expect((await send(r, 'PWMOCK', orders, basic('SAPIDOC:wrong'))).status).toBe(401);
	expect((await send(r, 'PWMOCK', orders, basic('SAPIDOC:secret-1'))).status).toBe(200);
	expect(await listed(r)).toHaveLength(1);
});

test('with a control token set, the control API needs it; changes need JSON', async () => {
	const r = await receiver({ controlToken: 'tok-123' });
	expect((await fetch(`${r.controlUrl}/health`)).status).toBe(200);
	expect((await control(r, 'GET', '/idocs')).status).toBe(401);
	expect((await control(r, 'GET', '/idocs', undefined, 'wrong')).status).toBe(401);
	expect((await control(r, 'GET', '/idocs', undefined, 'tok-123')).status).toBe(200);
	// A web page can post plain forms to any local port, but not JSON.
	const form = await fetch(`${r.controlUrl}/idocs`, {
		method: 'DELETE',
		headers: { authorization: 'Bearer tok-123', 'content-type': 'text/plain' }
	});
	expect(form.status).toBe(415);
});

/** A control API request with a Host header of our choosing, as a page using DNS rebinding sends it. */
function getWithHost(r: RunningReceiver, host: string) {
	return new Promise<number>((resolve, reject) => {
		const req = httpRequest(`${r.controlUrl}/idocs`, { headers: { host } }, (response) => {
			response.resume();
			resolve(response.statusCode ?? 0);
		});
		req.on('error', reject);
		req.end();
	});
}

test('without a token, the control API answers only requests addressed to this computer', async () => {
	const r = await receiver();
	const port = new URL(r.controlUrl).port;
	expect(await getWithHost(r, `127.0.0.1:${port}`)).toBe(200);
	expect(await getWithHost(r, `localhost:${port}`)).toBe(200);
	// A port forward arrives with its own local port.
	expect(await getWithHost(r, 'localhost:9000')).toBe(200);
	expect(await getWithHost(r, `evil.example:${port}`)).toBe(403);
	expect(await getWithHost(r, `127.0.0.1.evil.example:${port}`)).toBe(403);

	// With a token, the token decides.
	const withToken = await receiver({ controlToken: 'tok-123' });
	expect((await control(withToken, 'GET', '/idocs', undefined, 'tok-123')).status).toBe(200);
});

test('settings that would open the receiver to the network unprotected are refused', async () => {
	const tls = { cert: 'cert', key: 'key' };
	await expect(startReceiver({ host: '0.0.0.0' })).rejects.toThrow(/TLS certificate/);
	await expect(startReceiver({ host: '0.0.0.0', tls })).rejects.toThrow(
		/accepts IDocs from anyone/
	);
	// Every certificate the CA signed would get in.
	await expect(startReceiver({ host: '0.0.0.0', tls: { ...tls, ca: 'ca' } })).rejects.toThrow(
		/fingerprint of SAP's certificate/
	);
	await expect(startReceiver({ controlHost: '0.0.0.0' })).rejects.toThrow(/control token/);
});

const raw = (text: string) => ({ body: Buffer.from(text), encoding: 'utf-8' });

test('the inbox keeps the newest IDocs and drops the raw body with the last IDoc of its request', () => {
	const inbox = new IdocInbox({ keep: 2 });
	const parsed = { root: 'X', soap: false, idocs: [{ control: { IDOCTYP: 'X' }, segments: [] }] };
	for (const text of ['one', 'two', 'three']) inbox.add('P', parsed, raw(text), { mode: 'accept' });
	expect(inbox.list().map((i) => i.seq)).toEqual([2, 3]);
	expect(inbox.rawOf(2)?.body.toString()).toBe('two');
	expect(inbox.cursor).toBe(3);

	const budget = new IdocInbox({ rawBudget: 5 });
	budget.add('P', parsed, raw('abcd'), { mode: 'accept' });
	budget.add('P', parsed, raw('efgh'), { mode: 'accept' });
	expect(budget.list().map((i) => i.seq)).toEqual([2]);
});

/** Posts over HTTPS, trusting `ca`, with a client certificate if given. */
function post(url: string, body: string, tls: { ca: string; cert?: string; key?: string }) {
	return new Promise<number>((resolve, reject) => {
		const req = httpsRequest(
			url,
			{ method: 'POST', headers: { 'content-type': 'text/xml' }, ...tls },
			(response) => {
				response.resume();
				resolve(response.statusCode ?? 0);
			}
		);
		req.on('error', reject);
		req.end(body);
	});
}

test.describe('over HTTPS', () => {
	test.skip(!hasOpenssl(), 'needs openssl to make test certificates');

	test('SAP reaches the receiver over TLS, and with a CA set only with its client certificate', async () => {
		const certs = makeTestCerts(test.info().outputPath('certs'));
		const tls = await receiver({ tls: { cert: certs.serverCert, key: certs.serverKey } });
		expect(tls.idocUrl).toMatch(/^https:/);
		expect(await post(`${tls.idocUrl}/idoc/PWMOCK`, orders, { ca: certs.ca })).toBe(200);

		const mutual = await receiver({
			tls: { cert: certs.serverCert, key: certs.serverKey, ca: certs.ca }
		});
		await expect(post(`${mutual.idocUrl}/idoc/PWMOCK`, orders, { ca: certs.ca })).rejects.toThrow();
		expect(
			await post(`${mutual.idocUrl}/idoc/PWMOCK`, orders, {
				ca: certs.ca,
				cert: certs.clientCert,
				key: certs.clientKey
			})
		).toBe(200);
		expect(mutual.inbox.list()).toHaveLength(1);
	});

	test('with a pinned fingerprint, only that client certificate may send', async () => {
		const dir = test.info().outputPath('certs');
		const certs = makeTestCerts(dir);
		const tls = { cert: certs.serverCert, key: certs.serverKey, ca: certs.ca };
		const client = { ca: certs.ca, cert: certs.clientCert, key: certs.clientKey };

		const pinned = await receiver({ tls: { ...tls, clientFingerprint: certs.clientFingerprint } });
		expect(await post(`${pinned.idocUrl}/idoc/PWMOCK`, orders, client)).toBe(200);
		// The same certificate, pinned against another one's fingerprint (lower case, no colons).
		const other = new X509Certificate(certs.serverCert).fingerprint256
			.replaceAll(':', '')
			.toLowerCase();
		const wrong = await receiver({ tls: { ...tls, clientFingerprint: other } });
		expect(await post(`${wrong.idocUrl}/idoc/PWMOCK`, orders, client)).toBe(403);
		expect(wrong.inbox.list()).toEqual([]);

		// The keys are for this user only, and the CA cannot sign anything more.
		expect(statSync(join(dir, 'client.key')).mode & 0o077).toBe(0);
		expect(existsSync(join(dir, 'ca.key'))).toBe(false);
	});
});
