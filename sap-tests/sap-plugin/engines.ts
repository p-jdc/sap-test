// Bundles the vendored Playwright-SAP selector engines (vendor/playwright-sap, Apache-2.0) into
// standalone scripts that stock Playwright accepts in selectors.register(). The vendored files are
// unmodified; their `@sap/…`, `@injected/…` and `@isomorphic/…` imports are resolved by alias.
import { buildSync } from 'esbuild';
import { resolve } from 'node:path';

const VENDOR = resolve(__dirname, 'vendor/playwright-sap');

/**
 * Engine names as registered with Playwright. Stock Playwright allows no colon in a custom engine
 * name, so the fork's `ui5:role` / `ui5:xpath` become `ui5role` / `ui5xpath`. None of them is
 * plain `ui5`, which Praman registers.
 */
export const ENGINES = { ui5role: 'ui5role', ui5xpath: 'ui5xpath', sid: 'sid' } as const;

export const ENGINE_NAMES = ['ui5role', 'ui5xpath', 'sid'] as const;

/** Source of one engine: an expression that evaluates to `{ queryAll }` inside the page. */
export function engineSource(name: keyof typeof ENGINES): string {
	const result = buildSync({
		entryPoints: [resolve(__dirname, 'entries', name + '.ts')],
		bundle: true,
		write: false,
		format: 'iife',
		globalName: '__sapEngine',
		platform: 'browser',
		target: 'es2022',
		logLevel: 'silent',
		alias: {
			'@sap': resolve(VENDOR, 'sap'),
			'@injected/sap': resolve(VENDOR, 'injected/sap'),
			'@isomorphic': resolve(VENDOR, 'isomorphic')
		}
	});
	return `(() => { ${result.outputFiles[0].text}; return __sapEngine.engine; })()`;
}
