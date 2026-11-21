// SPIKE. Records a UI5 flow by hand on stock Playwright:
//   node sap-plugin/record.mjs <url> [tests/<folder>/<name>.spec.ts]
// Click through the flow in the window that opens, then close it; the spec is written on close.
// recorder.ts is TypeScript, so it is bundled for Node here, the way engines.ts bundles the engines.
import { chromium, selectors } from '@playwright/test';
import { buildSync } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const load = async (file) => {
	const built = buildSync({
		entryPoints: [resolve(here, file)],
		bundle: true,
		write: false,
		format: 'esm',
		platform: 'node',
		packages: 'external'
	});
	const source = Buffer.from(built.outputFiles[0].text).toString('base64');
	return import(`data:text/javascript;base64,${source}`);
};

const [url, output = 'tests/_plugin/recorded.spec.ts'] = process.argv.slice(2);
if (!url) {
	console.error('Usage: node sap-plugin/record.mjs <url> [output.spec.ts]');
	process.exit(1);
}

const { installRecorder, renderSpec } = await load('recorder.ts');
const { UI5_CONTROL_ENGINE, ui5ControlEngine } = await load('ui5control.ts');

await selectors.register(UI5_CONTROL_ENGINE, ui5ControlEngine);
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ viewport: null, locale: 'en-US' });
const steps = await installRecorder(context);
const page = await context.newPage();
await page.goto(url);
console.log('Recording. Close the browser window to save.');
await Promise.race([
	new Promise((done) => page.once('close', done)),
	new Promise((done) => browser.once('disconnected', done))
]);

const file = resolve(output);
const plugin = relative(dirname(file), here).replaceAll('\\', '/');
mkdirSync(dirname(file), { recursive: true });
const recorded = await steps();
writeFileSync(file, renderSpec(url, recorded, plugin.startsWith('.') ? plugin : `./${plugin}`));
console.log(`Saved ${recorded.length} steps to ${output}`);
await browser.close().catch(() => undefined);
