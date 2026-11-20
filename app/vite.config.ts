import adapter from '@sveltejs/adapter-bun';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

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
						/`<ui5-/.test(w.message) &&
						/^a11y_(click_events_have_key_events|no_static_element_interactions)$/.test(w.code)
					)
			},

			adapter: adapter(),
			experimental: { remoteFunctions: true }
		})
	]
});
