// The IDoc receiver (sap-tests/idoc) as seen from the app: started as its own process, the way it will run as its
// own service on the cluster later, and reached only through its HTTP control API. The browser never talks to
// the receiver; the page goes through the remote functions in idoc.remote.ts.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
	IdocFailureSchema,
	IdocInfoSchema,
	IdocListSchema,
	IDOC_SAP_SYSTEMS,
	IdocReplyInEffectSchema,
	ReceivedIdocSchema,
	SentIdocsSchema,
	type IdocEndpoint,
	type IdocReply,
	type IdocSample,
	type IdocSampleAnswer,
	type IdocSnapshot,
	type IdocStatus,
	type IdocSapSystem,
	type IdocSapTarget,
	type ReceivedIdoc,
	type SentIdocs
} from '#lib/shared/idoc.js';
import { readTestEnv } from './env-file.js';
import { lineSplitter } from './lines.js';
import { importedPackages, missingPackages } from './mfs.js';
import { childEnv } from './node-cli.js';
import { PACKAGES_DIR, TESTS_ROOT } from './paths.js';
import { settingNames } from './systems.js';

const IDOC_DIR = resolve(TESTS_ROOT, 'idoc');
const SAMPLES_DIR = resolve(IDOC_DIR, 'samples');
const READY = 'IDOC_READY ';
const START_TIMEOUT_MS = 15_000;
/** IDocs the page keeps; the receiver itself keeps more. */
const KEEP = 200;
/** Sends into SAP the page shows. */
const KEEP_SENT = 50;
/** Raw requests are shown up to this size. */
const RAW_SHOWN = 2 * 1024 * 1024;
const SETUP_HINT = 'Run "bun run setup" in the repo root, then start the receiver again.';
export const PARTNER = /^[A-Za-z0-9_.-]{1,40}$/;
export const SAMPLE_NAME = /^[a-z0-9][a-z0-9-]{0,62}\.xml$/;

/** The settings of the receiver's IDoc endpoint (see sap-tests/idoc/server.mts). */
const ENDPOINT_SETTINGS = [
	'IDOC_HOST',
	'IDOC_PORT',
	'IDOC_TLS_CERT',
	'IDOC_TLS_KEY',
	'IDOC_TLS_CA',
	'IDOC_TLS_CLIENT_FINGERPRINT',
	'IDOC_USER',
	'IDOC_PASSWORD'
];
/** The settings of each SAP system IDocs are sent into: IDOC_S4_URL, IDOC_EWM_URL and so on. */
const SAP_SETTINGS = IDOC_SAP_SYSTEMS.flatMap((system) =>
	[
		'URL',
		'CLIENT',
		'SERVICE',
		'USER',
		'PASSWORD',
		'TLS_CERT',
		'TLS_KEY',
		'TLS_CA',
		'TIMEOUT_MS'
	].map((name) => `IDOC_${system.toUpperCase()}_${name}`)
);
/** The receiver's settings by name, an empty value for one not set. */
type ReceiverSettings = Record<string, string>;

/**
 * The receiver's settings. Those of the Settings page (each SAP system's address, client, user and password) as
 * a run gets them: saved there, else the app's environment, else the test project's environment file, and without
 * a login kept for another address. The others from the app's environment or else that file (the environment
 * wins, as it does for Bun). Read once per start and handed to the receiver as they are, so the page shows and
 * uses the settings the receiver really has.
 */
async function receiverSettings(): Promise<ReceiverSettings> {
	const resolved = await readTestEnv();
	const onSettingsPage = new Set(settingNames());
	const value = (name: string) =>
		(onSettingsPage.has(name) ? resolved[name] : (process.env[name] ?? resolved[name])) ?? '';
	const settings = Object.fromEntries(
		[...ENDPOINT_SETTINGS, ...SAP_SETTINGS].map((name) => [name, value(name)])
	);
	// A stand-in for each SAP system without an address, so sending can be tried without SAP. IDOC_FAKE_SAP=0
	// turns that off.
	settings.IDOC_FAKE_SAP = value('IDOC_FAKE_SAP') === '0' ? '' : '1';
	return settings;
}

