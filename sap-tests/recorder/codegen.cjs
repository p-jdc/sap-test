// Starts the Playwright-SAP recorder (node_modules/playwright-sap-recorder/cli.js) with the SAP login taken
// from the environment instead of the command line. The fork only takes the credentials as
// `--sap-login <user> <password>`, and a command line can be read by every user of the machine
// (`ps`) while the recording runs. Here the flag `--sap-login-from-env` stands in for it: this
// process adds the real one to its own copy of the arguments, which no other process sees.
//
//   node codegen.cjs codegen <url> --sap-login-from-env [options]
//
// SAP_USERNAME and SAP_PASSWORD come from the environment, else from sap-tests/.env (a value
// already set, even an empty one, is kept: the test app sets them itself). Without the flag the
// arguments are passed on unchanged.
const path = require('node:path');

const FLAG = '--sap-login-from-env';

// The install to load the fork and dotenv from: the one the app checked before it started this
// (TEST_APP_PACKAGES_DIR), else the repository's, two levels up.
const packages = process.env.TEST_APP_PACKAGES_DIR || path.resolve(__dirname, '../../node_modules');

/** This computer (the same rule as sap-plugin/secure-url.ts, which this CommonJS file cannot load). */
const loopback = (name) =>
	name === 'localhost' ||
	name.endsWith('.localhost') ||
	name === '[::1]' ||
	/^127(?:\.\d{1,3}){3}$/.test(name);

const at = process.argv.indexOf(FLAG);
if (at !== -1) {
	try {
		require(path.join(packages, 'dotenv')).config({
			path: path.resolve(__dirname, '../.env'),
			quiet: true
		});
	} catch {
		// No dotenv next to it: only the environment counts.
	}
	const user = process.env.SAP_USERNAME;
	const password = process.env.SAP_PASSWORD;
	if (!user || !password) {
		console.error(`${FLAG} needs SAP_USERNAME and SAP_PASSWORD (environment or sap-tests/.env).`);
		process.exit(1);
	}
	// The fork types the password into the start page: never over http:// to another computer.
	const insecure = process.argv.find((arg) => {
		if (!URL.canParse(arg)) return false;
		const { protocol, hostname } = new URL(arg);
		return protocol === 'http:' && !loopback(hostname.toLowerCase());
	});
	if (insecure) {
		console.error(
			`${FLAG}: ${new URL(insecure).origin} is not https://, so the password would cross the network unencrypted.`
		);
		process.exit(1);
	}
	process.argv.splice(at, 1);
	// Last: the fork's option takes every argument after it until the next option.
	process.argv.push('--sap-login', user, password);
	// The browser and the fork's other child processes do not need it.
	delete process.env.SAP_PASSWORD;
}

// The fork's CLI parses process.argv as it loads.
require(path.join(packages, 'playwright-sap-recorder/cli.js'));
