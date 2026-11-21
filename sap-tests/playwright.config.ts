// Guide §4.3. Trace, screenshot and video are kept for every failed test;
// workers: 1 until it is clear which tests can safely share data.
import 'dotenv/config';
import { defineConfig, devices } from '@playwright/test';
import type { SapOptions } from './sap-plugin';
import { signInSystems, signInTag, testFiles } from './sap-plugin/systems';

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

// Each system of systems.json gets a sign-in project, which signs in once per run without a trace
// and runs only when a selected test needs it, and a project for its tests, which start with the
// saved session (sap-plugin/session.ts). The test agents' seed-signed-in.spec.ts belongs to each.
const systems = signInSystems();
const SIGNED_IN_SEED = /[\\/]tests[\\/]_agents[\\/]seed-signed-in\.spec\.ts$/;
const browser = { ...devices['Desktop Chrome'] };
// The password is typed only in the sign-in projects: no trace (it would record the filled field
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
		...systems.map((system) => ({
			name: `${system.id}-sign-in`,
			testDir: './setup',
			testMatch: 'sign-in.setup.ts',
			grep: new RegExp(`${signInTag(system)}(?:\\s|$)`),
			use: { ...signIn, baseURL: process.env[system.env.url] }
		})),
		// First of the projects no other one depends on: the test agents' MCP server uses it when a
		// tool call names no project.
		{
			name: 'chromium',
			testIgnore: [...systems.map((s) => testFiles(s)), SIGNED_IN_SEED],
			use: browser
		},
		...systems.map((system) => ({
			name: system.id,
			testMatch: [testFiles(system), SIGNED_IN_SEED],
			dependencies: [`${system.id}-sign-in`],
			// A relative address in a test of this system means this system, not SAP.
			use: { ...browser, system: system.id, baseURL: process.env[system.env.url] }
		}))
	]
});