type Running = {
	proc: ChildProcess;
	/** The settings it was started with. */
	settings: ReceiverSettings;
	controlUrl: string;
	idocUrl: string;
	/** Made up for this start and handed to the receiver: only this app and the tests it runs can use its
	 * control API. */
	token: string;
	startedAt: string;
	stopping: boolean;
};

let running: Running | null = null;
let starting = false;
let lastError: string | undefined;

// The receiver belongs to the app that started it: it must not keep its port open after the app is gone.
process.once('exit', () => {
	running?.proc.kill('SIGTERM');
});

/** A receiver run elsewhere (on the cluster): the app watches and controls it, but doesn't start it. */
function externalUrl(): string | undefined {
	return process.env.IDOC_HUB_URL?.replace(/\/+$/, '') || undefined;
}

export function idocStatus(): IdocStatus {
	if (externalUrl()) return { running: true, external: true };
	if (!running) return { running: false, external: false, error: lastError };
	return { running: true, external: false, startedAt: running.startedAt };
}

/**
 * What tests started by the app need to reach the receiver the app started: the idocInbox fixture reads these.
 * Empty when it runs elsewhere (then IDOC_HUB_URL is set for the app and the tests alike) or not at all.
 */
export function idocTestEnv(): Record<string, string> {
	if (externalUrl() || !running) return {};
	return { IDOC_HUB_URL: running.controlUrl, IDOC_HUB_TOKEN: running.token };
}

/** Bun runs the receiver's TypeScript directly; the app itself runs on Bun, so it is always there. */
function bunBinary(): string {
	return process.versions.bun ? process.execPath : 'bun';
}

/**
 * Starts the receiver and resolves when its control API answers. The IDoc endpoint takes its settings from the
 * app's environment or sap-tests/.env (IDOC_HOST, IDOC_PORT, IDOC_TLS_*, IDOC_USER, IDOC_PASSWORD; see
 * sap-tests/idoc/server.mts), and refuses to start on settings that would open it to the network unprotected. The control API always stays on
 * this computer, with a token made up for this start.
 */
export async function startReceiver(): Promise<void> {
	// Starting takes a moment, and `running` is only set once the receiver answers. Without this, two requests in
	// that moment would each start one, and the first could never be stopped.
	if (starting) throw new Error('The receiver is already starting.');
	starting = true;
	try {
		await launch();
	} finally {
		starting = false;
	}
}

