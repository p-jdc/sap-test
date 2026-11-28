import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	lstatSync,
	statSync
} from 'node:fs';
import { devNull } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DATA_DIR, toPosix, within } from './paths.js';
import { decodeUftFile, UFT_FILE, UFT_LIMITS, type UftFile } from '#lib/shared/uft.js';

/**
 * Where the UFT tests come from: a folder the person uploads from their computer, kept for a day
 * under the app's data folder, or a Git repository, checked out without the binary files of the
 * tests (sparse checkout of the text files only).
 */

export class UftSourceError extends Error {}

const UFT_DIR = () => resolve(DATA_DIR, 'uft');
const UPLOADS_DIR = () => resolve(UFT_DIR(), 'uploads');
const GIT_DIR = () => resolve(UFT_DIR(), 'git');

/** An upload is kept this long after it started, then removed with the next upload. */
const UPLOAD_KEPT_MS = 24 * 60 * 60 * 1000;
/** Uploads kept at most: a new one removes the oldest beyond, so uploads cannot fill the disk. */
const UPLOADS_KEPT = 5;
/** Bytes one upload may hold: the importer reads at most UFT_LIMITS.totalChars characters. */
const UPLOAD_BYTES = 60_000_000;

const UPLOAD_ID = /^[0-9a-f-]{36}$/;

/** Reads the files of a folder that the importer reads (UFT_FILE), within the limits. */
export function readFolder(root: string): UftFile[] {
	if (!existsSync(root)) return [];
	const files: UftFile[] = [];
	let total = 0;
	for (const entry of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
		const path = toPosix(entry);
		if (path.split('/').includes('.git') || !UFT_FILE.test(path)) continue;
		const full = join(root, entry);
		// Regular files only: a symbolic link (from a repository, say) could point anywhere on the
		// server, and its target would end up in the test files.
		if (!lstatSync(full).isFile()) continue;
		const text = decodeUftFile(readFileSync(full));
		if (text.length > UFT_LIMITS.fileChars) continue;
		total += text.length;
		if (files.length >= UFT_LIMITS.files || total > UFT_LIMITS.totalChars)
			throw new UftSourceError(
				`The folder holds more than the importer reads at once (${UFT_LIMITS.files} files, ${UFT_LIMITS.totalChars / 1_000_000} million characters). Import a part of it.`
			);
		files.push({ path, text });
	}
	return files;
}

// ---- Upload -----------------------------------------------------------------------------------

/** Removes uploads older than a day, and the oldest beyond the newest UPLOADS_KEPT - 1. */
function removeOldUploads(now: number) {
	if (!existsSync(UPLOADS_DIR())) return;
	const uploads = readdirSync(UPLOADS_DIR())
		.map((id) => {
			const dir = join(UPLOADS_DIR(), id);
			try {
				return { dir, time: statSync(dir).mtimeMs };
			} catch {
				// Removed meanwhile.
				return null;
			}
		})
		.filter((u) => u !== null)
		.toSorted((a, b) => b.time - a.time);
	uploads.forEach((upload, i) => {
		if (i >= UPLOADS_KEPT - 1 || now - upload.time > UPLOAD_KEPT_MS)
			rmSync(upload.dir, { recursive: true, force: true });
	});
}

/** Starts an upload: a new, empty folder. */
export function startUpload(now = Date.now()): string {
	removeOldUploads(now);
	const id = randomUUID();
	mkdirSync(join(UPLOADS_DIR(), id), { recursive: true });
	return id;
}

function uploadDir(id: string): string {
	const dir = UPLOAD_ID.test(id) ? join(UPLOADS_DIR(), id) : undefined;
	if (!dir || !existsSync(dir))
		throw new UftSourceError('This upload is no longer there. Choose the folder again.');
	return dir;
}

function uploadSize(dir: string): { files: number; chars: number } {
	let files = 0;
	let chars = 0;
	for (const entry of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
		const full = join(dir, entry);
		const s = lstatSync(full);
		if (!s.isFile()) continue;
		files++;
		chars += s.size;
	}
	return { files, chars };
}

/**
 * Adds a part of the uploaded files: each `text` is appended to its file, so that a file larger
 * than one request comes in several parts. Paths are relative to the folder that was chosen.
 */
export function addToUpload(id: string, parts: { path: string; text: string }[]) {
	const dir = uploadDir(id);
	const size = uploadSize(dir);
	for (const part of parts) {
		const path = toPosix(part.path).replace(/^\/+/, '');
		if (!UFT_FILE.test(path)) continue;
		const full = within(dir, path);
		if (!full || full === dir)
			throw new UftSourceError(`Not a file inside the upload: ${part.path}`);
		if (!existsSync(full)) size.files++;
		size.chars += Buffer.byteLength(part.text);
		if (size.files > UFT_LIMITS.files || size.chars > UPLOAD_BYTES)
			throw new UftSourceError(
				`The folder holds more than the importer reads at once (${UFT_LIMITS.files} files). Upload a part of it.`
			);
		mkdirSync(dirname(full), { recursive: true });
		appendFileSync(full, part.text);
	}
}

export function uploadFiles(id: string): UftFile[] {
	return readFolder(uploadDir(id));
}

// ---- Git --------------------------------------------------------------------------------------

export interface GitConfig {
	url: string;
	branch?: string;
	user?: string;
	token?: string;
}

