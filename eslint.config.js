import prettier from 'eslint-config-prettier';
import path from 'node:path';
import js from '@eslint/js';
import oxlint from 'eslint-plugin-oxlint';
import svelte from 'eslint-plugin-svelte';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

// oxlint (.oxlintrc.json) does the heavy lifting, including all type-aware rules. ESLint stays
// for what oxlint cannot do yet: the Svelte template rules of eslint-plugin-svelte, notably
// svelte/no-navigation-without-resolve. The oxlint config at the end turns off every rule
// oxlint already runs, so nothing is reported twice.
export default defineConfig(
	includeIgnoreFile(gitignorePath),
	// sap-tests/ is the SAP test project: oxlint covers it (sap-tests/.oxlintrc.json), it has no Svelte.
	{
		ignores: [
			'.data/',
			'.data-e2e/',
			'playwright-report/',
			'test-results/',
			'sap-tests/',
			// Third-party oxlint rules, kept as they came; oxlint loads them, it does not lint them.
			'tools/oxlint/anti-slop/',
			'.claude/'
		]
	},
	js.configs.recommended,
	ts.configs.recommended,
	svelte.configs.recommended,
	prettier,
	svelte.configs.prettier,
	{
		linterOptions: { reportUnusedDisableDirectives: 'error' },
		languageOptions: {
			// svelte/no-navigation-without-resolve reads types to accept the ResolvedPathname helpers
			// in src/lib/client/links.ts, in .ts files (goto) as well as .svelte files.
			parserOptions: { projectService: true },
			globals: { ...globals.browser, ...globals.node }
		},
		rules: {
			// typescript-eslint strongly recommend that you do not use the no-undef lint rule on TypeScript projects.
			// see: https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule-about-global-variables-not-being-defined-even-though-there-are-no-typescript-errors
			'no-undef': 'off'
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
				parser: ts.parser
			}
		},
		rules: {
			'svelte/no-navigation-without-resolve': 'error'
		}
	},
	// Must stay last.
	...oxlint.buildFromOxlintConfigFile('./.oxlintrc.json')
);
