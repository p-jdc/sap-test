// KI-generiert, geprüft von: <Name>
// The idocSender fixture against the receiver Playwright starts for `bun run test:idoc` (IDOC_HUB_MOCK=1), which
// sends into a stand-in for SAP (IDOC_FAKE_SAP). A real test would then check the IDoc in SAP (WE02, status 53)
// and the document made from it. Skipped without a receiver.
import { readFileSync } from 'node:fs';
import { test, expect } from '../../sap-plugin/idoc';
import { parseIdocXml } from '../../idoc/xml.mts';

const order = readFileSync(
	new URL('../../idoc/samples/orders05-inbound.xml', import.meta.url),
	'utf8'
);

test.skip(!process.env.IDOC_MOCK_URL, 'only with the local receiver (bun run test:idoc)');

test('send takes IDoc-XML and returns the numbers SAP gave the IDocs', async ({ idocSender }) => {
	const { result, by, idocs } = await idocSender.send(order);
	expect(result.ok).toBe(true);
	expect(result.idocNumbers).toHaveLength(1);
	expect(result.idocNumbers[0]).toMatch(/^\d{16}$/);
	expect(by).toBe('test');
	expect(idocs[0].control.MESTYP).toBe('ORDERS');
});

test('send takes IDocs built in the test, several of one type at once', async ({ idocSender }) => {
	const [idoc] = parseIdocXml(order).idocs;
	const second = { ...idoc, control: { ...idoc.control, MESCOD: 'B' } };
	const { result } = await idocSender.send([idoc, second]);
	expect(result.idocNumbers).toHaveLength(2);
});

/** How the stand-in for SAP in the receiver answers. */
const setFakeSapReply = (reply: unknown) =>
	fetch(`${process.env.IDOC_HUB_URL}/fake-sap/reply`, {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(reply)
	});

test('with expectOk: false, SAP’s refusal comes back instead of failing the step', async ({
	idocSender
}) => {
	expect((await setFakeSapReply({ mode: 'reject', message: 'No partner profile' })).status).toBe(
		200
	);
	try {
		const { result } = await idocSender.send(order, { expectOk: false });
		expect(result).toMatchObject({ ok: false, status: 500, reason: 'No partner profile' });
		await expect(idocSender.send(order)).rejects.toThrow(
			'SAP did not take the IDocs (HTTP 500): No partner profile'
		);
	} finally {
		await setFakeSapReply({ mode: 'accept' });
	}
});

test('an IDoc marked outbound is refused before anything is sent', async ({ idocSender }) => {
	const outbound = readFileSync(
		new URL('../../idoc/samples/orders05.xml', import.meta.url),
		'utf8'
	);
	await expect(idocSender.send(outbound)).rejects.toThrow(/DIRECT 1/);
});