async function launch(): Promise<void> {
	if (externalUrl()) throw new Error('The receiver is managed elsewhere (IDOC_HUB_URL).');
	if (running) throw new Error('The receiver is already running.');
	const missing = missingPackages(PACKAGES_DIR, importedPackages(IDOC_DIR));
	if (missing.length > 0)
		throw new Error(
			`The receiver needs ${missing.join(', ')} in ${PACKAGES_DIR}, which ${missing.length === 1 ? 'is' : 'are'} not installed. ${SETUP_HINT}`
		);
	lastError = undefined;
	const token = randomBytes(24).toString('hex');
	const settings = await receiverSettings();
	// --no-env-file: Bun would otherwise read sap-tests/.env itself, and could add settings the app doesn't know of.
	const proc = spawn(bunBinary(), ['--no-env-file', resolve(IDOC_DIR, 'server.mts')], {
		cwd: TESTS_ROOT,
		env: childEnv({
			...settings,
			IDOC_CONTROL_HOST: '127.0.0.1',
			IDOC_CONTROL_PORT: '0',
			IDOC_CONTROL_TOKEN: token
		}),
		stdio: ['ignore', 'pipe', 'pipe']
	});
	const output: string[] = [];
	const urls = await new Promise<{ idocUrl: string; controlUrl: string }>((done, failed) => {
		const timer = setTimeout(() => {
			proc.kill('SIGTERM');
			failed(new Error(`The receiver did not start within ${START_TIMEOUT_MS / 1000} s.`));
		}, START_TIMEOUT_MS);
		const onLine = (line: string) => {
			output.push(line);
			if (output.length > 30) output.shift();
			if (!line.startsWith(READY)) return;
			const ready = z
				.object({ idocUrl: z.url(), controlUrl: z.url() })
				.safeParse(JSON.parse(line.slice(READY.length)));
			if (!ready.success) return;
			clearTimeout(timer);
			done(ready.data);
		};
		const lines = lineSplitter(onLine);
		proc.stdout.setEncoding('utf8').on('data', (chunk: string) => {
			lines.push(chunk);
		});
		proc.stderr.setEncoding('utf8').on('data', (chunk: string) => {
			lines.push(chunk);
		});
		proc.once('error', (error) => {
			clearTimeout(timer);
			failed(new Error(`Could not start the receiver: ${error.message}`));
		});
		proc.once('exit', (code) => {
			clearTimeout(timer);
			const text = output.join('\n');
			const hint = /Cannot find (package|module)/.test(text) ? `\n${SETUP_HINT}` : '';
			failed(new Error(`The receiver stopped while starting (exit code ${code}):\n${text}${hint}`));
		});
	}).catch((error: unknown) => {
		lastError = error instanceof Error ? error.message : String(error);
		throw error;
	});
	const current: Running = {
		proc,
		settings,
		...urls,
		token,
		startedAt: new Date().toISOString(),
		stopping: false
	};
	running = current;
	proc.once('exit', (code) => {
		if (running !== current) return;
		running = null;
		if (!current.stopping) lastError = `The receiver stopped unexpectedly (exit code ${code}).`;
	});
}

export function stopReceiver(): boolean {
	if (!running) return false;
	running.stopping = true;
	running.proc.kill('SIGTERM');
	return true;
}

function baseUrl(): string {
	const url = externalUrl() ?? running?.controlUrl;
	if (!url) throw new Error('The receiver is not running.');
	return url;
}

async function request(path: string, init?: RequestInit): Promise<Response> {
	// The token of the receiver this app started, or the one set for a receiver run elsewhere.
	const token = externalUrl() ? process.env.IDOC_HUB_TOKEN : running?.token;
	const headers = new Headers(init?.headers);
	headers.set('content-type', 'application/json');
	if (token) headers.set('authorization', `Bearer ${token}`);
	const response = await fetch(baseUrl() + path, { ...init, headers });
	if (!response.ok) {
		const body: unknown = await response.json().catch(() => null);
		const message = z.object({ error: z.string() }).safeParse(body);
		throw new Error(
			message.success ? message.data.error : `The receiver answered ${response.status}.`
		);
	}
	return response;
}

async function call<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
	return schema.parse(await (await request(path, init)).json());
}

/** Sets how the receiver answers a partner's IDocs, for everyone using it; `null` goes back to accept. */
export async function setPartnerReply(partner: string, reply: IdocReply | null): Promise<void> {
	const path = `/replies/${encodeURIComponent(partner)}`;
	if (reply) await call(path, z.unknown(), { method: 'PUT', body: JSON.stringify(reply) });
	else await call(path, z.unknown(), { method: 'DELETE' });
}

export async function clearInbox(): Promise<void> {
	await call('/idocs', z.unknown(), { method: 'DELETE' });
}

/** The request an IDoc came in, as text in the encoding it was sent in; cut off beyond 2 MB. */
export async function rawRequest(seq: number): Promise<{ text: string; cut: boolean }> {
	const response = await request(`/idocs/${seq}/raw`);
	const charset = /charset=([A-Za-z0-9._-]+)/.exec(response.headers.get('content-type') ?? '')?.[1];
	const bytes = new Uint8Array(await response.arrayBuffer());
	let decoder: TextDecoder;
	try {
		decoder = new TextDecoder(charset ?? 'utf-8');
	} catch {
		decoder = new TextDecoder('utf-8');
	}
	return { text: decoder.decode(bytes.subarray(0, RAW_SHOWN)), cut: bytes.length > RAW_SHOWN };
}

