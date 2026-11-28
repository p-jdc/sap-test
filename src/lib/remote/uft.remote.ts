import { command, query } from '$app/server';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { recordActivity } from '#lib/server/auth/access.js';
import { readTestEnv } from '#lib/server/env-file.js';
import { PILOT_STREAK } from '#lib/server/runs-store.js';
import { importFolders, importTests, scan } from '#lib/server/uft-import.js';
import {
	addToUpload,
	checkoutFiles,
	fetchRepository,
	gitUrlProblem,
	startUpload,
	uploadFiles,
	UftSourceError,
	type GitConfig
} from '#lib/server/uft-source.js';
import { getSpecs } from './specs.remote.js';
import type { UftFile } from '#lib/shared/uft.js';

/** A refusal of the importer (no such upload, Git failed, …) reaches the page as its message. */
async function act<T>(action: () => T | Promise<T>): Promise<T> {
	try {
		return await action();
	} catch (e) {
		if (e instanceof UftSourceError) error(409, e.message);
		throw e;
	}
}

async function gitConfig(): Promise<{ config?: GitConfig; missing: string[] }> {
	const env = await readTestEnv();
	const url = env.UFT_GIT_URL ?? '';
	if (!url) return { missing: ['UFT_GIT_URL'] };
	const config: GitConfig = { url };
	if (env.UFT_GIT_BRANCH) config.branch = env.UFT_GIT_BRANCH;
	if (env.UFT_GIT_USER) config.user = env.UFT_GIT_USER;
	if (env.UFT_GIT_TOKEN) config.token = env.UFT_GIT_TOKEN;
	return { config, missing: [] };
}

/** The repository without user or token, for the page: host and path, and the branch. */
function describeRepository(config: GitConfig): string {
	const url = new URL(config.url);
	return `${url.host}${url.pathname.replace(/\.git$/, '')}${config.branch ? `@${config.branch}` : ''}`;
}

/** Whether Git is set up, and the folders a translated test goes to. */
export const getUftSetup = query(async () => {
	const { config, missing } = await gitConfig();
	const problem = config ? gitUrlProblem(config.url) : undefined;
	return {
		git: {
			missing,
			...(problem ? { problem } : {}),
			...(config && !problem ? { repository: describeRepository(config) } : {})
		},
		folders: importFolders(),
		/** Passes in a row after which a UFT test can be retired: the pilot criterion of the Results page. */
		retireAfter: PILOT_STREAK
	};
});

const source = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('upload'), id: z.uuid() }),
	z.object({ kind: z.literal('git') })
]);
type Source = z.infer<typeof source>;

async function filesOf(from: Source): Promise<{ files: UftFile[]; origin: string } | undefined> {
	if (from.kind === 'upload') return { files: uploadFiles(from.id), origin: 'uploaded' };
	const checkout = await checkoutFiles();
	if (!checkout) return undefined;
	const { config } = await gitConfig();
	const where = config && !gitUrlProblem(config.url) ? describeRepository(config) : 'Git';
	return { files: checkout.files, origin: `${where}, commit ${checkout.commit.slice(0, 10)}` };
}

/** Starts an upload of a folder; the page then sends its files in parts. */
export const startUftUpload = command(() => act(() => ({ id: startUpload() })));

/** One part of an upload. Under the server's limit for one request (BODY_SIZE_LIMIT, 512 kB). */
export const addUftUpload = command(
	z.object({
		id: z.uuid(),
		parts: z
			.array(z.object({ path: z.string().min(1).max(1000), text: z.string().max(200_000) }))
			.min(1)
			.max(500)
	}),
	({ id, parts }) =>
		act(() => {
			addToUpload(id, parts);
			return { added: parts.length };
		})
);

/** Checks the repository out anew (only the text files of the tests). */
export const fetchUftRepository = command(() =>
	act(async () => {
		const { config, missing } = await gitConfig();
		if (!config)
			throw new UftSourceError(
				`Git is not set up yet: set ${missing.join(', ')} on the Settings page.`
			);
		const result = await fetchRepository(config);
		await recordActivity(
			'Read UFT tests from Git',
			`${describeRepository(config)} ${result.commit.slice(0, 10)}`
		);
		return result;
	})
);

/** The UFT tests of a source, what the import makes of each, and how far each imported one has come. */
export const scanUft = query(source, (from) =>
	act(async () => {
		const found = await filesOf(from);
		if (!found) return null;
		return scan(found.files, from.kind, found.origin);
	})
);

const folder = z.string().min(1).max(200).optional();

export const importUft = command(
	z.object({
		source,
		paths: z.array(z.string().max(1000)).min(1).max(200),
		replacePlans: z.boolean(),
		folders: z.object({ webgui: folder, fiori: folder }).optional()
	}),
	(input) =>
		act(async () => {
			const found = await filesOf(input.source);
			if (!found) throw new UftSourceError('Read the tests from Git first.');
			const folders: { webgui?: string; fiori?: string } = {};
			if (input.folders?.webgui) folders.webgui = input.folders.webgui;
			if (input.folders?.fiori) folders.fiori = input.folders.fiori;
			const results = await importTests(
				found.files,
				{ paths: [...new Set(input.paths)], replacePlans: input.replacePlans, folders },
				found.origin
			);
			await recordActivity('Imported tests from UFT', results.map((r) => r.name).join(', '));
			await getSpecs().refresh();
			await scanUft(input.source).refresh();
			return results;
		})
);
