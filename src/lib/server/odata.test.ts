/**
 * The app's side of the OData mock: it starts the real mock from sap-tests/odata/mock as its own process and
 * drives it only through the control API, like the page does. Plain fetch calls stand in for tests and apps.
 */
import { afterEach, describe, expect, test } from 'vitest';
import type { OdataSnapshot } from '#lib/shared/odata.js';
import { must } from '../../test/must.js';
import {
	clearOdataRequests,
	odataEntitySets,
	odataMockPid,
	odataRequest,
	odataRows,
	odataStatus,
	odataTestEnv,
	odataTestProblem,
	resetOdataData,
	setOdataAnswer,
	startOdataMock,
	stopOdataMock,
	useOdataMockForTests,
	watchOdata
} from './odata.js';
import { importedPackages, missingPackages } from './mfs.js';
import { PACKAGES_DIR, TESTS_ROOT } from './paths.js';

const SERVICE = 'GWSAMPLE_BASIC';
const BASE = '/sap/opu/odata/IWBEP/GWSAMPLE_BASIC';

/** Reads the live view until a snapshot passes `check`. Leaving the loop closes the live view. */
async function waitFor(
	check: (snapshot: OdataSnapshot) => boolean,
	timeoutMs = 15_000
): Promise<OdataSnapshot> {
	const deadline = Date.now() + timeoutMs;
	for await (const snapshot of watchOdata()) {
		if (check(snapshot)) return snapshot;
		if (Date.now() > deadline) break;
	}
	throw new Error('timed out waiting for the OData mock');
}

const stopped = (s: OdataSnapshot) => !s.status.running;
const failing = (s: OdataSnapshot) => s.answers[SERVICE]?.mode === 'fail';
const loggedAsFailed = (s: OdataSnapshot) =>
	s.requests.some((r) => r.answer === 'fail' && r.status === 503);

afterEach(async () => {
	if (stopOdataMock()) await waitFor(stopped);
});

/** The address the mock serves at, from the live view. */
async function started(): Promise<string> {
	await startOdataMock();
	const snapshot = await waitFor((s) => s.status.running && s.odataUrl !== undefined);
	return snapshot.odataUrl ?? '';
}

describe('OData mock', () => {
	test('its packages are installed by the setup', () => {
		expect(
			missingPackages(PACKAGES_DIR, [
				...importedPackages(`${TESTS_ROOT}/odata/mock`),
				'@sap-ux/fe-mockserver-core'
			])
		).toEqual([]);
	});

	test('starts, lists its services and the requests it answers, and stops', async () => {
		expect(odataStatus().running).toBe(false);
		const url = await started();
		expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		await expect(startOdataMock()).rejects.toThrow('already running');

		const response = await fetch(`${url}${BASE}/ProductSet?$format=json`);
		expect(response.status).toBe(200);
		const snapshot = await waitFor((s) => s.requests.length === 1);
		expect(snapshot.services).toEqual([
			{ name: SERVICE, basePath: BASE },
			{ name: 'API_SALES_ORDER_SRV', basePath: '/sap/opu/odata/sap/API_SALES_ORDER_SRV' },
			{
				name: 'API_OUTBOUND_DELIVERY_SRV',
				basePath: '/sap/opu/odata/sap/API_OUTBOUND_DELIVERY_SRV;v=0002'
			}
		]);
		const request = must(snapshot.requests[0]);
		expect(request).toMatchObject({
			method: 'GET',
			service: SERVICE,
			status: 200,
			answer: 'normal'
		});
		expect((await odataRequest(request.seq)).responseBody).toContain('MK-1000');

		await clearOdataRequests();
		await waitFor((s) => s.requests.length === 0);

		expect(stopOdataMock()).toBe(true);
		await waitFor(stopped);
		// Stopped from here, not unexpectedly: no error to show.
		expect(odataStatus()).toEqual({ running: false, error: undefined });
	});

	test('the API tests the app starts call the mock only while the page says so', async () => {
		expect(odataTestEnv()).toEqual({});
		expect(() => {
			useOdataMockForTests(true);
		}).toThrow('not running');
		const url = await started();
		expect(odataTestEnv()).toEqual({});

		useOdataMockForTests(true);
		expect(odataTestEnv()).toEqual({
			SAP_API_URL: url,
			SAP_API_USERNAME: 'mock',
			SAP_API_PASSWORD: 'mock',
			SAP_CLIENT: ''
		});
		expect((await waitFor((s) => s.forTests)).forTests).toBe(true);
		useOdataMockForTests(false);
		expect(odataTestEnv()).toEqual({});

		// Stopped, tests go back to the system in the settings, and a new start doesn't remember the choice.
		useOdataMockForTests(true);
		stopOdataMock();
		await waitFor(stopped);
		expect(odataTestEnv()).toEqual({});
		expect(odataTestProblem()).toBeUndefined();
		await started();
		expect(odataTestEnv()).toEqual({});
	});

	test('a mock that stops unexpectedly while the API tests call it keeps runs from starting', async () => {
		await started();
		useOdataMockForTests(true);
		process.kill(must(odataMockPid()), 'SIGKILL');
		const snapshot = await waitFor(stopped);
		expect(snapshot.status.error).toContain('no run starts');
		// The tests would otherwise call the SAP system in the settings.
		expect(odataTestEnv()).toEqual({});
		expect(odataTestProblem()).toContain('Start the mock again');

		await started();
		expect(odataTestProblem()).toBeUndefined();
	});

	test('fails a service as set, until set back', async () => {
		const url = await started();
		await setOdataAnswer(SERVICE, { mode: 'fail', status: 503, message: 'Backend down' });
		await waitFor(failing);
		expect((await fetch(`${url}${BASE}/ProductSet`)).status).toBe(503);
		await waitFor(loggedAsFailed);

		await setOdataAnswer(SERVICE, null);
		await waitFor((s) => Object.keys(s.answers).length === 0);
		expect((await fetch(`${url}${BASE}/ProductSet`)).status).toBe(200);
	});

	test('shows the data, and a reset brings back the files', async () => {
		const url = await started();
		expect(await odataEntitySets(SERVICE)).toContainEqual({ name: 'ProductSet', count: 3 });
		const created = await fetch(`${url}${BASE}/ProductSet`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				ProductID: 'MKAPP',
				TypeCode: 'PR',
				Category: 'Notebooks',
				Name: 'From the app test',
				SupplierID: '0100000000',
				TaxTarifCode: 1,
				MeasureUnit: 'EA',
				CurrencyCode: 'EUR',
				Price: '1.00'
			})
		});
		expect(created.status).toBe(201);
		const page = await odataRows(SERVICE, 'ProductSet', 10);
		expect(page.count).toBe(4);
		expect(page.rows.map((row) => row.ProductID)).toContain('MKAPP');

		await resetOdataData();
		expect((await odataRows(SERVICE, 'ProductSet', 10)).count).toBe(3);
	});

	test('reports what it cannot do while stopped', async () => {
		await expect(odataEntitySets(SERVICE)).rejects.toThrow('not running');
		await expect(setOdataAnswer(SERVICE, null)).rejects.toThrow('not running');
	});
});
