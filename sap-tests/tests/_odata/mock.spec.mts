// KI-generiert, geprüft von: <Name>
// The OData mock (odata/mock/mock.mts) on its own: each test starts a mock in this process, calls its OData
// endpoint the way a client would and checks what the control API reports. No browser, no SAP system. These test
// the mock itself, so they build their requests by hand; API tests of SAP services use the typed clients.
import { test, expect } from '../../sap-plugin';
import { z } from 'zod';
import {
	loggedHeaders,
	LoggedRequestSchema,
	RequestSummarySchema,
	startOdataMock,
	type OdataMockOptions,
	type RunningOdataMock
} from '../../odata/mock/mock.mts';

const SERVICE = 'GWSAMPLE_BASIC';
const BASE = '/sap/opu/odata/IWBEP/GWSAMPLE_BASIC';

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
		services: [{ name: SERVICE, basePath: BASE }]
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

test('fails only the share of requests set, and says when to try again', async () => {
	// The mock draws one number per request: below 0.5 fails at a rate of 50 %, from 0.5 on it doesn't.
	let draws = 0;
	const m = await mock({ random: () => (draws++ % 2 === 0 ? 0.1 : 0.7) });
	await control(m, 'PUT', `/answers/${SERVICE}`, {
		mode: 'fail',
		status: 429,
		message: 'Too many requests',
		rate: 50,
		retryAfterSeconds: 30
	});

	const first = await odata(m, '/ProductSet/$count');
	expect(first.status).toBe(429);
	expect(first.headers.get('retry-after')).toBe('30');
	const second = await odata(m, '/ProductSet/$count');
	expect(second.status).toBe(200);
	expect(second.headers.get('retry-after')).toBeNull();

	const { requests } = await logged(m);
	expect(requests.map((r) => [r.status, r.answer])).toEqual([
		[429, 'fail'],
		[200, 'normal']
	]);
	const { body } = await control(m, 'GET', `/requests/${requests[0]?.seq}`);
	expect(LoggedRequestSchema.parse(body).responseHeaders).toMatchObject({ 'retry-after': '30' });
});

test('answers late at random, within the range set', async () => {
	// The highest draw gives the longest delay: 100 ms plus all of the 400 ms range.
	const m = await mock({ random: () => 0.999 });
	await control(m, 'PUT', `/answers/${SERVICE}`, { mode: 'slow', delayMs: 100, maxDelayMs: 500 });
	expect((await control(m, 'GET', '/answers')).body).toEqual({
		[SERVICE]: { mode: 'slow', delayMs: 100, maxDelayMs: 500 }
	});
	const started = Date.now();
	expect((await odata(m, '/ProductSet/$count')).status).toBe(200);
	expect(Date.now() - started).toBeGreaterThanOrEqual(500);
});

test('keeps the headers sent and answered, without logins, cookies or tokens', async () => {
	const m = await mock();
	const secrets = ['c2VjcmV0OnBhc3M=', 's3cr3t-session', 'tok-123', 'sso-ticket'];
	await odata(m, '/ProductSet/$count', {
		headers: {
			authorization: `Basic ${secrets[0]}`,
			cookie: `SAP_SESSIONID_X=${secrets[1]}`,
			'x-csrf-token': secrets[2] ?? '',
			MYSAPSSO2: secrets[3] ?? '',
			'sap-client': '100'
		}
	});
	// A CSRF token request asks with "Fetch", and the mock answers with a token.
	await odata(m, '/', { method: 'HEAD', headers: { 'x-csrf-token': 'Fetch' } });

	const { requests } = await logged(m);
	const [read, fetchToken] = await Promise.all(
		requests.map(async (r) =>
			LoggedRequestSchema.parse((await control(m, 'GET', `/requests/${r.seq}`)).body)
		)
	);
	expect(read?.requestHeaders).toMatchObject({
		authorization: 'Basic (removed)',
		cookie: '(removed)',
		'x-csrf-token': '(removed)',
		mysapsso2: '(removed)',
		'sap-client': '100'
	});
	expect(read?.responseHeaders['content-type']).toBeTruthy();
	expect(fetchToken?.requestHeaders['x-csrf-token']).toBe('Fetch');
	expect(fetchToken?.responseHeaders['x-csrf-token']).toBe('(removed)');
	// Nowhere in what the log holds, nor in the list.
	const held = JSON.stringify([read, fetchToken, await logged(m)]);
	for (const secret of [...secrets, 'mock-token']) expect(held).not.toContain(secret);
});

test('loggedHeaders keeps the names of secret headers, never their values', () => {
	expect(
		loggedHeaders({
			'set-cookie': ['SAP_SESSIONID=abc; HttpOnly', 'sap-usercontext=sap-client=100'],
			Authorization: 'Bearer eyJhbGciOi',
			'proxy-authorization': 'Negotiate YIIG',
			'x-api-key': 'k-1',
			'x-sap-security-session': 'create',
			'content-length': 12,
			accept: 'application/json'
		})
	).toEqual({
		'set-cookie': '(removed)',
		authorization: 'Bearer (removed)',
		'proxy-authorization': 'Negotiate (removed)',
		'x-api-key': '(removed)',
		'x-sap-security-session': '(removed)',
		'content-length': '12',
		accept: 'application/json'
	});
	// A login without a scheme keeps nothing.
	expect(loggedHeaders({ authorization: 'opaque-secret' })).toEqual({ authorization: '(removed)' });
});

test('refuses answers it cannot give, and services it does not serve', async () => {
	const m = await mock();
	for (const answer of [
		{ mode: 'fail', status: 200, message: 'x' },
		{ mode: 'fail', status: 503, message: 'x', rate: 0 },
		{ mode: 'fail', status: 503, message: 'x', rate: 101 },
		{ mode: 'fail', status: 429, message: 'x', retryAfterSeconds: -1 },
		{ mode: 'slow', delayMs: 500, maxDelayMs: 100 }
	])
		expect((await control(m, 'PUT', `/answers/${SERVICE}`, answer)).status).toBe(400);
	expect((await control(m, 'GET', '/answers')).body).toEqual({});
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
