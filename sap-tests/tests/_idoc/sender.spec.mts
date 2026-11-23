// KI-generiert, geprüft von: <Name>
// The IDoc sender (idoc/sender.mts) and the receiver's POST /send, against the stand-in for SAP's inbound services
// (idoc/fake-sap.mts) in this process. No browser, no SAP system.
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { z } from 'zod';
import { test, expect } from '../../sap-plugin';
import { hasOpenssl, makeTestCerts } from '../../idoc/certs.mts';
import { startFakeSap, type FakeSapOptions, type RunningFakeSap } from '../../idoc/fake-sap.mts';
import type { Idoc } from '../../idoc/idoc.mts';
import { SentIdocsSchema } from '../../idoc/inbox.mts';
import { startReceiver, type ReceiverOptions, type RunningReceiver } from '../../idoc/receiver.mts';
import {
	asInbound,
	checkTarget,
	readSapAnswer,
	sendToSap,
	type SapTarget
} from '../../idoc/sender.mts';
import { parseIdocXml } from '../../idoc/xml.mts';

const sample = (name: string) =>
	readFileSync(new URL(`../../idoc/samples/${name}`, import.meta.url), 'utf8');
const inbound = parseIdocXml(sample('orders05-inbound.xml')).idocs[0];
/** The same order without TABNAM and DIRECT, which the sender fills in. */
const bare: Idoc = {
	...inbound,
	control: Object.fromEntries(
		Object.entries(inbound.control).filter(([name]) => name !== 'TABNAM' && name !== 'DIRECT')
	)
};

let fakes: RunningFakeSap[] = [];
let receivers: RunningReceiver[] = [];
let servers: Server[] = [];
async function fakeSap(options: FakeSapOptions = {}) {
	const started = await startFakeSap(options);
	fakes.push(started);
	return started;
}
async function receiver(options: ReceiverOptions) {
	const started = await startReceiver(options);
	receivers.push(started);
	return started;
}
test.afterEach(async () => {
	await Promise.all([...receivers, ...fakes].map((r) => r.close()));
	for (const server of servers) server.close();
	[fakes, receivers, servers] = [[], [], []];
});