/** The sample IDocs in sap-tests/idoc/samples, described by the first sentence of their leading comment. */
export function listSamples(): IdocSample[] {
	if (!existsSync(SAMPLES_DIR)) return [];
	return readdirSync(SAMPLES_DIR)
		.filter((file) => SAMPLE_NAME.test(file))
		.map((name) => {
			const comment = /<!--\s*([^]*?)-->/.exec(
				readFileSync(resolve(SAMPLES_DIR, name), 'utf8')
			)?.[1];
			const first = comment
				?.split(/(?<=\.)\s|:\s/)[0]
				?.replaceAll(/\s+/g, ' ')
				.trim();
			return first ? { name, description: first } : { name };
		})
		.toSorted((a, b) => a.name.localeCompare(b.name));
}

/** Only to a receiver this app started on this computer without TLS: anything else needs SAP or a real login. */
function sampleTarget(): string | undefined {
	if (externalUrl() || !running) return undefined;
	const { protocol, hostname } = new URL(running.idocUrl);
	const local = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
	return protocol === 'http:' && local ? running.idocUrl : undefined;
}

/** Posts a sample IDoc to the receiver as SAP's XML HTTP port would. Returns the receiver's answer. */
export async function sendSample(name: string, partner: string): Promise<IdocSampleAnswer> {
	const target = sampleTarget();
	if (!target)
		throw new Error(
			'Samples can only be sent to a receiver this app started on this computer without HTTPS.'
		);
	if (!listSamples().some((sample) => sample.name === name))
		throw new Error(`There is no sample "${name}".`);
	if (!PARTNER.test(partner)) throw new Error(`"${partner}" is not a partner name.`);
	const headers = new Headers({ 'content-type': 'text/xml' });
	const { IDOC_USER: user, IDOC_PASSWORD: password } = running?.settings ?? {};
	if (user && password)
		headers.set('authorization', `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`);
	const response = await fetch(`${target}/idoc/${encodeURIComponent(partner)}`, {
		method: 'POST',
		headers,
		body: readFileSync(resolve(SAMPLES_DIR, name))
	});
	const body = (await response.text()).slice(0, 2000);
	if (response.ok) return { status: response.status, body };
	const fault = /<faultstring>([^<]*)<\/faultstring>/.exec(body)?.[1];
	return { status: response.status, reason: fault ?? body, body };
}

/**
 * Sends a sample IDoc into an SAP system through the receiver, in CPI's place: S/4HANA or EWM, as the receiver was
 * started with them (IDOC_S4_URL, IDOC_EWM_URL, or a stand-in for one without an address). Returns the send with
 * SAP's answer; it also appears in the list of sends.
 */
export function sendSampleToSap(name: string, to: IdocSapSystem): Promise<SentIdocs> {
	if (!listSamples().some((sample) => sample.name === name))
		return Promise.reject(new Error(`There is no sample "${name}".`));
	return call('/send', SentIdocsSchema, {
		method: 'POST',
		body: JSON.stringify({
			xml: readFileSync(resolve(SAMPLES_DIR, name), 'utf8'),
			to,
			by: 'person'
		})
	});
}

export async function clearSent(): Promise<void> {
	await call('/sent', z.unknown(), { method: 'DELETE' });
}

/** How SAP reaches the receiver. The login is known only for one this app started. */
function endpointOf(idocUrl: string): IdocEndpoint {
	const https = idocUrl.startsWith('https:');
	const settings = running?.settings;
	if (externalUrl() || !settings) return { url: idocUrl, https, login: 'none' };
	const user = Boolean(settings.IDOC_USER && settings.IDOC_PASSWORD);
	const certificate = https && Boolean(settings.IDOC_TLS_CA);
	const login =
		user && certificate
			? 'user-and-certificate'
			: user
				? 'user'
				: certificate
					? 'certificate'
					: 'none';
	return { url: idocUrl, https, login };
}

const sleep = (ms: number) =>
	new Promise<void>((done) => {
		setTimeout(done, ms);
	});

