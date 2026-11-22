// First step of `bun run setup`: brings a checkout from before the single package.json up to date.
// Until then the app lived in app/ and sap-tests and its recorder had installs of their own.
//
// - Moves the app's data (app/.data: run history, users, passkeys) and its TLS certificate
//   (app/cert) to the root, where the app now looks for them. If both places exist it stops: the
//   person decides which to keep.
// - Deletes the old installs (app/node_modules, sap-tests/node_modules,
//   sap-tests/recorder/node_modules). Node would otherwise load the SAP tests' packages from
//   there, a second copy of Playwright next to the root install, and Playwright refuses to run.
//
// A checkout that is already up to date has none of these, and this does nothing.
import { existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// The checkout's root; a test passes another one.
const root = process.argv[2] ?? join(import.meta.dir, '..');

const MOVES = [
	{ from: 'app/.data', to: '.data', what: 'run history and sign-in data' },
	{ from: 'app/cert', to: 'cert', what: 'local TLS certificate' }
];

const OLD_INSTALLS = [
	'app/node_modules',
	'sap-tests/node_modules',
	'sap-tests/recorder/node_modules'
];

let stuck = false;
for (const { from, to, what } of MOVES) {
	if (!existsSync(join(root, from))) continue;
	if (existsSync(join(root, to))) {
		console.error(
			`Both ${from} and ${to} exist (${what}). The app uses ${to}. Keep one: move or delete the other, then run "bun run setup" again.`
		);
		stuck = true;
		continue;
	}
	renameSync(join(root, from), join(root, to));
	console.log(`Moved ${from} to ${to} (${what}).`);
}
if (stuck) process.exit(1);

for (const dir of OLD_INSTALLS) {
	if (!existsSync(join(root, dir))) continue;
	rmSync(join(root, dir), { recursive: true });
	console.log(`Deleted the old install ${dir}.`);
}

if (existsSync(join(root, 'app')))
	console.log(
		'app/ is left from the old layout. It holds only build output now (ignored by git); delete it when you like.'
	);
