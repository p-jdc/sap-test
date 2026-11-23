// KI-generiert, geprüft von: <Name>
// The OData mock (odata/mock/mock.mts) on its own: each test starts a mock in this process, calls its OData
// endpoint the way a client would and checks what the control API reports. No browser, no SAP system. These test
// the mock itself, so they build their requests by hand; API tests of SAP services use the typed clients.
import { test, expect } from '../../sap-plugin';
import { z } from 'zod';
import {
	LoggedRequestSchema,
	RequestSummarySchema,
	startOdataMock,
	type OdataMockOptions,
	type RunningOdataMock
} from '../../odata/mock/mock.mts';

const SERVICE = 'GWSAMPLE_BASIC';
const BASE = '/sap/opu/odata/IWBEP/GWSAMPLE_BASIC';
const SALES_ORDER_BASE = '/sap/opu/odata/sap/API_SALES_ORDER_SRV';
const DELIVERY_BASE = '/sap/opu/odata/sap/API_OUTBOUND_DELIVERY_SRV;v=0002';

let running: RunningOdataMock[] = [];
async function mock(options: OdataMockOptions = {}) {
	const started = await startOdataMock({ port: 0, ...options });
	running.push(started);
	return started;
}
test.afterEach(async () => {
	await Promise.all(running.map((m) => m.close()));
	running = [];
});

const odata = (m: RunningOdataMock, path: string, init?: RequestInit) =>
	fetch(`${m.odataUrl}${BASE}${path}`, init);