test.describe('sending into SAP', () => {
	test('over SOAP, as CPI does: SAP numbers the IDocs and the sender reads the numbers back', async () => {
		const sap = await fakeSap({ client: '100' });
		const result = await sendToSap({ url: sap.url, client: '100' }, [bare, bare]);

		expect(result).toMatchObject({ ok: true, status: 200, service: 'soap' });
		expect(result.idocNumbers).toEqual(['0000000000000001', '0000000000000002']);
		expect(sap.received).toHaveLength(2);
		expect(sap.received[0]).toMatchObject({ service: 'soap', client: '100' });
		// Filled in for SAP's inbound processing.
		expect(sap.received[0].idoc.control).toMatchObject({ TABNAM: 'EDI_DC40', DIRECT: '2' });
		expect(sap.received[0].idoc.segments).toEqual(inbound.segments);
	});

	test('as plain IDoc-XML to /sap/bc/idoc_xml', async () => {
		const sap = await fakeSap();
		const result = await sendToSap({ url: sap.url, service: 'xml' }, inbound);
		expect(result).toMatchObject({ ok: true, status: 200, service: 'xml', idocNumbers: [] });
		expect(sap.received[0]).toMatchObject({ service: 'xml', client: undefined });
	});

	test('with a user and password; a wrong one is refused and nothing is taken', async () => {
		const login = { user: 'CPI_IDOC', password: 'not-a-real-secret' };
		const sap = await fakeSap({ basicAuth: login });
		expect((await sendToSap({ url: sap.url, basicAuth: login }, inbound)).ok).toBe(true);

		const wrong = await sendToSap(
			{ url: sap.url, basicAuth: { ...login, password: 'wrong' } },
			inbound
		);
		expect(wrong).toMatchObject({ ok: false, status: 401, reason: 'Logon failed' });
		expect(sap.received).toHaveLength(1);
	});

	test('a SOAP fault is a refusal, with its message as the reason', async () => {
		const sap = await fakeSap();
		sap.reply = { mode: 'reject', status: 500, message: 'Partner profile not available' };
		const result = await sendToSap({ url: sap.url }, inbound);
		expect(result).toMatchObject({
			ok: false,
			status: 500,
			reason: 'Partner profile not available',
			idocNumbers: []
		});
		expect(result.body).toContain('<faultstring>');
	});

	test('an SAP system that cannot be reached, or doesn’t answer in time, fails with the reason', async () => {
		// A port nothing listens on: taken, then let go.
		const free = await new Promise<number>((resolve) => {
			const probe = createServer().listen(0, '127.0.0.1', () => {
				const address = probe.address();
				probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
			});
		});
		await expect(sendToSap({ url: `http://127.0.0.1:${free}` }, inbound)).rejects.toThrow(
			/could not reach SAP at http:\/\/127\.0\.0\.1:\d+/
		);

		// Takes the connection and never answers.
		const silent = createServer(() => {}).listen(0, '127.0.0.1');
		servers.push(silent);
		await new Promise((resolve) => silent.once('listening', resolve));
		const address = silent.address();
		const port = typeof address === 'object' && address ? address.port : 0;
		await expect(
			sendToSap({ url: `http://127.0.0.1:${port}`, timeoutMs: 300 }, inbound)
		).rejects.toThrow('SAP did not answer within 0.3 s');
	});

	test('settings that would send the login or the IDocs unencrypted are refused', () => {
		const refused: [SapTarget, RegExp][] = [
			[{ url: 'http://s4dev.example.com' }, /must start with https:\/\//],
			[{ url: 'ftp://s4dev.example.com' }, /must start with https:\/\//],
			// oxlint-disable-next-line browser-security/no-password-in-url -- checks that such an address is refused
			[{ url: 'https://user:pw@s4dev.example.com' }, /not in the address/],
			[{ url: 'https://s4dev.example.com', tls: { cert: 'x' } }, /needs its key/],
			[{ url: 'https://s4dev.example.com', client: '1000' }, /three digits/],
			[{ url: 'https://s4dev.example.com', timeoutMs: Number.NaN }, /timeout/],
			[{ url: 'not an address' }, /not an address/]
		];
		for (const [target, message] of refused) expect(() => checkTarget(target)).toThrow(message);
		// Over http only to this computer: a local stand-in.
		expect(checkTarget({ url: 'http://127.0.0.1:8000/sap/bc' }).href).toBe(
			'http://127.0.0.1:8000/'
		);
	});

	test('an IDoc marked outbound is refused before anything is sent', async () => {
		const sap = await fakeSap();
		const outbound = parseIdocXml(sample('orders05.xml')).idocs[0];
		expect(() => asInbound(outbound)).toThrow(/outbound \(DIRECT 1\)/);
		await expect(sendToSap({ url: sap.url }, outbound)).rejects.toThrow(/DIRECT 1/);
		expect(sap.received).toEqual([]);
	});

	test('reading SAP’s answer: numbers only from a successful SOAP answer, any page counts by its status', () => {
		const ok = readSapAnswer(
			'soap',
			200,
			'<e:Envelope xmlns:e="http://schemas.xmlsoap.org/soap/envelope/"><e:Body><a:idocAssign xmlns:a="urn:x"><TransferId>1</TransferId><DbId>0000000000004711</DbId></a:idocAssign></e:Body></e:Envelope>'
		);
		expect(ok).toEqual({ ok: true, idocNumbers: ['0000000000004711'] });
		const page = readSapAnswer(
			'soap',
			500,
			'<html><body><h1>500 Internal Server Error</h1><p>Service cannot be reached</p></body></html>'
		);
		expect(page).toEqual({
			ok: false,
			idocNumbers: [],
			reason: '500 Internal Server Error Service cannot be reached'
		});
		// Status 200 but not the service: a logon page in front of it, or something that isn't SOAP.
		expect(
			readSapAnswer('soap', 200, '<!DOCTYPE html><html><body>Logon</body></html>')
		).toMatchObject({ ok: false, reason: expect.stringMatching(/^SAP answered with a web page/) });
		expect(readSapAnswer('xml', 200, '<html><body>Logon</body></html>').ok).toBe(false);
		expect(readSapAnswer('soap', 200, '<ok/>')).toMatchObject({
			ok: false,
			reason: expect.stringMatching(/without a SOAP envelope/)
		});
		expect(readSapAnswer('soap', 200, '')).toMatchObject({ ok: false });
		// An envelope without numbers still counts: SAP took the IDocs, the numbers are just not known.
		expect(
			readSapAnswer(
				'soap',
				200,
				'<e:Envelope xmlns:e="http://schemas.xmlsoap.org/soap/envelope/"><e:Body/></e:Envelope>'
			)
		).toEqual({ ok: true, idocNumbers: [] });
		expect(readSapAnswer('xml', 200, '')).toEqual({ ok: true, idocNumbers: [] });
		expect(readSapAnswer('xml', 403, '')).toEqual({
			ok: false,
			idocNumbers: [],
			reason: 'HTTP 403'
		});
	});

	test.describe('over TLS', () => {
		test.skip(!hasOpenssl(), 'needs openssl to make test certificates');

		test('trusts SAP’s certificate through the given CA, and logs on with a client certificate', async () => {
			const certs = makeTestCerts(test.info().outputPath('certs'));
			const sap = await fakeSap({
				tls: { cert: certs.serverCert, key: certs.serverKey, ca: certs.ca }
			});
			expect(sap.url).toMatch(/^https:/);

			const mutual = await sendToSap(
				{ url: sap.url, tls: { ca: certs.ca, cert: certs.clientCert, key: certs.clientKey } },
				inbound
			);
			expect(mutual.ok).toBe(true);
			// Without the client certificate the handshake fails; without the CA, SAP's certificate isn't trusted.
			await expect(sendToSap({ url: sap.url, tls: { ca: certs.ca } }, inbound)).rejects.toThrow(
				/could not reach SAP/
			);
			await expect(
				sendToSap({ url: sap.url, tls: { cert: certs.clientCert, key: certs.clientKey } }, inbound)
			).rejects.toThrow(/could not reach SAP/);
			expect(sap.received).toHaveLength(1);
		});
	});
});

async function control(r: RunningReceiver, method: string, path: string, body?: unknown) {
	const response = await fetch(`${r.controlUrl}${path}`, {
		method,
		headers: { 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	return { status: response.status, body: (await response.json()) as unknown };
}

const SentListSchema = z.array(SentIdocsSchema);

test.describe('the receiver’s POST /send', () => {
	test('sends IDoc-XML or IDocs into the SAP system set, and keeps each send with SAP’s answer', async () => {
		const sap = await fakeSap();
		const r = await receiver({ sap: { s4: { target: { url: sap.url, client: '100' } } } });

		const info = await control(r, 'GET', '/info');
		expect(info.body).toMatchObject({
			sap: [
				{
					system: 's4',
					title: 'S/4HANA',
					url: sap.url,
					client: '100',
					service: 'soap',
					login: 'none',
					standIn: false
				}
			]
		});

		const first = await control(r, 'POST', '/send', { xml: sample('orders05-inbound.xml') });
		expect(first.status).toBe(200);
		const sent = SentIdocsSchema.parse(first.body);
		expect(sent).toMatchObject({ seq: 1, by: 'person', to: 's4', result: { ok: true } });
		expect(sent.result.idocNumbers).toEqual(['0000000000000001']);

		sap.reply = { mode: 'reject', message: 'No partner profile' };
		const second = SentIdocsSchema.parse(
			(await control(r, 'POST', '/send', { idocs: [bare], by: 'test' })).body
		);
		expect(second).toMatchObject({
			seq: 2,
			by: 'test',
			result: { ok: false, status: 500, reason: 'No partner profile' }
		});
		expect(second.idocs[0].control.DIRECT).toBe('2');

		const all = await control(r, 'GET', '/sent');
		expect(SentListSchema.parse(all.body).map((entry) => entry.seq)).toEqual([1, 2]);
		expect(SentListSchema.parse((await control(r, 'GET', '/sent?after=1')).body)).toHaveLength(1);
		// Clearing the inbox leaves the sends; they have their own DELETE.
		await control(r, 'DELETE', '/idocs');
		expect((await control(r, 'GET', '/sent')).body).toHaveLength(2);
		await control(r, 'DELETE', '/sent');
		expect((await control(r, 'GET', '/sent')).body).toEqual([]);
	});

	test('what can’t be sent is refused and not recorded; SAP out of reach is recorded', async () => {
		const sap = await fakeSap();
		const r = await receiver({ sap: { s4: { target: { url: sap.url } } } });
		const refused = [
			{ xml: '<nothing/>' },
			{ xml: sample('orders05.xml') },
			{ xml: sample('orders05-inbound.xml'), idocs: [bare] },
			{}
		];
		for (const body of refused) expect((await control(r, 'POST', '/send', body)).status).toBe(400);
		expect((await control(r, 'GET', '/sent')).body).toEqual([]);
		expect(sap.received).toEqual([]);

		await sap.close();
		const away = SentIdocsSchema.parse((await control(r, 'POST', '/send', { idocs: [bare] })).body);
		expect(away.result).toMatchObject({ ok: false, status: 0 });
		expect(away.result.reason).toMatch(/could not reach SAP/);
	});

	test('a large send keeps characters that fall on a chunk boundary', async () => {
		const sap = await fakeSap();
		const r = await receiver({ sap: { s4: { target: { url: sap.url } } } });
		// Two bytes each in UTF-8, well beyond one chunk of the request. The single-byte x between the runs
		// shifts them by one byte, so some chunk boundary falls inside a character.
		const long = Array.from({ length: 40 }, () => 'äöüß'.repeat(1500)).join('x');
		const big = { ...bare, segments: [{ name: 'E1EDK01', fields: { BELNR: long }, children: [] }] };
		const sent = SentIdocsSchema.parse((await control(r, 'POST', '/send', { idocs: [big] })).body);
		expect(sent.result.ok).toBe(true);
		expect(sap.received[0].idoc.segments[0].fields.BELNR).toBe(long);
	});

	test('each SAP system has its own target, and a send goes where `to` says', async () => {
		const s4 = await fakeSap();
		const ewm = await fakeSap();
		const r = await receiver({
			sap: { s4: { target: { url: s4.url } }, ewm: { target: { url: ewm.url, client: '200' } } }
		});
		expect((await control(r, 'GET', '/info')).body).toMatchObject({
			sap: [
				{ system: 's4', url: s4.url },
				{ system: 'ewm', title: 'EWM', url: ewm.url, client: '200' }
			]
		});
		const intoEwm = SentIdocsSchema.parse(
			(await control(r, 'POST', '/send', { idocs: [bare], to: 'ewm' })).body
		);
		expect(intoEwm).toMatchObject({ to: 'ewm', result: { ok: true } });
		expect(ewm.received.map((i) => i.client)).toEqual(['200']);
		expect(s4.received).toEqual([]);
		expect((await control(r, 'POST', '/send', { idocs: [bare], to: 'bw' })).status).toBe(400);

		// A system that isn't set can't be sent to, even when another is.
		const onlyEwm = await receiver({ sap: { ewm: { target: { url: ewm.url } } } });
		const answer = await control(onlyEwm, 'POST', '/send', { idocs: [bare] });
		expect(answer.status).toBe(409);
		expect(answer.body).toEqual({ error: expect.stringContaining('IDOC_S4_URL') });
	});

	test('a stand-in’s answer can be set only for a system that has one', async () => {
		const sap = await fakeSap();
		const other = await fakeSap();
		const withFake = await receiver({
			sap: {
				s4: { target: { url: sap.url } },
				ewm: { target: { url: other.url }, standIn: other }
			}
		});
		expect((await control(withFake, 'GET', '/info')).body).toMatchObject({
			sap: [
				{ system: 's4', standIn: false },
				{ system: 'ewm', standIn: true }
			]
		});
		expect(
			(await control(withFake, 'PUT', '/fake-sap/ewm/reply', { mode: 'reject', status: 503 })).body
		).toEqual({ mode: 'reject', status: 503, message: 'Rejected by the stand-in for SAP' });
		expect(other.reply).toMatchObject({ mode: 'reject', status: 503 });
		expect(sap.reply).toEqual({ mode: 'accept' });

		expect((await control(withFake, 'PUT', '/fake-sap/s4/reply', { mode: 'accept' })).status).toBe(
			409
		);
		expect((await control(withFake, 'PUT', '/fake-sap/bw/reply', { mode: 'accept' })).status).toBe(
			404
		);
	});

	test('without an SAP system set, sending is refused', async () => {
		const r = await receiver({});
		const answer = await control(r, 'POST', '/send', { idocs: [bare] });
		expect(answer.status).toBe(409);
		expect(answer.body).toEqual({ error: expect.stringContaining('IDOC_S4_URL') });
		expect((await control(r, 'GET', '/info')).body).toMatchObject({ sap: [] });
	});

	test('with a login for SAP, the control API needs a token', async () => {
		const target = {
			url: 'https://s4dev.example.com',
			basicAuth: { user: 'CPI_IDOC', password: 'not-a-real-secret' }
		};
		await expect(startReceiver({ sap: { ewm: { target } } })).rejects.toThrow(
			/set a control token/
		);
		await expect(
			startReceiver({ sap: { s4: { target: { url: 'http://s4dev.example.com' } } } })
		).rejects.toThrow(/must start with https/);
		const r = await receiver({ sap: { ewm: { target } }, controlToken: 'test-token' });
		const info = await fetch(`${r.controlUrl}/info`, {
			headers: { authorization: 'Bearer test-token' }
		});
		const body = (await info.json()) as unknown;
		expect(body).toMatchObject({ sap: [{ system: 'ewm', login: 'user' }] });
		// Which login, never the login itself.
		expect(JSON.stringify(body)).not.toMatch(/CPI_IDOC|not-a-real-secret/);
	});
});
