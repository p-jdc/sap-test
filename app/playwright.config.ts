import { defineConfig } from '@playwright/test';

// The app's own end-to-end tests (not the SAP suite in ../sap-tests). They build and preview the
// app, then drive it like a user, including a real run of the offline _demo tests.
const executablePath = process.env.CHROMIUM_PATH || undefined;

export default defineConfig({
	testDir: 'e2e',
	timeout: 60_000,
	// CI uploads the HTML report as an artifact when the job fails.
	reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
	forbidOnly: !!process.env.CI,
	webServer: {
		command: 'bun run build && bun run preview',
		port: 4180,
		timeout: 180_000,
		reuseExistingServer: !!process.env.PW_REUSE_SERVER,
		// Keeps e2e runs out of the real run history.
		env: { TEST_APP_DATA_DIR: '.data-e2e', DEV_HTTP: '1' }
	},
	use: {
		baseURL: 'http://localhost:4180',
		launchOptions: executablePath ? { executablePath } : {}
	}
});
