import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { z } from 'zod';
import { APP_ROOT, DATA_DIR, toPosix } from './paths.js';

/**
 * The test code the healer wrote that no person has read yet. Until a person runs the repair from
 * its run page ("Run the repaired test", which counts as their review) or discards it, the app runs
 * no test code: the healer's test tools are refused, and so are new healer sessions and runs. Code
 * the healer writes would run as the app's user with the test users' passwords.
 *
 * One record for the app, outside the run folders, so that no retention rule removes it. A file
 * counts while it holds what the healer wrote: one a person changed since, or that is as it was
 * before, no longer does. Contents are kept as hashes.
 */
const RECORD = join(DATA_DIR, 'healer-unreviewed.json');

const entrySchema = z.object({
	/** The file before the healer's first change; null when it did not exist. */
	before: z.string().nullable(),
	/** After its last change; missing while a change is in progress. */
	healer: z.string().nullable().optional()
});
const recordSchema = z.object({
	runId: z.string(),
	testId: z.string(),
	title: z.string(),
	files: z.record(z.string(), entrySchema)
});
type ReviewRecord = z.infer<typeof recordSchema>;
export type RepairOwner = { runId: string; testId: string; title: string };
/** A repair nobody has read, with its files relative to the repository root. */
export type Unreviewed = RepairOwner & { files: string[] };

const hash = (abs: string) =>
	existsSync(abs) ? createHash('sha256').update(readFileSync(abs)).digest('hex') : null;

/** The record, or null when there is none. Throws when it cannot be read: nothing runs then. */
function read(): ReviewRecord | null {
	if (!existsSync(RECORD)) return null;
	return recordSchema.parse(JSON.parse(readFileSync(RECORD, 'utf8')));
}

function write(record: ReviewRecord) {
	mkdirSync(dirname(RECORD), { recursive: true });
	const temp = `${RECORD}.${process.pid}.tmp`;
	writeFileSync(temp, JSON.stringify(record, null, '\t'));
	renameSync(temp, RECORD);
}

/**
 * The files of the record that still hold what the healer wrote. Every entry counts, wherever its
 * path points: the record is the app's own, and one left out would let code run unread.
 */
function pendingFiles(record: ReviewRecord): string[] {
	return Object.entries(record.files)
		.filter(([abs, entry]) => {
			const now = hash(abs);
			return now !== entry.before && (entry.healer === undefined || now === entry.healer);
		})
		.map(([abs]) => toPosix(relative(APP_ROOT, abs)));
}

/** The repair whose code nobody has read, or null. Throws when the record cannot be read. */
export function unreviewed(): Unreviewed | null {
	const record = read();
	if (!record) return null;
	const files = pendingFiles(record);
	if (files.length === 0) return null;
	const { runId, testId, title } = record;
	return { runId, testId, title, files };
}

/**
 * Why test code may not run now, or undefined when it may: a repair nobody has read, or a record
 * that cannot be read.
 */
export function reviewBlock(except?: { runId: string; testId: string }): string | undefined {
	let open: Unreviewed | null;
	try {
		open = unreviewed();
	} catch (e) {
		return `The record of the healer's unread repairs (${RECORD}) cannot be read, so no test code runs: ${e instanceof Error ? e.message : String(e)}`;
	}
	// The repair a person has just read, while its run starts.
	if (!open || (open.runId === except?.runId && open.testId === except.testId)) return undefined;
	return `The healer's repair of "${open.title}" (${open.files.join(', ')}) has not been read yet. Open its run (${open.runId}), read the diff and press "Run the repaired test", or discard the repair; until then no test runs.`;
}

/** Before the healer changes a file (the gate of its tools): on disk before the change. */
export function beforeChange(owner: RepairOwner, abs: string) {
	let record = read();
	// A new session starts only when nothing is left unread, so an older record is settled.
	if (!record || record.runId !== owner.runId || record.testId !== owner.testId)
		record = { ...owner, files: {} };
	// The same file under another spelling of its path (letter case on macOS, a symbolic link)
	// goes on its first entry, so that its `before` stays what the file held before the healer.
	const key = Object.keys(record.files).find((k) => sameFile(k, abs)) ?? abs;
	const known = record.files[key];
	if (known) delete known.healer;
	else record.files[key] = { before: hash(abs) };
	write(record);
}

/** Whether two paths name one existing file. */
function sameFile(a: string, b: string): boolean {
	if (a === b) return true;
	try {
		const [x, y] = [statSync(a), statSync(b)];
		return x.dev === y.dev && x.ino === y.ino;
	} catch {
		return false;
	}
}

/** After the healer's change: what the files hold now is what it wrote. */
export function afterChange() {
	const record = read();
	if (!record) return;
	for (const [abs, entry] of Object.entries(record.files))
		if (entry.healer === undefined) entry.healer = hash(abs);
	write(record);
}

/** A person read the repair of this test and ran it, or discarded it. */
export function settleRepair(runId: string, testId: string) {
	// A record that cannot be read stays: which repair it holds is unknown. reviewBlock names it,
	// for a person to look at and remove.
	let record: ReviewRecord | null;
	try {
		record = read();
	} catch {
		return;
	}
	if (record?.runId === runId && record.testId === testId) rmSync(RECORD, { force: true });
}
