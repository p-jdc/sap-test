// Guide §4.3. Trace, screenshot and video are kept for every failed test;
// workers: 1 until it is clear which tests can safely share data.
import 'dotenv/config';
import { defineConfig, devices } from '@playwright/test';
import type { SapOptions } from './sap-plugin';

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

// Tests that start with a saved session (sap-plugin/session.ts). Their setup project signs in once
// per run without a trace and runs only when a selected test needs it. tests/fiori/demokit opens
// SAP's public demo apps and needs no sign-in. The test agents' SAP seed starts signed in too.
const SAP_TESTS = [
	/[\\/]tests[\\/](fiori(?![\\/]demokit[\\/])|webgui|_reference)[\\/]/,
	/[\\/]tests[\\/]_agents[\\/]seed-sap\.spec\.ts$/
];
const ARIBA_TESTS = /[\\/]tests[\\/]ariba[\\/]/;
const browser = { ...devices['Desktop Chrome'] };
// The password is typed only in the setup projects: no trace (it would record the filled field
// and the login request) and no video.
const signIn = { ...browser, trace: 'off', video: 'off' } as const;

export default defineConfig<SapOptions>({
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
	projects: [
		{ name: 'sap-sign-in', testDir: './setup', testMatch: 'sap.setup.ts', use: signIn },
		{ name: 'ariba-sign-in', testDir: './setup', testMatch: 'ariba.setup.ts', use: signIn },
		// First of the projects no other one depends on: the test agents' MCP server uses it when a
		// tool call names no project.
		{ name: 'chromium', testIgnore: [...SAP_TESTS, ARIBA_TESTS], use: browser },
		{
			name: 'sap',
			testMatch: SAP_TESTS,
			dependencies: ['sap-sign-in'],
			use: { ...browser, sapSession: 'sap' }
		},
		{
			name: 'ariba',
			testMatch: ARIBA_TESTS,
			dependencies: ['ariba-sign-in'],
			use: { ...browser, sapSession: 'ariba' }
		}
	]
});
