import adapter from '@sveltejs/adapter-bun';
import { sveltekit } from '@sveltejs/kit/vite';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

// Lets the browser tests use an already installed Chromium where `playwright install` cannot download.
const executablePath = process.env.CHROMIUM_PATH || undefined;

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
	test: {
		expect: { requireAssertions: true },
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
