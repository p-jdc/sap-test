// Guide §4.3. Trace, screenshot and video are kept for every failed test;
// workers: 1 until it is clear which tests can safely share data.
import 'dotenv/config';
import { defineConfig, devices } from '@playwright/test';
import type { SapOptions } from './sap-plugin';
import { acceptsSelfSigned, SELF_SIGNED_SETTING } from './sap-plugin/self-signed';
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

// IDOC_HUB_MOCK=1 (`bun run test:idoc`): Playwright starts the IDoc receiver (idoc/server.mts) on this computer,
// and the idocInbox fixture reads its inbox. The receiver takes free ports. Fixed ones, such as its defaults
// 47200 and 47201, lie in the range Linux hands out for free ports and outgoing connections, so another process
// can hold them (in CI, the Mock PLC that runs just before did). Playwright reads both addresses from the
// receiver's ready line (`wait` below) into IDOC_HUB_URL, its control API, and IDOC_MOCK_URL, the endpoint tests
// post IDocs to in SAP's place. That replaces any IDOC_HUB_URL from the environment file, and the workers
// inherit both.
const idocMock = process.env.IDOC_HUB_MOCK === '1';
if (idocMock) process.env.IDOC_HUB_TOKEN = '';

// MFS_MOCK=1 (`bun run test:mfs`): tests with the `mfs` fixture (sap-plugin/mfs.ts) run against a local
// Mock PLC with the simulated EWM instead of one from MFS_EMULATOR_URL. Bun runs it, as in the app.
// MFS_SPEED sets its time factor (default 10, so scenarios take seconds).
const mfsMock = process.env.MFS_MOCK === '1';
const mfsMockPort = Number(process.env.MFS_MOCK_PORT || 4020);
if (mfsMock) {
	process.env.MFS_EMULATOR_URL = `http://127.0.0.1:${mfsMockPort}`;
	delete process.env.MFS_EMULATOR_TOKEN;
}
type WebServer = {
	command: string;
	/** Ready once this answers, or (with `wait`) once the output matches. */
	url?: string;
	wait?: { stdout: RegExp };
	env: Record<string, string>;
	reuseExistingServer: boolean;
};
const webServers: WebServer[] = [
	...(odataMock
		? [
				{
					command: `"${process.execPath}" odata/mock/server.mjs`,
					url: `http://127.0.0.1:${mockPort}/health`,
					env: { ODATA_MOCK_PORT: String(mockPort) },
					reuseExistingServer: false
				}
			]
		: []),
	...(mfsMock
		? [
				{
					command: 'bun mfs/server.mts',
					url: `http://127.0.0.1:${mfsMockPort}/health`,
					env: {
						MFS_FAKE_EWM: '1',
						MFS_CONTROL_PORT: String(mfsMockPort),
						MFS_BASE_PORT: '0',
						// The PLC ports stay on this computer and the tests get the warehouse they are written
						// for, whatever the environment file sets up for a real EWM (MFS_HOST, MFS_SETUP).
						MFS_HOST: '127.0.0.1',
						MFS_SETUP: 'sap-example',
						MFS_SPEED: process.env.MFS_SPEED || '10'
					},
					reuseExistingServer: false
				}
			]
		: []),
	...(idocMock
		? [
				{
					command: 'bun idoc/server.mts',
					// Ready once it prints its addresses; the named groups become IDOC_MOCK_URL and IDOC_HUB_URL.
					wait: {
						stdout:
							/IDOC_READY \{"idocUrl":"(?<idoc_mock_url>[^"]+)","controlUrl":"(?<idoc_hub_url>[^"]+)"\}/
					},
					// Playwright adds these to the whole environment, .env included: a login, certificates or a
					// token set there for a real receiver are cleared, so the local one runs plain and open.
					env: {
						IDOC_HOST: '127.0.0.1',
						IDOC_PORT: '0',
						IDOC_CONTROL_HOST: '127.0.0.1',
						IDOC_CONTROL_PORT: '0',
						IDOC_USER: '',
						IDOC_PASSWORD: '',
						IDOC_TLS_CERT: '',
						IDOC_TLS_KEY: '',
						IDOC_TLS_CA: '',
						IDOC_TLS_CLIENT_FINGERPRINT: '',
						IDOC_CONTROL_TOKEN: ''
					},
					reuseExistingServer: false
				}
			]
		: [])
];

// Each system of systems.json gets a sign-in project, which signs in once per run without a trace
// and runs only when a selected test needs it, and a project for its tests, which start with the
// saved session (sap-plugin/session.ts). The test agents' seed-signed-in.spec.ts belongs to each.
const systems = signInSystems();
const SIGNED_IN_SEED = /[\\/]tests[\\/]_agents[\\/]seed-signed-in\.spec\.ts$/;
const browser = { ...devices['Desktop Chrome'] };
// The password is typed only in the sign-in projects: no trace (it would record the filled field
// and the login request) and no video.
const signIn = { ...browser, trace: 'off', video: 'off' } as const;
// An SAP system on the host of SAP_SELF_SIGNED_HOST (a trial appliance with its own certificate)
// gets a browser without the certificate check, for every address it reaches (self-signed.ts);
// every other system keeps the full check.
const certificate = (system: (typeof systems)[number]) =>
	system.signIn.method === 'sapLogin' &&
	acceptsSelfSigned(process.env[system.env.url], process.env[SELF_SIGNED_SETTING])
		? // oxlint-disable-next-line secure-coding/require-secure-defaults -- off by default; only for an SAP system on the host the person named in SAP_SELF_SIGNED_HOST (README)
			{ ignoreHTTPSErrors: true }
		: {};

export default defineConfig<SapOptions>({
	webServer: webServers.length > 0 ? webServers : undefined,
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
			use: { ...signIn, ...certificate(system), baseURL: process.env[system.env.url] }
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
			use: {
				...browser,
				...certificate(system),
				system: system.id,
				baseURL: process.env[system.env.url]
			}
		}))
	]
});
