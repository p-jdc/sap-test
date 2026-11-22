import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { readTestEnv } from './env-file.js';
import { lineSplitter } from './lines.js';
import { allowsCredentials, sameOrigin } from './origin.js';
import {
	childEnv,
	PLAYWRIGHT_PACKAGE,
	playwrightCommand,
	playwrightNode,
	RECORDER_PACKAGE,
	recorderCommand,
	UI5_RECORDER,
	ui5RecorderCommand
} from './node-cli.js';
import { PACKAGES_DIR, TESTS_DIR, TESTS_ROOT, toPosix, within } from './paths.js';
import { API_SYSTEM, readSystems } from './systems.js';
import type { RecordTarget, SignInSystemInfo } from '#lib/shared/types.js';

export type RecorderState = {
	status: 'idle' | 'recording' | 'saved' | 'error';
	file?: string;
	log: string[];
	startedAt?: string;
};

let state: RecorderState = { status: 'idle', log: [] };
let proc: ChildProcess | null = null;

export function recorderState(): RecorderState {
	return state;
}

export type RecordInput = {
	/** The folder under tests/ to save in: one of a system's record targets (systems.ts). */
	folder: string;
	name: string;
	url?: string;
	/**
	 * UI5 recorder only: record a page that needs no SAP login, such as a demo app. Any start page
	 * is allowed, because the recorder then gets no credentials it could type into it.
	 */
	noLogin?: boolean;
};

