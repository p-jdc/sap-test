// The OData mock (sap-tests/odata/mock) as seen from the app: started as its own process, like the IDoc receiver
// and the Mock PLC, and reached only through its HTTP control API. The browser never talks to the mock's control
// API; the page goes through the remote functions in odata.remote.ts.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
	OdataAnswerSchema,
	OdataEntitySetsSchema,
	OdataInfoSchema,
	OdataRequestListSchema,
	OdataRequestSchema,
	OdataRowsSchema,
	type OdataAnswer,
	type OdataEntitySet,
	type OdataRequest,
	type OdataRequestSummary,
	type OdataRows,
	type OdataService,
	type OdataSnapshot,
	type OdataStatus
} from '#lib/shared/odata.js';
import { lineSplitter } from './lines.js';
import { importedPackages, missingPackages } from './mfs.js';
import { childEnv } from './node-cli.js';
import { PACKAGES_DIR, TESTS_ROOT } from './paths.js';

const MOCK_DIR = resolve(TESTS_ROOT, 'odata', 'mock');
/** Loaded with `require` in mock.mts, so the import scan doesn't see it. */
const MOCK_SERVER_PACKAGE = '@sap-ux/fe-mockserver-core';
const READY = 'ODATA_READY ';
const START_TIMEOUT_MS = 20_000;
/** Requests the page keeps; the mock itself keeps more. */
const KEEP = 200;
const SETUP_HINT = 'Run "bun run setup" in the repo root, then start the mock again.';
/** A service folder name or entity set name, as the page sends them. */
export const ODATA_NAME = /^[A-Za-z0-9_]{1,80}$/;

type Running = {
	proc: ChildProcess;
	odataUrl: string;
	controlUrl: string;
	/** Made up for this start and handed to the mock: only this app can use its control API. */
	token: string;
	startedAt: string;
	stopping: boolean;
	/** Whether the API tests this app starts call the mock. Off at every start: it is chosen on the page. */
	forTests: boolean;
};

let running: Running | null = null;
let starting = false;
let lastError: string | undefined;

// The mock belongs to the app that started it: it must not keep its ports open after the app is gone.
process.once('exit', () => {
	running?.proc.kill('SIGTERM');
});

export function odataStatus(): OdataStatus {
	if (!running) return { running: false, error: lastError };
	return { running: true, startedAt: running.startedAt };
}

/**
 * What tests started by the app need to call the mock instead of the system in the settings: the sapApi fixture
 * reads these. Empty unless the mock runs and the page chose to use it for tests. The mock takes any user and
 * password; these are only there because the fixture needs some.
 */
export function odataTestEnv(): Record<string, string> {
	if (!running?.forTests) return {};
	return {
		SAP_API_URL: running.odataUrl,
		SAP_API_USERNAME: 'mock',
		SAP_API_PASSWORD: 'mock',
		SAP_CLIENT: ''
	};
}

/** Points the API tests this app starts at the running mock, or back at the system in the settings. */
export function useOdataMockForTests(use: boolean): void {
	if (!running) throw new Error('The OData mock is not running.');
	running.forTests = use;
}

/** Bun runs the mock's TypeScript directly; the app itself runs on Bun, so it is always there. */
function bunBinary(): string {
	return process.versions.bun ? process.execPath : 'bun';
}

/**
 * Starts the mock and resolves when it is ready. Both its listeners take free ports on this computer: the mock
 * has no login, so it never listens beyond it.
 */
export async function startOdataMock(): Promise<void> {
	// Starting takes a moment, and `running` is only set once the mock answers. Without this, two requests in
	// that moment would each start one, and the first could never be stopped.
	if (starting) throw new Error('The OData mock is already starting.');
	starting = true;
	try {
		await launch();
	} finally {
		starting = false;
	}
}

async function launch(): Promise<void> {
	if (running) throw new Error('The OData mock is already running.');
	const missing = missingPackages(PACKAGES_DIR, [
		...importedPackages(MOCK_DIR),
		MOCK_SERVER_PACKAGE
	]);
	if (missing.length > 0)
		throw new Error(
			`The OData mock needs ${missing.join(', ')} in ${PACKAGES_DIR}, which ${missing.length === 1 ? 'is' : 'are'} not installed. ${SETUP_HINT}`
		);
	lastError = undefined;
	const token = randomBytes(24).toString('hex');
	// --no-env-file: Bun would otherwise read sap-tests/.env itself; the mock needs nothing from it.
	const proc = spawn(bunBinary(), ['--no-env-file', resolve(MOCK_DIR, 'server.mts')], {
		cwd: TESTS_ROOT,
		env: childEnv({ ODATA_MOCK_PORT: '0', ODATA_CONTROL_PORT: '0', ODATA_CONTROL_TOKEN: token }),
		stdio: ['ignore', 'pipe', 'pipe']
	});
	const output: string[] = [];
	const urls = await new Promise<{ odataUrl: string; controlUrl: string }>((done, failed) => {
		const timer = setTimeout(() => {
			proc.kill('SIGTERM');
			failed(new Error(`The OData mock did not start within ${START_TIMEOUT_MS / 1000} s.`));
		}, START_TIMEOUT_MS);
		const onLine = (line: string) => {
			output.push(line);
			if (output.length > 30) output.shift();
			if (!line.startsWith(READY)) return;
			const ready = z
				.object({ odataUrl: z.url(), controlUrl: z.url() })
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
			failed(new Error(`Could not start the OData mock: ${error.message}`));
		});
		proc.once('exit', (code) => {
			clearTimeout(timer);
			const text = output.join('\n');
			const hint = /Cannot find (package|module)/.test(text) ? `\n${SETUP_HINT}` : '';
			failed(
				new Error(`The OData mock stopped while starting (exit code ${code}):\n${text}${hint}`)
			);
		});
	}).catch((error: unknown) => {
		lastError = error instanceof Error ? error.message : String(error);
		throw error;
	});
	const current: Running = {
		proc,
		...urls,
		token,
		startedAt: new Date().toISOString(),
		stopping: false,
		forTests: false
	};
	running = current;
	proc.once('exit', (code) => {
		if (running !== current) return;
		running = null;
		if (!current.stopping) lastError = `The OData mock stopped unexpectedly (exit code ${code}).`;
	});
}

