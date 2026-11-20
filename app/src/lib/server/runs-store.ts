import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNS_DIR, within } from './paths.js';
import type { RunMeta, RunState, StabilityRow } from '#lib/shared/types.js';

/** Finished runs never change, so their parsed state is cached by id. */
const finished = new Map<string, RunState>();

export function rememberFinished(id: string) {
	finished.delete(id);
}

function readJson<T>(path: string): T | null {
	try {
		return JSON.parse(readFileSync(path, 'utf8')) as T;
	} catch {
		return null;
	}
}

export function listRuns(): RunMeta[] {
	if (!existsSync(RUNS_DIR)) return [];
	return readdirSync(RUNS_DIR)
		.map((id) => readJson<RunMeta>(join(RUNS_DIR, id, 'meta.json')))
		.filter((m): m is RunMeta => m !== null)
		.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function readRunState(id: string): RunState | null {
	const dir = within(RUNS_DIR, id);
	if (!dir) return null;
	const hit = finished.get(id);
	if (hit) return hit;
	const state = readJson<RunState>(join(dir, 'state.json'));
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
	for (const meta of listRuns().reverse()) {
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
		let streak = 0;
		for (let i = row.history.length - 1; i >= 0 && row.history[i].status === 'passed'; i--)
			streak++;
		row.streak = streak;
	}
	return [...rows.values()].sort((a, b) => a.key.localeCompare(b.key));
}
