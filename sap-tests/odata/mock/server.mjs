// Local stand-in for the OData services in odata/metadata, so the API tests run without an SAP
// system (CI, offline). Started by Playwright when SAP_API_MOCK=1 (see playwright.config.ts).
// Serves every service in options-per-service.json at its basePath, with the fixed data in
// odata/mock/data/<service>/<EntitySet>.json. Writes are kept in memory until the server stops.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import mockserver from '@sap-ux/fe-mockserver-core';

const FEMockserver = mockserver.default ?? mockserver;
const root = new URL('../../', import.meta.url);
const path = (relative) => fileURLToPath(new URL(relative, root));
const port = Number(process.env.ODATA_MOCK_PORT || 4010);

const services = JSON.parse(
	await readFile(path('odata/metadata/options-per-service.json'), 'utf8')
);
const mock = new FEMockserver({
	services: Object.entries(services).map(([file, { directoryName, basePath }]) => ({
		urlPath: basePath,
		// The core's own option names (the UI5 middleware maps metadataXmlPath / mockdataRootPath).
		metadataPath: path(file),
		mockdataPath: path(`odata/mock/data/${directoryName}`),
		generateMockData: false
	}))
});
await mock.isReady;
const router = mock.getRouter();

createServer((request, response) => {
	// Readiness check for Playwright's webServer.
	if (request.url === '/health') {
		response.end('ok');
		return;
	}
	// SAP Gateway hands out a CSRF token on request, and the SDK asks for one before every write.
	// The mock server core has no such endpoint (it would try to read the request as a write).
	if (request.method === 'HEAD' && request.headers['x-csrf-token']?.toLowerCase() === 'fetch') {
		response.setHeader('x-csrf-token', 'mock-token');
		response.end();
		return;
	}
	router(request, response, () => {
		response.statusCode = 404;
		response.end();
	});
}).listen(port, '127.0.0.1', () => console.log(`OData mock on http://127.0.0.1:${port}`));