/**
 * Live view for the Mock IDoc page: receiver status, the address SAP posts to, the newest IDocs, the replies per
 * partner and the refused requests. Polls the receiver once a second and yields only when something changed.
 */
export async function* watchIdoc(): AsyncGenerator<IdocSnapshot, void, void> {
	let instance: string | undefined;
	let endpoint: IdocEndpoint | undefined;
	let sap: IdocSapTarget[] = [];
	let idocs: ReceivedIdoc[] = [];
	let cursor = 0;
	let last = '';
	for (;;) {
		const status = idocStatus();
		let snapshot: IdocSnapshot = {
			status,
			idocs: [],
			replies: {},
			failures: [],
			canSendSamples: false,
			sap: [],
			sent: []
		};
		if (status.running) {
			try {
				// Sequential on purpose: one receiver, a few small requests per poll.
				// oxlint-disable-next-line no-await-in-loop
				const info = await call('/info', IdocInfoSchema);
				if (info.instance !== instance) {
					// Started again (or another receiver): its numbering begins anew.
					instance = info.instance;
					endpoint = endpointOf(info.idocUrl);
					sap = info.sap;
					idocs = [];
					cursor = 0;
				}
				// oxlint-disable-next-line no-await-in-loop
				const [list, replies, failures, sent] = await Promise.all([
					call(`/idocs?after=${cursor}&limit=${KEEP}`, IdocListSchema),
					call('/replies', z.record(z.string(), IdocReplyInEffectSchema)),
					call('/failures', z.array(IdocFailureSchema)),
					sap.length > 0 ? call('/sent', z.array(SentIdocsSchema)) : Promise.resolve([])
				]);
				// oxlint-disable-next-line no-await-in-loop
				idocs = [...(await refreshPending(idocs)), ...list.idocs].slice(-KEEP);
				cursor = list.idocs.at(-1)?.seq ?? cursor;
				// oxlint-disable-next-line no-await-in-loop
				idocs = await keepPresent(idocs);
				snapshot = {
					status,
					endpoint,
					idocs,
					replies,
					failures: failures.slice(-50),
					canSendSamples: sampleTarget() !== undefined,
					sap,
					sent: sent.slice(-KEEP_SENT)
				};
			} catch (error) {
				snapshot = {
					...snapshot,
					status: { ...status, error: error instanceof Error ? error.message : String(error) },
					endpoint,
					idocs,
					sap
				};
			}
		} else {
			instance = undefined;
			idocs = [];
			cursor = 0;
		}
		const text = JSON.stringify(snapshot);
		if (text !== last) {
			last = text;
			yield snapshot;
		}
		// oxlint-disable-next-line no-await-in-loop
		await sleep(1000);
	}
}

/**
 * Fetches again the IDocs whose slow answer was still on its way: whether SAP waited for it (accepted) or hung up
 * (not accepted) is only known once it has gone out. Later polls only ask for newer IDocs, so this is the only
 * way the page learns it.
 */
function refreshPending(idocs: ReceivedIdoc[]): Promise<ReceivedIdoc[]> {
	if (idocs.every((idoc) => idoc.answered)) return Promise.resolve(idocs);
	return Promise.all(
		idocs.map(async (idoc) => {
			if (idoc.answered) return idoc;
			try {
				return await call(`/idocs/${idoc.seq}`, ReceivedIdocSchema);
			} catch {
				// Gone meanwhile (cleared); keepPresent drops it.
				return idoc;
			}
		})
	);
}

/**
 * Drops IDocs the receiver no longer holds. It only ever lets go of its oldest ones (beyond its limit) or of all
 * of them (cleared from the page, by a test or another person), so its oldest held IDoc is the boundary.
 */
async function keepPresent(idocs: ReceivedIdoc[]): Promise<ReceivedIdoc[]> {
	if (idocs.length === 0) return idocs;
	const { idocs: oldest } = await call('/idocs?after=0&limit=1', IdocListSchema);
	const from = oldest[0]?.seq;
	return from === undefined ? [] : idocs.filter((idoc) => idoc.seq >= from);
}
