import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNS_DIR, within } from './paths.js';
import type { RunMeta, RunState, StabilityRow } from '#lib/shared/types.js';

/** Finished runs never change, so their parsed state is cached by id. */
const finished = new Map<string, RunState>();

export function rememberFinished(id: string) {
	finished.delete(id);
}

/** meta.json / state.json are written by runner.ts in this app, so their shape is trusted. */
function readRunFile(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return null;
	}
}

function readMeta(path: string): RunMeta | null {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- own file, see readRunFile
	return readRunFile(path) as RunMeta | null;
}

function readState(path: string): RunState | null {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- own file, see readRunFile
	return readRunFile(path) as RunState | null;
}

export function listRuns(): RunMeta[] {
	if (!existsSync(RUNS_DIR)) return [];
	return readdirSync(RUNS_DIR)
		.map((id) => readMeta(join(RUNS_DIR, id, 'meta.json')))
		.filter((m): m is RunMeta => m !== null)
		.toSorted((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function readRunState(id: string): RunState | null {
	const dir = within(RUNS_DIR, id);
	if (!dir) return null;
	const hit = finished.get(id);
	if (hit) return hit;
	const state = readState(join(dir, 'state.json'));
	if (!state) return null;
	const log = existsSync(join(dir, 'output.log'))
		? readFileSync(join(dir, 'output.log'), 'utf8').split('\n').slice(-400)
		: [];
	const full = { ...state, log, hasReport: existsSync(join(dir, 'report/index.html')) };
	if (state.status !== 'running') finished.set(id, full);
	return full;
}

/** Pilot exit criterion (guide §4.8): ten consecutive passes per flow. */
export const PILOT_STREAK = 10;

export function stability(): StabilityRow[] {
	const rows = new Map<string, StabilityRow>();
	for (const meta of listRuns().toReversed()) {
		if (meta.status === 'running') continue;
		const state = readRunState(meta.id);
		for (const t of state?.tests ?? []) {
			if (!t.status || t.status === 'skipped') continue;
			const row = rows.get(t.key) ?? {
				key: t.key,
				file: t.file,
				title: t.title,
				history: [],
				streak: 0
			};
			row.history.push({ runId: meta.id, status: t.status });
			rows.set(t.key, row);
		}
	}
	for (const row of rows.values()) {
		row.lastStatus = row.history.at(-1)?.status;
		const lastNonPass = row.history.findLastIndex((h) => h.status !== 'passed');
		row.streak = row.history.length - 1 - lastNonPass;
	}
	return [...rows.values()].toSorted((a, b) => a.key.localeCompare(b.key));
}