export function stopOdataMock(): boolean {
	if (!running) return false;
	running.stopping = true;
	running.proc.kill('SIGTERM');
	return true;
}

async function call<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
	if (!running) throw new Error('The OData mock is not running.');
	const headers = new Headers(init?.headers);
	headers.set('content-type', 'application/json');
	headers.set('authorization', `Bearer ${running.token}`);
	const response = await fetch(running.controlUrl + path, { ...init, headers });
	const body: unknown = await response.json().catch(() => null);
	if (!response.ok) {
		const message = z.object({ error: z.string() }).safeParse(body);
		throw new Error(
			message.success ? message.data.error : `The OData mock answered ${response.status}.`
		);
	}
	return schema.parse(body);
}

/** How the mock answers a service's requests, for everyone using it; `null` goes back to normal. */
export async function setOdataAnswer(service: string, answer: OdataAnswer | null): Promise<void> {
	const path = `/answers/${encodeURIComponent(service)}`;
	if (answer) await call(path, z.unknown(), { method: 'PUT', body: JSON.stringify(answer) });
	else await call(path, z.unknown(), { method: 'DELETE' });
}

export async function clearOdataRequests(): Promise<void> {
	await call('/requests', z.unknown(), { method: 'DELETE' });
}

/** Brings back the data of the files under sap-tests/odata/mock/data: what was written is gone. */
export async function resetOdataData(): Promise<void> {
	await call('/reset', z.unknown(), { method: 'POST', body: '{}' });
}

/** One logged request with its bodies. */
export function odataRequest(seq: number): Promise<OdataRequest> {
	return call(`/requests/${seq}`, OdataRequestSchema);
}

export function odataEntitySets(service: string): Promise<OdataEntitySet[]> {
	return call(`/services/${encodeURIComponent(service)}/sets`, OdataEntitySetsSchema);
}

export function odataRows(service: string, set: string, top: number): Promise<OdataRows> {
	return call(
		`/services/${encodeURIComponent(service)}/sets/${encodeURIComponent(set)}?top=${top}`,
		OdataRowsSchema
	);
}

const sleep = (ms: number) =>
	new Promise<void>((done) => {
		setTimeout(done, ms);
	});

/**
 * Live view for the Mock OData page: status, where it serves, the newest requests and the answers per service.
 * Polls the mock once a second and yields only when something changed.
 */
export async function* watchOdata(): AsyncGenerator<OdataSnapshot, void, void> {
	let instance: string | undefined;
	let odataUrl: string | undefined;
	let services: OdataService[] = [];
	let requests: OdataRequestSummary[] = [];
	let cursor = 0;
	let last = '';
	for (;;) {
		const status = odataStatus();
		let snapshot: OdataSnapshot = {
			status,
			services: [],
			requests: [],
			answers: {},
			forTests: false
		};
		if (status.running) {
			try {
				// oxlint-disable-next-line no-await-in-loop
				const info = await call('/info', OdataInfoSchema);
				if (info.instance !== instance) {
					// Started again: its numbering begins anew.
					instance = info.instance;
					odataUrl = info.odataUrl;
					services = info.services;
					requests = [];
					cursor = 0;
				}
				// oxlint-disable-next-line no-await-in-loop
				const [list, answers] = await Promise.all([
					call(`/requests?after=${cursor}&limit=${KEEP}`, OdataRequestListSchema),
					call('/answers', z.record(z.string(), OdataAnswerSchema))
				]);
				// Drops what the mock no longer holds: cleared (from this page or another) or let go beyond its limit.
				const { oldest } = list;
				requests = [...requests, ...list.requests]
					.filter((r) => oldest !== null && r.seq >= oldest)
					.slice(-KEEP);
				cursor = list.cursor;
				snapshot = {
					status,
					odataUrl,
					services,
					requests,
					answers,
					forTests: running?.forTests ?? false
				};
			} catch (error) {
				snapshot = {
					...snapshot,
					status: { ...status, error: error instanceof Error ? error.message : String(error) },
					odataUrl,
					services,
					requests
				};
			}
		} else {
			instance = undefined;
			requests = [];
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