const RECORDED_IMPORT = /from\s+['"]@playwright\/test['"]/;

/**
 * The recorder writes `from '@playwright/test'`, but the SAP methods it uses (page.getByRoleUI5,
 * locateSID, …) exist only on the `test` of sap-tests/sap-plugin. Returns the spec with that import
 * pointed at the plugin, relative to the spec's own folder.
 */
export function withPluginImport(source: string, specFile: string): string {
	const plugin = toPosix(relative(dirname(specFile), resolve(TESTS_ROOT, 'sap-plugin')));
	return source.replace(RECORDED_IMPORT, `from '${plugin}'`);
}

export type Invocation = {
	cmd: string;
	args: string[];
	/** Extra environment for the recorder process. */
	env: Record<string, string>;
	/** What must exist for this recorder to start, and how to get it. */
	needs: { path: string; hint: string };
};

/**
 * Blank values for the user and password of every system: a recorder inherits this app's
 * environment, and gets only the login of the system it records.
 */
function blankLogins(systems: SignInSystemInfo[]): Record<string, string> {
	const names = [
		...systems.flatMap((s) => [s.env.user, s.env.password]),
		API_SYSTEM.user,
		API_SYSTEM.password,
		// The names the Playwright-SAP recorder reads (recorder/codegen.cjs).
		'SAP_USERNAME',
		'SAP_PASSWORD'
	];
	return Object.fromEntries(names.map((name) => [name, '']));
}

/**
 * The recorder process for one recording. `file` is the spec relative to tests/, `url` the start
 * page, `env` the settings, `systems` every system of systems.json.
 *
 * `ui5` records with the UI5 recorder of sap-plugin (stock Playwright): UI5 itself describes each
 * control, so the locators need no positions. It gets the system's credentials through its
 * environment and writes a spec that starts with page.SAPLogin and reads them by the system's
 * variable names. `webgui` records with the Playwright-SAP fork in sap-tests/recorder (guide §4.4:
 * `codegen <url> --sap-login <user> <password>`), because the UI5 recorder's WebGUI support has
 * not been tried on a real system. The fork runs behind recorder/codegen.cjs, which hands it the
 * login from the environment: on the command line every user of the machine could read the
 * password. `web` (Ariba and other systems where the person signs in) records with stock
 * Playwright's codegen: those tests use standard locators, which it writes as well.
 */
export function recorderInvocation(
	input: Pick<RecordInput, 'name' | 'noLogin'> & { recorder: RecordTarget['recorder'] },
	system: SignInSystemInfo,
	systems: SignInSystemInfo[],
	file: string,
	url: string,
	env: Record<string, string>
): Invocation {
	const blank = blankLogins(systems);
	const { url: urlVar, user, password } = system.env;
	if (input.recorder === 'ui5') {
		const login = input.noLogin ? [] : ['--login'];
		const flags = ['--name', input.name.trim(), ...login, '--env', `${urlVar},${user},${password}`];
		if (url === env[urlVar]) flags.push('--url-from-env');
		return {
			...ui5RecorderCommand([url, 'tests/' + file, ...flags]),
			// Without a login the credentials stay blank, so no password reaches a recorder that opens
			// a page of the caller's choosing.
			env: input.noLogin
				? blank
				: { ...blank, [user]: env[user] ?? '', [password]: env[password] ?? '' },
			needs: {
				path: UI5_RECORDER,
				hint: `The UI5 recorder is missing in ${TESTS_ROOT}/sap-plugin.`
			}
		};
	}
	const codegen = ['codegen', url, '--target', 'playwright-test', '-o', 'tests/' + file];
	if (input.recorder === 'web')
		return {
			...playwrightCommand(codegen),
			// A person signs in to these systems: the recorder gets no password.
			env: blank,
			needs: {
				path: PLAYWRIGHT_PACKAGE,
				hint: `Playwright is not installed in ${PACKAGES_DIR}. Run "bun run setup" in the repo root.`
			}
		};
	return {
		...recorderCommand([...codegen, '--sap-login-from-env']),
		env: { ...blank, SAP_USERNAME: env[user] ?? '', SAP_PASSWORD: env[password] ?? '' },
		needs: {
			path: RECORDER_PACKAGE,
			hint: `The WebGUI recorder (Playwright-SAP) is not installed in ${PACKAGES_DIR}. Run "bun run setup" in the repo root.`
		}
	};
}

/**
 * Starts a recording. Credentials come from the settings and never go back to the UI. The browser
 * opens on the machine running this app.
 */
export async function startRecording(
	input: RecordInput
): Promise<{ ok: true; file: string } | { ok: false; error: string }> {
	const { systems, error } = readSystems();
	if (error) return { ok: false, error };
	const system = systems.find((s) => s.record.some((t) => t.folder === input.folder));
	const target = system?.record.find((t) => t.folder === input.folder);
	if (!system || !target)
		return {
			ok: false,
			error: `No system in systems.json records into tests/${input.folder}.`
		};
	const env = await readTestEnv();
	// Checked after the await: nothing below yields, so two requests cannot both start a recording.
	if (state.status === 'recording') return { ok: false, error: 'A recording is already running.' };
	const slug = input.name
		.trim()
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, '-')
		.replaceAll(/^-|-$/g, '');
	if (!slug) return { ok: false, error: 'Give the flow a name.' };
	const noLogin = target.noLoginFolder !== undefined && input.noLogin === true;
	// The tests in a system's folders start from its saved session, which a run first signs in for
	// (playwright.config.ts). A page recorded without login needs none, so its test goes to a
	// folder the system excludes.
	const file = `${noLogin ? target.noLoginFolder : target.folder}/${slug}.spec.ts`;
	const full = within(TESTS_DIR, file);
	if (!full) return { ok: false, error: 'Invalid file name.' };
	if (existsSync(full)) return { ok: false, error: `${file} already exists.` };

	const { url: urlVar, user, password } = system.env;
	const url = input.url || env[urlVar];
	if (!url)
		return {
			ok: false,
			error: `No URL given and ${urlVar} is not set (Settings page or sap-tests/.env).`
		};

	if (target.recorder !== 'web' && !noLogin) {
		if (!env[user] || !env[password]) {
			return {
				ok: false,
				error: `${user} / ${password} missing (Settings page or sap-tests/.env).`
			};
		}
		// The recorder types the credentials into the page it opens, so that page must be the
		// configured system and not any URL a caller sends.
		const home = env[urlVar];
		if (!home || !sameOrigin(url, home)) {
			return {
				ok: false,
				error: `The recorder logs in with the stored credentials of ${system.title}, so the start URL must be on the same host as ${urlVar}.`
			};
		}
		// An address from .env was never checked on a Settings page.
		if (!allowsCredentials(url)) {
			return {
				ok: false,
				error: `The recorder logs in with the stored credentials of ${system.title}, so the start URL must start with https:// (http:// only on this computer).`
			};
		}
	}
	const invocation = recorderInvocation(
		{ name: input.name, noLogin, recorder: target.recorder },
		system,
		systems,
		file,
		url,
		env
	);
	// Checked last, so a wrong name, URL or missing credentials are reported first.
	if (!existsSync(invocation.needs.path)) return { ok: false, error: invocation.needs.hint };
	mkdirSync(dirname(full), { recursive: true });

	// The fork's recorder is the one part that still needs the tested Node; say so where a hang
	// would show.
	// The Node warning is about the fork, which only records WebGUI.
	const nodeWarning = target.recorder === 'webgui' ? playwrightNode().warning : null;
	state = {
		status: 'recording',
		file,
		log: [
			`Recording ${file} – browser opens on the app host.`,
			...(nodeWarning ? [`Warning: ${nodeWarning}`] : [])
		],
		startedAt: new Date().toISOString()
	};
	proc = spawn(invocation.cmd, invocation.args, {
		cwd: TESTS_ROOT,
		// The recorders load their packages from the install checked above (needs.path), not from
		// one they would find on their own.
		env: childEnv({ ...invocation.env, TEST_APP_PACKAGES_DIR: PACKAGES_DIR }),
		stdio: ['ignore', 'pipe', 'pipe']
	});
	// A recording must not outlive the app: its browser would stay open with nobody to save it, and
	// the recorder process holds the SAP password in its environment.
	const recorder = proc;
	const stopWithApp = () => {
		recorder.kill('SIGTERM');
	};
	process.once('exit', stopWithApp);
	const secret = env[password];
	const onLine = (line: string) => {
		if (!line) return;
		// Never echo the password back: the recorder process holds it in its environment. Masked per
		// whole line, so a password split between two output chunks is still caught.
		state.log.push(secret ? line.replaceAll(secret, '***') : line);
		state.log = state.log.slice(-200);
	};
	const outputs = [proc.stdout, proc.stderr].flatMap((stream) => {
		if (!stream) return [];
		const lines = lineSplitter(onLine);
		stream.setEncoding('utf8');
		stream.on('data', (chunk: string) => {
			lines.push(chunk);
		});
		return [lines];
	});
	proc.on('error', (e) => {
		state = { ...state, status: 'error', log: [...state.log, e.message] };
	});
	proc.on('close', (code) => {
		process.off('exit', stopWithApp);
		proc = null;
		for (const lines of outputs) lines.flush();
		const saved = existsSync(full);
		if (saved) writeFileSync(full, withPluginImport(readFileSync(full, 'utf8'), full));
		state = {
			...state,
			status: saved ? 'saved' : 'error',
			log: [
				...state.log,
				saved ? `Saved ${file}` : `The recorder exited with code ${code} and wrote no file.`
			]
		};
	});
	return { ok: true, file };
}

/** How long a recorder gets to save and close its browser before it is ended. */
const STOP_GRACE_MS = 10_000;

/**
 * Asks the recorder to save and stop. One that does not exit in time is ended, so the page never
 * stays on "recording" with a browser nobody can close.
 */
export function stopRecording(graceMs = STOP_GRACE_MS) {
	const stopping = proc;
	if (!stopping) return;
	stopping.kill('SIGTERM');
	const timer = setTimeout(() => {
		if (proc !== stopping) return;
		state = {
			...state,
			log: [...state.log, 'The recorder did not stop when asked and was ended.'].slice(-200)
		};
		stopping.kill('SIGKILL');
	}, graceMs);
	// The timer alone must not keep the app alive.
	timer.unref();
	stopping.once('close', () => {
		clearTimeout(timer);
	});
}
