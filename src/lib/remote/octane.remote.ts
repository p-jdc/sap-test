import { command, query } from '$app/server';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { recordActivity } from '#lib/server/auth/access.js';
import { readTestEnv } from '#lib/server/env-file.js';
import { octaneConfig, PAGE_SIZE } from '#lib/server/octane.js';
import { OctaneError } from '#lib/server/octane-error.js';
import { importFolders, importOctane, searchOctane } from '#lib/server/octane-import.js';
import { MAX_IMPORT } from '#lib/shared/octane.js';
import { getSpecs } from './specs.remote.js';

/** Octane answered with an error, or cannot be reached: the page shows the message. */
function octaneFailure(e: unknown): never {
	if (e instanceof OctaneError) error(502, e.message);
	throw e;
}

/** Which Octane settings are missing, and the folders a test can be imported into. */
export const getOctaneSetup = query(async () => {
	const result = octaneConfig(await readTestEnv());
	return {
		missing: result.missing ?? [],
		problem: result.problem,
		server: result.config ? new URL(result.config.url).host : undefined,
		folders: importFolders(),
		pageSize: PAGE_SIZE
	};
});

export const searchOctaneTests = query(
	z.object({ text: z.string().max(200), offset: z.number().int().min(0).max(1_000_000) }),
	async ({ text, offset }) => {
		try {
			return await searchOctane(text, offset);
		} catch (e) {
			return octaneFailure(e);
		}
	}
);

export const importOctaneTests = command(
	z.object({
		ids: z
			.array(z.string().regex(/^\d{1,18}$/))
			.min(1)
			.max(MAX_IMPORT),
		folder: z.string().min(1).max(200),
		replacePlans: z.boolean()
	}),
	async (input) => {
		const ids = [...new Set(input.ids)];
		let results;
		try {
			results = await importOctane({ ...input, ids });
		} catch (e) {
			return octaneFailure(e);
		}
		await recordActivity('Imported tests from Octane', ids.join(', '));
		await getSpecs().refresh();
		return results;
	}
);
