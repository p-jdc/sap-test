// Guide §4.3. Trace, screenshot and video are kept for every failed test;
// workers: 1 until it is clear which tests can safely share data.
import 'dotenv/config';
import { defineConfig, devices } from '@playwright/test';

// Optional escape hatch for machines where `npx playwright install` cannot download
// the browser build (CI sandboxes, locked-down laptops).
const executablePath = process.env.CHROMIUM_PATH || undefined;

// SAP_API_MOCK=1 (`bun run test:api:mock`): the API tests call the local OData mock in odata/mock
// instead of an SAP system, overriding any SAP_API_* values from .env. The mock runs on the same
// Node as Playwright.
const odataMock = process.env.SAP_API_MOCK === '1';
const mockPort = Number(process.env.ODATA_MOCK_PORT || 4010);
if (odataMock)
	Object.assign(process.env, {
		SAP_API_URL: `http://127.0.0.1:${mockPort}`,
		SAP_API_USERNAME: 'mock',
		SAP_API_PASSWORD: 'mock',
		SAP_CLIENT: ''
	});

export default defineConfig({
	webServer: odataMock
		? {
				command: `"${process.execPath}" odata/mock/server.mjs`,
				url: `http://127.0.0.1:${mockPort}/health`,
				env: { ODATA_MOCK_PORT: String(mockPort) },
				reuseExistingServer: false
			}
		: undefined,
	testDir: './tests',
	timeout: 120_000,
	expect: { timeout: 15_000 },
	workers: 1,
	retries: process.env.CI ? 1 : 0,
	reporter: [['html'], ['list']],
	use: {
		baseURL: process.env.SAP_URL,
		trace: 'retain-on-failure',
		screenshot: 'only-on-failure',
		video: 'retain-on-failure',
		launchOptions: executablePath ? { executablePath } : {}
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]
});
