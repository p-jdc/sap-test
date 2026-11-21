// Records a UI5 (or WebGUI) flow by hand on stock Playwright:
//   node sap-plugin/record.mjs <url> [tests/<folder>/<name>.spec.ts] [options]
//     --name <title>          title of the recorded test
//     --login                 log in first with SAP_USERNAME / SAP_PASSWORD from the environment;
//                             the spec then starts with page.SAPLogin and reads them the same way
//     --url-from-env          <url> is the configured SAP_URL: the spec reads it from the environment
//     --save-storage <file>   write the session (cookies, storage) for storageState reuse
// Click through the flow in the window that opens, then close it; the spec is written on close,
// and also when this process is asked to stop (SIGTERM, which is what the app's Stop button sends).
// The plugin files are TypeScript, so they are bundled for Node here, the way engines.ts bundles
// the selector engines.
import { chromium, selectors } from '@playwright/test';
import { buildSync } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// Inside node_modules, so that the bundles find @playwright/test and git ignores them.
const cache = resolve(here, '../node_modules/.cache/sap-recorder');
const load = (file) => {
	const outfile = resolve(cache, file.replace(/\.ts$/, '.mjs'));
	buildSync({
		entryPoints: [resolve(here, file)],
		outfile,
		bundle: true,
		format: 'esm',
		platform: 'node',
		packages: 'external'
	});
	return import(`${pathToFileURL(outfile).href}?${Date.now()}`);
};

// The project's formatter. The spec is written one step per line, which is far wider than the
// format check allows, so a recording would fail the gate until someone formatted it.
const formatter = resolve(here, '../node_modules/oxfmt/bin/oxfmt');
const format = (file) => {
	if (!existsSync(formatter)) return 'oxfmt is not installed';
	const { status, error, stderr } = spawnSync(process.execPath, [formatter, file], {
		cwd: resolve(here, '..'),
		encoding: 'utf8'
	});
	return status === 0 ? null : (error?.message ?? stderr.trim()) || `oxfmt exited with ${status}`;
};

const positional = [];
const options = { name: undefined, login: false, urlFromEnv: false, saveStorage: undefined };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
	if (args[i] === '--name') options.name = args[++i];
	else if (args[i] === '--login') options.login = true;
	else if (args[i] === '--url-from-env') options.urlFromEnv = true;
	else if (args[i] === '--save-storage') options.saveStorage = args[++i];
	else positional.push(args[i]);
}
const [url, output = 'tests/_plugin/recorded.spec.ts'] = positional;
if (!url) {
	console.error(
		'Usage: node sap-plugin/record.mjs <url> [output.spec.ts] [--name <title>] [--login]'
	);
	process.exit(1);
}
const { SAP_USERNAME, SAP_PASSWORD } = process.env;
if (options.login && !(SAP_USERNAME && SAP_PASSWORD)) {
	console.error('--login needs SAP_USERNAME and SAP_PASSWORD in the environment.');
	process.exit(1);
}

const { installRecorder, renderSpec } = await load('recorder.ts');
const { UI5_CONTROL_ENGINE, ui5ControlEngine } = await load('ui5control.ts');

await selectors.register(UI5_CONTROL_ENGINE, ui5ControlEngine);
// For automated checks of this script, which have no person at the window: SAP_RECORD_HEADLESS=1
// hides it, and SAP_RECORD_DEBUG_PORT lets the check drive the page from outside.
const debugPort = process.env.SAP_RECORD_DEBUG_PORT;
const browser = await chromium.launch({
	headless: process.env.SAP_RECORD_HEADLESS === '1',
	// A stop signal ends the recording below, which saves first and then closes the browser.
	handleSIGTERM: false,
	handleSIGINT: false,
	handleSIGHUP: false,
	args: debugPort ? [`--remote-debugging-port=${debugPort}`] : []
});
// Tests run in English; a recording in another language would name buttons the tests never see.
const context = await browser.newContext({ viewport: null, locale: 'en-US' });
const steps = await installRecorder(context);
const page = await context.newPage();

let finishing;
const finish = () => {
	finishing ??= (async () => {
		// Whatever the login itself triggered is not part of the flow.
		const recorded = (await steps()).slice(loginSteps);
		if (options.saveStorage) {
			const file = resolve(options.saveStorage);
			mkdirSync(dirname(file), { recursive: true });
			await context
				.storageState({ path: file })
				.then(() => console.log(`Saved the session to ${options.saveStorage}`))
				.catch((error) => console.error(`Could not save the session: ${error.message}`));
		}
		await browser.close().catch(() => undefined);
		if (!recorded.length) {
			console.error('Nothing was recorded, so no test was written.');
			process.exit(1);
		}
		const file = resolve(output);
		const plugin = relative(dirname(file), here).replaceAll('\\', '/');
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(
			file,
			renderSpec(url, recorded, plugin.startsWith('.') ? plugin : `./${plugin}`, options)
		);
		const unformatted = format(file);
		if (unformatted) console.error(`Saved the test unformatted: ${unformatted}`);
		console.log(`Saved ${recorded.length} steps to ${output}`);
		process.exit(0);
	})();
};
let loginSteps = 0;
process.on('SIGTERM', finish);
process.on('SIGINT', finish);
page.once('close', finish);
browser.once('disconnected', finish);

if (options.login) {
	const { sapLogin } = await load('login.ts');
	await sapLogin(page, SAP_USERNAME, SAP_PASSWORD, url);
	loginSteps = (await steps()).length;
} else {
	await page.goto(url);
}
console.log('Recording. Close the browser window to save.');
