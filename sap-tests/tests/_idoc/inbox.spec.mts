// KI-generiert, geprüft von: <Name>
// The idocInbox fixture against the receiver Playwright starts for `bun run test:idoc` (IDOC_HUB_MOCK=1). The
// tests post IDocs to IDOC_MOCK_URL in SAP's place; a real test would trigger them in SAP instead. Skipped
// without a receiver.
import { readFileSync } from 'node:fs';
import { test, expect } from '../../sap-plugin/idoc';
import { findSegments } from '../../idoc/idoc.mts';

const sample = (name: string) =>
	readFileSync(new URL(`../../idoc/samples/${name}`, import.meta.url), 'utf8');

/** Posts IDoc-XML to the receiver as SAP's XML HTTP port would. */
function sapSends(partner: string, xml: string) {
	return fetch(`${process.env.IDOC_MOCK_URL}/idoc/${partner}`, {
		method: 'POST',
		headers: { 'content-type': 'text/xml' },
		body: xml
	});
}

// Only against the local receiver of `bun run test:idoc`: these tests post IDocs themselves and change replies,
// which they must not do on a receiver SAP really sends to.
test.skip(!process.env.IDOC_MOCK_URL, 'only with the local receiver (bun run test:idoc)');

// The tests share one receiver, and the last ones check what earlier ones left behind.
test.describe.configure({ mode: 'serial' });

test('waitFor finds the IDoc a step produced', async ({ idocInbox }) => {
	expect((await sapSends('PWMOCK', sample('orders05.xml'))).status).toBe(200);

	const { idoc, partner, accepted } = await idocInbox.waitFor({
		partner: 'PWMOCK',
		messageType: 'ORDRSP'
	});
	expect(partner).toBe('PWMOCK');
	expect(accepted).toBe(true);
	expect(findSegments(idoc, 'E1EDK01')[0].fields.BELNR).toBe('0000012345');
});

test('waitFor narrows by any condition on the IDoc', async ({ idocInbox }) => {
	await sapSends('PWMOCK', sample('zpwmock01.xml'));
	const second = await idocInbox.waitFor({
		idocType: 'ZPWMOCK01',
		where: ({ idoc }) => findSegments(idoc, 'Z1PWHDR')[0]?.fields.MOCKID === 'RUN-0043'
	});
	expect(second.idoc.control.DOCNUM).toBe('0000000000000002');
	expect(await idocInbox.received({ idocType: 'ZPWMOCK01' })).toHaveLength(2);
});

test('only IDocs received during the test count', async ({ idocInbox }) => {
	// The earlier tests' IDocs are still in the receiver.
	expect(await idocInbox.received()).toEqual([]);
	await expect(idocInbox.waitFor({ partner: 'PWMOCK' }, { timeout: 1500 })).rejects.toThrow(
		/No IDoc \(for PWMOCK\) arrived within 1.5 s\. Received since the test started: none/
	);
});

test('waitFor fails with what did arrive instead', async ({ idocInbox }) => {
	await sapSends('OTHER', sample('orders05.xml'));
	await expect(idocInbox.waitFor({ partner: 'PWMOCK' }, { timeout: 1500 })).rejects.toThrow(
		/Received since the test started: #\d+ ORDERS05\/ORDRSP for OTHER/
	);
});

test('a reply set in a test makes SAP see an error, until the test ends', async ({ idocInbox }) => {
	await idocInbox.reply('PWMOCK', { mode: 'reject', status: 503, message: 'Partner down' });
	const response = await sapSends('PWMOCK', sample('orders05.xml'));
	expect(response.status).toBe(503);
	expect(await response.text()).toBe('Partner down');
	expect((await idocInbox.waitFor({ partner: 'PWMOCK' })).accepted).toBe(false);
});

test('the reply is back to accept in the next test', async ({ idocInbox }) => {
	expect((await sapSends('PWMOCK', sample('orders05.xml'))).status).toBe(200);
	expect((await idocInbox.waitFor({ partner: 'PWMOCK' })).accepted).toBe(true);
});

/** The control API directly, as another run or a person would use it. */
function controlElsewhere(method: 'GET' | 'PUT' | 'DELETE', path: string, body?: unknown) {
	const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
	if (body !== undefined) init.body = JSON.stringify(body);
	return fetch(`${process.env.IDOC_HUB_URL}${path}`, init);
}

test('a reply set by someone else before the test is changed during it', async ({ idocInbox }) => {
	await controlElsewhere('PUT', '/replies/SHARED', {
		mode: 'reject',
		status: 502,
		message: 'Set elsewhere'
	});
	await idocInbox.reply('SHARED', { mode: 'slow', delayMs: 10 });
	expect((await sapSends('SHARED', sample('orders05.xml'))).status).toBe(200);
});

test('and is back after the test, instead of accept', async () => {
	const response = await controlElsewhere('GET', '/replies/SHARED');
	expect(await response.json()).toEqual({ mode: 'reject', status: 502, message: 'Set elsewhere' });
	await controlElsewhere('DELETE', '/replies/SHARED');
});
