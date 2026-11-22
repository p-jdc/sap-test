import { error } from '@sveltejs/kit';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileResponse } from '#lib/server/file-response.js';
import { RUNS_DIR, within } from '#lib/server/paths.js';
import type { RequestHandler } from './$types';

/** Serves a run's HTML report (incl. trace viewer) and its screenshots, videos and traces. */
export const GET: RequestHandler = ({ params, request }) => {
	const dir = within(RUNS_DIR, params.id);
	const path = params.path || 'report/index.html';
	let file = dir && within(dir, path);
	// A folder is answered with its index.html.
	if (dir && file && existsSync(file) && statSync(file).isDirectory())
		file = within(dir, join(path, 'index.html'));
	if (!file || !existsSync(file)) error(404, 'Not found');
	return fileResponse(file, request.headers.get('range'));
};
