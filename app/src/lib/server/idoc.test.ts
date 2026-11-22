/**
 * The app's side of the IDoc receiver: it starts the real receiver from sap-tests/idoc as its own process and
 * drives it only through the control API, like the page does. Samples stand in for SAP.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import type { IdocSnapshot } from '#lib/shared/idoc.js';
import { must } from '../../test/must.js';
import {
	clearInbox,
	idocStatus,
	idocTestEnv,
	listSamples,
	rawRequest,
	sendSample,
	setPartnerReply,
	startReceiver,
	stopReceiver,
	watchIdoc
} from './idoc.js';
import { importedPackages, missingPackages } from './mfs.js';
import { TESTS_ROOT } from './paths.js';

/** Reads the live view until a snapshot passes `check`. Leaving the loop closes the live view. */
async function waitFor(
	check: (snapshot: IdocSnapshot) => boolean,
	timeoutMs = 15_000
): Promise<IdocSnapshot> {
	const deadline = Date.now() + timeoutMs;
	for await (const snapshot of watchIdoc()) {
		if (check(snapshot)) return snapshot;
		if (Date.now() > deadline) break;
	}
	throw new Error('timed out waiting for the IDoc receiver');
}

const stopped = (s: IdocSnapshot) => !s.status.running;

// A developer's own receiver settings must not reach these tests: they start a plain one on this computer.
const SETTINGS = [
	'IDOC_HUB_URL',
	'IDOC_HUB_TOKEN',
	'IDOC_HOST',
	'IDOC_TLS_CERT',
	'IDOC_TLS_KEY',
	'IDOC_TLS_CA',
	'IDOC_TLS_CLIENT_FINGERPRINT',
	'IDOC_USER',
	'IDOC_PASSWORD'
];
const saved = new Map<string, string | undefined>();
beforeAll(() => {
	for (const name of SETTINGS) {
		saved.set(name, process.env[name]);
		delete process.env[name];
	}
	// A free port, so a receiver someone left running doesn't get in the way.
	saved.set('IDOC_PORT', process.env.IDOC_PORT);
	process.env.IDOC_PORT = '0';
});
afterAll(() => {
	for (const [name, value] of saved) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

afterEach(async () => {
	if (stopReceiver()) await waitFor(stopped);
});

describe('IDoc receiver', () => {
	test('its packages are installed by the setup', () => {
		expect(missingPackages(TESTS_ROOT, importedPackages(`${TESTS_ROOT}/idoc`))).toEqual([]);
	});

	test('lists the samples of sap-tests/idoc, described by their comment', () => {
		const samples = listSamples();
		expect(samples.map((s) => s.name)).toEqual([
			'orders05-soap.xml',
			'orders05.xml',
			'zpwmock01.xml'
		]);
		expect(samples.find((s) => s.name === 'orders05.xml')?.description).toBe(
			'Made-up order confirmation (ORDRSP) of type ORDERS05, as SAP would send it to the partner PWMOCK.'
		);
		// Without a leading comment, no description.
		expect(samples.find((s) => s.name === 'orders05-soap.xml')).toEqual({
			name: 'orders05-soap.xml'
		});
	});

	test('starts, keeps a sample IDoc, answers as set per partner, clears and stops', async () => {
		expect(idocTestEnv()).toEqual({});
		await startReceiver();
		expect(idocStatus()).toMatchObject({ running: true, external: false });

		const ready = await waitFor((s) => s.endpoint !== undefined);
		expect(ready.endpoint).toMatchObject({ https: false, login: 'none' });
		expect(ready.endpoint?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect(ready.canSendSamples).toBe(true);
		// Tests the app runs now reach this receiver, with its token.
		const env = idocTestEnv();
		expect(env.IDOC_HUB_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect(env.IDOC_HUB_TOKEN).toMatch(/^[0-9a-f]{48}$/);

		expect(await sendSample('orders05.xml', 'PWMOCK')).toEqual({
			status: 200,
			body: '1 IDoc(s) received'
		});
		const received = await waitFor((s) => s.idocs.length === 1);
		const idoc = must(received.idocs[0]);
		expect(idoc).toMatchObject({ partner: 'PWMOCK', accepted: true, root: 'ORDERS05' });
		expect(idoc.idoc.control.MESTYP).toBe('ORDRSP');
		expect((await rawRequest(idoc.seq)).text).toContain('<MESTYP>ORDRSP</MESTYP>');

		await setPartnerReply('PWMOCK', { mode: 'reject', status: 503, message: 'Partner down' });
		await waitFor((s) => s.replies.PWMOCK?.mode === 'reject');
		expect(await sendSample('zpwmock01.xml', 'PWMOCK')).toEqual({
			status: 503,
			reason: 'Partner down',
			body: 'Partner down'
		});
		// For SOAP, the reason comes from the fault.
		expect(await sendSample('orders05-soap.xml', 'PWMOCK')).toMatchObject({
			status: 503,
			reason: 'Partner down'
		});
		const rejected = await waitFor((s) => s.idocs.length === 4);
		expect(rejected.idocs.map((i) => i.accepted)).toEqual([true, false, false, false]);

		await setPartnerReply('PWMOCK', null);
		await waitFor((s) => s.replies.PWMOCK === undefined);

		await clearInbox();
		await waitFor((s) => s.idocs.length === 0);
		// Numbering goes on after clearing, and the live view picks up what comes next.
		await sendSample('orders05.xml', 'OTHER');
		const after = await waitFor((s) => s.idocs.length === 1);
		expect(after.idocs[0]).toMatchObject({ partner: 'OTHER', seq: 5 });

		await expect(startReceiver()).rejects.toThrow(/already running/);
		await expect(sendSample('../secret.xml', 'PWMOCK')).rejects.toThrow(/no sample/);
		await expect(sendSample('orders05.xml', 'bad name')).rejects.toThrow(/not a partner name/);

		expect(stopReceiver()).toBe(true);
		const end = await waitFor(stopped);
		expect(end.status.error).toBeUndefined();
		expect(idocTestEnv()).toEqual({});
		await expect(sendSample('orders05.xml', 'PWMOCK')).rejects.toThrow(/only be sent/);
	});

	test('a receiver that refuses its settings reports why', async () => {
		// Reachable from the network, but without HTTPS: the receiver refuses to start.
		process.env.IDOC_HOST = '0.0.0.0';
		try {
			await expect(startReceiver()).rejects.toThrow(/TLS certificate/);
			expect(idocStatus()).toMatchObject({ running: false });
			expect(idocStatus().error).toMatch(/TLS certificate/);
		} finally {
			delete process.env.IDOC_HOST;
		}
	});
});
