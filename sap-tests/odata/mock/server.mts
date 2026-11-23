// Runs the OData mock (mock.mts) as a service.
//   bun odata/mock/server.mts        (from sap-tests)
// Settings by environment:
//   ODATA_MOCK_PORT      port of the OData endpoint (default 4010; 0 = a free port). It listens on 127.0.0.1 only.
//   ODATA_CONTROL_PORT   port of the control API (default 0 = a free port), also on 127.0.0.1 only
//   ODATA_CONTROL_TOKEN  token every control API request must carry, except GET /health
// When ready it prints one line `ODATA_READY {"odataUrl":…,"controlUrl":…}` for programs that start it.
import { startOdataMock } from './mock.mts';

const port = (value: string | undefined, fallback: number) =>
	value === undefined || value === '' ? fallback : Number(value);

let mock;
try {
	mock = await startOdataMock({
		port: port(process.env.ODATA_MOCK_PORT, 4010),
		controlPort: port(process.env.ODATA_CONTROL_PORT, 0),
		controlToken: process.env.ODATA_CONTROL_TOKEN || undefined
	});
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}

const { odataUrl, controlUrl, services } = mock;
console.log(`OData mock on ${odataUrl}`);
for (const { name, basePath } of services) console.log(`  ${name} at ${basePath}`);
console.log(`  control API on ${controlUrl} (GET /health, /info, /requests, /answers, /services)`);
console.log(`ODATA_READY ${JSON.stringify({ odataUrl, controlUrl })}`);
mock.onRequest(({ method, url, status, answer }) =>
	console.log(
		`${new Date().toISOString().slice(11, 23)}  ${method} ${url} → ${status || 'no answer'}${answer === 'normal' ? '' : ` (${answer})`}`
	)
);

const shutdown = () => {
	void mock.close().then(() => process.exit(0));
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