async function control(
	m: RunningOdataMock,
	method: string,
	path: string,
	body?: unknown,
	headers: Record<string, string> = {}
) {
	const response = await fetch(`${m.controlUrl}${path}`, {
		method,
		headers: { 'content-type': 'application/json', ...headers },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	return { status: response.status, body: JSON.parse(await response.text()) as unknown };
}

const ListSchema = z.object({
	instance: z.string(),
	cursor: z.number(),
	oldest: z.number().nullable(),
	requests: z.array(RequestSummarySchema.strict())
});

async function logged(m: RunningOdataMock, query = '') {
	const { status, body } = await control(m, 'GET', `/requests${query}`);
	expect(status).toBe(200);
	return ListSchema.parse(body);
}

const newProduct = (id: string) => ({
	ProductID: id,
	TypeCode: 'PR',
	Category: 'Notebooks',
	Name: 'Mock test product',
	SupplierID: '0100000000',
	TaxTarifCode: 1,
	MeasureUnit: 'EA',
	CurrencyCode: 'EUR',
	Price: '9.99'
});

test('serves the configured services and says where', async () => {
	const m = await mock();
	const { status, body } = await control(m, 'GET', '/info');
	expect(status).toBe(200);
	expect(body).toMatchObject({
		odataUrl: m.odataUrl,
		services: [
			{ name: SERVICE, basePath: BASE },
			{ name: 'API_SALES_ORDER_SRV', basePath: SALES_ORDER_BASE },
			{ name: 'API_OUTBOUND_DELIVERY_SRV', basePath: DELIVERY_BASE }
		]
	});
	const response = await odata(m, '/ProductSet?$format=json');
	expect(response.status).toBe(200);
});

test('logs each request with its service, status and bodies; the list leaves the bodies out', async () => {
	const m = await mock();
	const read = await odata(m, "/ProductSet('MK-1000')?$format=json");
	expect(read.status).toBe(200);
	const created = await odata(m, '/ProductSet', {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify(newProduct('MKLOG'))
	});
	expect(created.status).toBe(201);
	await fetch(`${m.odataUrl}/nothing/here`);

	const { requests, cursor } = await logged(m);
	expect(requests.map((r) => [r.method, r.service, r.status, r.answer])).toEqual([
		['GET', SERVICE, 200, 'normal'],
		['POST', SERVICE, 201, 'normal'],
		['GET', null, 404, 'normal']
	]);
	expect(requests[0]?.url).toBe(`${BASE}/ProductSet('MK-1000')?$format=json`);
	expect(cursor).toBe(requests.at(-1)?.seq);

	const post = requests[1];
	const { body } = await control(m, 'GET', `/requests/${post?.seq}`);
	const full = LoggedRequestSchema.parse(body);
	expect(JSON.parse(full.requestBody ?? '{}')).toMatchObject({ ProductID: 'MKLOG' });
	expect(full.requestType).toBe('application/json');
	expect(full.responseBody).toContain('MKLOG');

	// Only newer ones with `after`; with `limit`, the newest of them. `oldest` is the oldest still held.
	expect((await logged(m, `?after=${post?.seq}`)).requests).toHaveLength(1);
	const newest = await logged(m, '?limit=1');
	expect(newest.requests.map((r) => r.seq)).toEqual([3]);
	expect(newest.oldest).toBe(1);
	// Cleared, the numbering goes on.
	expect((await control(m, 'DELETE', '/requests')).status).toBe(200);
	expect(await logged(m)).toMatchObject({ requests: [], oldest: null, cursor: 3 });
	await odata(m, '/ProductSet/$count');
	expect((await logged(m)).requests[0]?.seq).toBe(4);
});

test('a $batch request is logged with what it carried', async () => {
	const m = await mock();
	const boundary = 'batch_mock';
	const body = [
		`--${boundary}`,
		'Content-Type: application/http',
		'Content-Transfer-Encoding: binary',
		'',
		'GET ProductSet?$top=1 HTTP/1.1',
		'Accept: application/json',
		'',
		'',
		`--${boundary}--`,
		''
	].join('\r\n');
	const response = await odata(m, '/$batch', {
		method: 'POST',
		headers: { 'content-type': `multipart/mixed; boundary=${boundary}` },
		body
	});
	expect(response.status).toBe(200);
	const [entry] = (await logged(m)).requests;
	const { body: full } = await control(m, 'GET', `/requests/${entry?.seq}`);
	const logEntry = LoggedRequestSchema.parse(full);
	expect(logEntry.requestBody).toContain('GET ProductSet?$top=1');
	expect(logEntry.responseBody).toContain('MK-1000');
});

test('fails a service as set, in SAP Gateway form, until set back', async () => {
	const m = await mock();
	const set = await control(m, 'PUT', `/answers/${SERVICE}`, {
		mode: 'fail',
		status: 503,
		message: 'Backend down'
	});
	expect(set.status).toBe(200);
	expect((await control(m, 'GET', '/answers')).body).toEqual({
		[SERVICE]: { mode: 'fail', status: 503, message: 'Backend down' }
	});

	const response = await odata(m, '/ProductSet?$format=json');
	expect(response.status).toBe(503);
	expect(await response.json()).toMatchObject({
		error: { message: { lang: 'en', value: 'Backend down' } }
	});
	expect((await logged(m)).requests[0]).toMatchObject({ status: 503, answer: 'fail' });

	expect((await control(m, 'DELETE', `/answers/${SERVICE}`)).status).toBe(200);
	expect((await odata(m, '/ProductSet?$format=json')).status).toBe(200);
	expect((await control(m, 'GET', '/answers')).body).toEqual({});
});

test('answers late as set', async () => {
	const m = await mock();
	await control(m, 'PUT', `/answers/${SERVICE}`, { mode: 'slow', delayMs: 400 });
	const started = Date.now();
	const response = await odata(m, '/ProductSet/$count');
	expect(response.status).toBe(200);
	expect(Date.now() - started).toBeGreaterThanOrEqual(400);
	const [entry] = (await logged(m)).requests;
	expect(entry).toMatchObject({ status: 200, answer: 'slow' });
	expect(entry?.durationMs).toBeGreaterThanOrEqual(400);
});

test('refuses answers it cannot give, and services it does not serve', async () => {
	const m = await mock();
	expect(
		(await control(m, 'PUT', `/answers/${SERVICE}`, { mode: 'fail', status: 200, message: 'x' }))
			.status
	).toBe(400);
	expect(
		(await control(m, 'PUT', '/answers/NO_SUCH_SRV', { mode: 'slow', delayMs: 10 })).status
	).toBe(404);
	expect((await control(m, 'GET', '/services/NO_SUCH_SRV/sets')).status).toBe(404);
});

test('shows the entity sets and their data, and its own reads stay out of the log', async () => {
	const m = await mock();
	const sets = z
		.array(z.object({ name: z.string(), count: z.number() }))
		.parse((await control(m, 'GET', `/services/${SERVICE}/sets`)).body);
	expect(sets).toContainEqual({ name: 'ProductSet', count: 3 });

	const { body } = await control(m, 'GET', `/services/${SERVICE}/sets/ProductSet?top=2`);
	const page = z
		.object({ count: z.number(), rows: z.array(z.record(z.string(), z.unknown())) })
		.parse(body);
	expect(page.count).toBe(3);
	expect(page.rows).toHaveLength(2);
	expect(page.rows[0]).toMatchObject({ ProductID: 'MK-1000' });
	// Without OData's own fields and the navigation properties it didn't expand.
	expect(page.rows[0]).not.toHaveProperty('__metadata');
	expect(page.rows[0]).not.toHaveProperty('ToSupplier');

	// Even with a failing answer set: the page still sees the data.
	await control(m, 'PUT', `/answers/${SERVICE}`, { mode: 'fail', status: 500, message: 'down' });
	expect((await control(m, 'GET', `/services/${SERVICE}/sets/ProductSet`)).status).toBe(200);
	expect((await logged(m)).requests).toEqual([]);
});

test('a reset brings back the data of the files, and keeps log and answers', async () => {
	const m = await mock();
	const count = async () => Number(await (await odata(m, '/ProductSet/$count')).text());
	await odata(m, '/ProductSet', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(newProduct('MKRESET'))
	});
	expect(await count()).toBe(4);
	await control(m, 'PUT', `/answers/${SERVICE}`, { mode: 'slow', delayMs: 1 });

	expect((await control(m, 'POST', '/reset')).status).toBe(200);
	expect(await count()).toBe(3);
	expect((await logged(m)).requests).toHaveLength(3);
	expect((await control(m, 'GET', '/answers')).body).toEqual({
		[SERVICE]: { mode: 'slow', delayMs: 1 }
	});
});

test('the control API needs its token, and JSON for changes', async () => {
	const m = await mock({ controlToken: 'secret-token' });
	expect((await control(m, 'GET', '/health')).status).toBe(200);
	expect((await control(m, 'GET', '/requests')).status).toBe(401);
	expect(
		(await control(m, 'GET', '/requests', undefined, { authorization: 'Bearer secret-token' }))
			.status
	).toBe(200);
	const form = await fetch(`${m.controlUrl}/reset`, {
		method: 'POST',
		headers: { authorization: 'Bearer secret-token', 'content-type': 'text/plain' },
		body: 'x'
	});
	expect(form.status).toBe(415);
});

test('listens only on this computer: it has no login', async () => {
	await expect(startOdataMock({ port: 0, host: '0.0.0.0' })).rejects.toThrow(
		/only listens on this computer/
	);
	await expect(startOdataMock({ port: 0, controlHost: '192.168.1.5' })).rejects.toThrow(
		/only listens on this computer/
	);
});

test('sales orders: a new one gets a number, its deep-inserted parts land in their own sets and go with it', async () => {
	const m = await mock();
	const salesOrder = (path: string, init?: RequestInit) =>
		fetch(`${m.odataUrl}${SALES_ORDER_BASE}${path}`, init);
	const count = async (set: string) => Number(await (await salesOrder(`/${set}/$count`)).text());
	const create = () =>
		salesOrder('/A_SalesOrder', {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify({
				SalesOrderType: 'OR',
				SoldToParty: '10100001',
				to_Partner: { results: [{ PartnerFunction: 'WE', Customer: '10100001' }] },
				to_Item: {
					results: [
						{
							SalesOrderItem: '10',
							Material: 'TG11',
							RequestedQuantity: '3',
							to_ScheduleLine: { results: [{ ScheduleLineOrderQuantity: '3' }] }
						}
					]
				}
			})
		});
	const NumberSchema = z.object({ d: z.object({ SalesOrder: z.string() }) });

	const created = await create();
	expect(created.status).toBe(201);
	const { SalesOrder: number } = NumberSchema.parse(await created.json()).d;
	// One above the highest number in A_SalesOrder.json, as a number range would give it.
	expect(number).toBe('1000003');

	const read = await salesOrder(
		`/A_SalesOrder('${number}')?$expand=to_Item/to_ScheduleLine,to_Partner&$format=json`
	);
	const order = z
		.object({
			d: z.object({
				to_Item: z.object({
					results: z.array(
						z.object({
							SalesOrder: z.string(),
							SalesOrderItem: z.string(),
							to_ScheduleLine: z.object({
								results: z.array(z.object({ SalesOrder: z.string(), ScheduleLine: z.string() }))
							})
						})
					)
				}),
				to_Partner: z.object({
					results: z.array(z.object({ SalesOrder: z.string(), PartnerFunction: z.string() }))
				})
			})
		})
		.parse(await read.json()).d;
	expect(order.to_Item.results).toMatchObject([{ SalesOrder: number, SalesOrderItem: '10' }]);
	expect(order.to_Item.results[0].to_ScheduleLine.results).toEqual([
		expect.objectContaining({ SalesOrder: number, ScheduleLine: '1' })
	]);
	expect(order.to_Partner.results).toEqual([
		expect.objectContaining({ SalesOrder: number, PartnerFunction: 'WE' })
	]);
	expect(await count('A_SalesOrderItem')).toBe(4);

	// As on S/4HANA, which keeps an ETag on the order: no delete without If-Match.
	expect((await salesOrder(`/A_SalesOrder('${number}')`, { method: 'DELETE' })).status).toBe(428);
	expect(
		(
			await salesOrder(`/A_SalesOrder('${number}')`, {
				method: 'DELETE',
				headers: { 'if-match': '*' }
			})
		).status
	).toBe(204);
	expect(await count('A_SalesOrder')).toBe(2);
	expect(await count('A_SalesOrderItem')).toBe(3);
	expect(await count('A_SalesOrderScheduleLine')).toBe(3);
	expect(await count('A_SalesOrderHeaderPartner')).toBe(4);

	// A reset brings back the data of the files, and with it the numbers.
	expect(NumberSchema.parse(await (await create()).json()).d.SalesOrder).toBe('1000003');
	expect(NumberSchema.parse(await (await create()).json()).d.SalesOrder).toBe('1000004');
	expect((await control(m, 'POST', '/reset')).status).toBe(200);
	expect(NumberSchema.parse(await (await create()).json()).d.SalesOrder).toBe('1000003');
});

test('deliveries: refused as S/4HANA refuses them, and the order follows the delivery', async () => {
	const m = await mock();
	const call = (
		base: string,
		path: string,
		init: RequestInit & { json?: boolean; ifMatch?: boolean } = {}
	) =>
		fetch(`${m.odataUrl}${base}${path}`, {
			...init,
			headers: {
				accept: 'application/json',
				...(init.json ? { 'content-type': 'application/json' } : {}),
				...(init.ifMatch ? { 'if-match': '*' } : {})
			}
		});
	const status = async (path: string) =>
		z
			.object({ d: z.record(z.string(), z.unknown()) })
			.parse(await (await call(SALES_ORDER_BASE, `${path}?$format=json`)).json()).d;
	const deliver = (order: string, item: string) =>
		call(DELIVERY_BASE, '/A_OutbDeliveryHeader', {
			method: 'POST',
			json: true,
			body: JSON.stringify({
				to_DeliveryDocumentItem: {
					results: [{ ReferenceSDDocument: order, ReferenceSDDocumentItem: item }]
				}
			})
		});
	const deliveries = async () =>
		Number(await (await call(DELIVERY_BASE, '/A_OutbDeliveryHeader/$count')).text());

	// A reference to an order item that does not exist, or is delivered already: nothing is stored.
	expect((await deliver('9999999', '10')).status).toBe(400);
	expect((await deliver('1000002', '10')).status).toBe(400);
	expect(await deliveries()).toBe(1);

	const created = await deliver('1000001', '10');
	expect(created.status).toBe(201);
	const { DeliveryDocument: delivery } = z
		.object({ d: z.object({ DeliveryDocument: z.string() }) })
		.parse(await created.json()).d;
	// The refused ones took no number.
	expect(delivery).toBe('80000002');
	// One of two items delivered: partly.
	expect((await status("/A_SalesOrder('1000001')")).OverallDeliveryStatus).toBe('B');
	expect(
		(await status("/A_SalesOrderItem(SalesOrder='1000001',SalesOrderItem='10')")).DeliveryStatus
	).toBe('C');

	const action = (name: string, ifMatch = true) =>
		call(DELIVERY_BASE, `/${name}?DeliveryDocument='${delivery}'`, { method: 'POST', ifMatch });
	// As on S/4HANA, which keeps an ETag on the delivery: no action and no delete without If-Match.
	expect((await action('PickAllItems', false)).status).toBe(428);
	expect(
		(await call(DELIVERY_BASE, `/A_OutbDeliveryHeader('${delivery}')`, { method: 'DELETE' })).status
	).toBe(428);
	expect((await action('PostGoodsIssue')).status).toBe(400);
	expect((await action('PickAllItems')).status).toBe(200);
	expect((await action('PostGoodsIssue')).status).toBe(200);
	expect((await action('PostGoodsIssue')).status).toBe(400);
	expect((await action('PickOneItem')).status).toBe(501);

	// An order with a delivery stays; a delivery with goods issue stays.
	const remove = (base: string, path: string) =>
		call(base, path, { method: 'DELETE', ifMatch: true });
	expect((await remove(SALES_ORDER_BASE, "/A_SalesOrder('1000001')")).status).toBe(400);
	expect((await remove(DELIVERY_BASE, `/A_OutbDeliveryHeader('${delivery}')`)).status).toBe(400);

	expect((await action('ReverseGoodsIssue')).status).toBe(200);
	expect((await remove(DELIVERY_BASE, `/A_OutbDeliveryHeader('${delivery}')`)).status).toBe(204);
	expect(Number(await (await call(DELIVERY_BASE, '/A_OutbDeliveryItem/$count')).text())).toBe(1);
	expect((await status("/A_SalesOrder('1000001')")).OverallDeliveryStatus).toBe('A');
});

test('a write without a body is answered, not crashed, and logged as it was sent', async () => {
	const m = await mock();
	const response = await odata(m, '/ProductSet', { method: 'POST' });
	expect(response.status).toBeLessThan(500);
	const [entry] = (await logged(m)).requests;
	expect(entry).toMatchObject({ method: 'POST', status: response.status });
	expect(entry).not.toHaveProperty('requestType');
});
