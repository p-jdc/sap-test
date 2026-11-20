import adapter from '@sveltejs/adapter-bun';
import { sveltekit } from '@sveltejs/kit/vite';
import { playwright } from '@vitest/browser-playwright';
import { existsSync, readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Lets the browser tests use an already installed Chromium where `playwright install` cannot download.
const executablePath = process.env.CHROMIUM_PATH || undefined;

// HTTPS for dev and preview when `bun run setup:cert` has created cert/ (mkcert). The point is HTTP/2:
// live run and flow views each hold a streaming request open, and HTTP/1.1 allows only six
// connections per host, so a few open tabs stall the app. Without cert/, or with DEV_HTTP=1
// (e2e, CI), it stays plain HTTP.
const certFile = 'cert/cert.pem';
const keyFile = 'cert/key.pem';
const https =
	!process.env.DEV_HTTP && existsSync(certFile) && existsSync(keyFile)
		? { cert: readFileSync(certFile), key: readFileSync(keyFile) }
		: undefined;

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true,
				experimental: { async: true },
				// UI5 elements are focusable custom elements with their own keyboard handling, so these two
				// checks (written for native non-interactive elements like <div>) are noise for them.
				warningFilter: (w) =>
					!(
						w.message.includes('`<ui5-') &&
						/^a11y_(click_events_have_key_events|no_static_element_interactions)$/.test(w.code)
					)
			},

			adapter: adapter(),
			experimental: { remoteFunctions: true }
		})
	],
	// Own ports instead of Vite's 5173/4173, so this app and other Vite apps (e.g. the reference app)
	// can run side by side. strictPort: fail loudly instead of silently moving to the next free port.
	server: { https, port: Number(process.env.DEV_PORT ?? 5180), strictPort: true },
	preview: { https, port: Number(process.env.PREVIEW_PORT ?? 4180), strictPort: true },
	test: {
		expect: { requireAssertions: true },
		// `bun run test:coverage`. v8 covers both projects (Chromium's built-in coverage in the
		// browser project). Reported only; no thresholds yet.
		coverage: {
			provider: 'v8',
			include: ['src/lib/**/*.{ts,svelte}'],
			exclude: ['src/**/*.{test,spec}.ts', 'src/test/**', 'src/**/*Harness.svelte'],
			reporter: ['text-summary', 'html']
		},
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					// Components render in a real Chromium, like the app (UI5 needs a real DOM).
					name: 'client',
					browser: {
						enabled: true,
						provider: playwright({ launchOptions: { executablePath } }),
						instances: [{ browser: 'chromium', headless: true }]
					},
					include: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			},
			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