/** What is wrong with a repository address, or undefined. */
export function gitUrlProblem(value: string, allowLocal = false): string | undefined {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return 'UFT_GIT_URL must be the HTTPS address of the repository, e.g. https://github.com/org/uft-tests.git.';
	}
	if (allowLocal && url.protocol === 'file:') return undefined;
	if (url.protocol !== 'https:')
		return 'UFT_GIT_URL must start with https://: the access token would otherwise cross the network unencrypted.';
	if (url.username || url.password)
		return 'UFT_GIT_URL must not hold a user or token: put them into UFT_GIT_USER and UFT_GIT_TOKEN.';
	return undefined;
}

/** What the files of the checkout are, by their endings: the text files of the tests only. */
const SPARSE = ['*.mts', '*.qfl', '*.vbs', '*.xml', '*.usr'];

function git(args: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<string> {
	return new Promise((done, fail) => {
		execFile(
			'git',
			args,
			{ env, cwd, timeout: 180_000, maxBuffer: 4_000_000 },
			(error, stdout, stderr) => {
				if (!error) {
					done(stdout.trim());
					return;
				}
				if ('code' in error && error.code === 'ENOENT') {
					fail(
						new UftSourceError(
							'Git is not installed on the server: the app needs the git command on its PATH.'
						)
					);
					return;
				}
				const detail = stderr
					.split('\n')
					.map((l) => l.trim())
					.filter((l) => l && !l.startsWith('hint:'))
					.slice(-3)
					.join(' ');
				fail(new UftSourceError(`Git: ${detail || error.message}`));
			}
		);
	});
}

/**
 * The environment of git: no user or system configuration (no credential helper that asks, no
 * other settings of this computer), no prompts, only HTTPS, and the token as a header that only
 * this process sees (not in its arguments, which the process list shows).
 */
function gitEnv(cfg: GitConfig, allowLocal: boolean): NodeJS.ProcessEnv {
	// No symbolic links in the checkout: a committed link would be checked out as a plain file
	// holding the link's text (readFolder skips links all the same).
	const config: [string, string][] = [
		['credential.helper', ''],
		['core.symlinks', 'false']
	];
	if (cfg.token) {
		const basic = Buffer.from(`${cfg.user || 'git'}:${cfg.token}`).toString('base64');
		config.push(['http.extraHeader', `Authorization: Basic ${basic}`]);
	}
	return {
		PATH: process.env.PATH,
		HOME: process.env.HOME,
		GIT_TERMINAL_PROMPT: '0',
		GIT_ASKPASS: '',
		SSH_ASKPASS: '',
		GIT_CONFIG_NOSYSTEM: '1',
		GIT_CONFIG_GLOBAL: devNull,
		GIT_ALLOW_PROTOCOL: allowLocal ? 'https:file' : 'https',
		GIT_CONFIG_COUNT: String(config.length),
		...Object.fromEntries(
			config.flatMap(([k, v], i) => [
				[`GIT_CONFIG_KEY_${i}`, k],
				[`GIT_CONFIG_VALUE_${i}`, v]
			])
		)
	};
}

let fetching: Promise<unknown> = Promise.resolve(null);

/**
 * Checks the repository out anew; one read at a time, so that two (from two people, or two tabs)
 * never swap the checkout folder at once.
 */
export function fetchRepository(
	cfg: GitConfig,
	allowLocal = false
): Promise<{ commit: string; branch: string }> {
	const next = fetching.then(
		() => checkout(cfg, allowLocal),
		() => checkout(cfg, allowLocal)
	);
	fetching = next.catch(() => null);
	return next;
}

/**
 * Checks the repository out: shallow, only the text files of the tests, into a new folder that then
 * replaces the one before. Returns the commit that was read.
 */
async function checkout(
	cfg: GitConfig,
	allowLocal = false
): Promise<{ commit: string; branch: string }> {
	const problem = gitUrlProblem(cfg.url, allowLocal);
	if (problem) throw new UftSourceError(problem);
	const env = gitEnv(cfg, allowLocal);
	mkdirSync(UFT_DIR(), { recursive: true });
	const next = join(UFT_DIR(), `git-${randomUUID()}`);
	try {
		await git(
			[
				'clone',
				'--depth=1',
				'--filter=blob:none',
				'--no-checkout',
				'--single-branch',
				...(cfg.branch ? ['--branch', cfg.branch] : []),
				'--',
				cfg.url,
				next
			],
			env
		);
		await git(['sparse-checkout', 'set', '--no-cone', ...SPARSE], env, next);
		await git(['checkout'], env, next);
		const commit = await git(['rev-parse', 'HEAD'], env, next);
		const branch = cfg.branch || (await git(['rev-parse', '--abbrev-ref', 'HEAD'], env, next));
		rmSync(GIT_DIR(), { recursive: true, force: true });
		renameSync(next, GIT_DIR());
		return { commit, branch };
	} finally {
		rmSync(next, { recursive: true, force: true });
	}
}

/** The files of the last checkout, and its commit; undefined before the first one. */
export async function checkoutFiles(): Promise<{ files: UftFile[]; commit: string } | undefined> {
	// Not while a read of the repository replaces the checkout folder.
	await fetching;
	if (!existsSync(join(GIT_DIR(), '.git'))) return undefined;
	const commit = await git(
		['rev-parse', 'HEAD'],
		{ PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull },
		GIT_DIR()
	);
	return { files: readFolder(GIT_DIR()), commit };
}
