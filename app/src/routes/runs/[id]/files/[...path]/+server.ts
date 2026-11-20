import { error } from '@sveltejs/kit';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RUNS_DIR, within } from '#lib/server/paths.js';
import type { RequestHandler } from './$types';

const TYPES: Record<string, string> = {
	html: 'text/html; charset=utf-8',
	js: 'text/javascript',
	css: 'text/css',
	json: 'application/json',
	png: 'image/png',
	jpeg: 'image/jpeg',
	jpg: 'image/jpeg',
	svg: 'image/svg+xml',
	webm: 'video/webm',
	zip: 'application/zip',
	md: 'text/markdown; charset=utf-8',
	txt: 'text/plain; charset=utf-8',
	woff2: 'font/woff2'
};

/** Serves a run's HTML report (incl. trace viewer) and its screenshots, videos and traces. */
export const GET: RequestHandler = async ({ params }) => {
	const dir = within(RUNS_DIR, params.id);
	const file = dir && within(dir, params.path || 'report/index.html');
	if (!file || !existsSync(file) || statSync(file).isDirectory()) {
		const index = dir && file && within(dir, join(params.path, 'index.html'));
		if (!index || !existsSync(index)) error(404, 'Not found');
		return new Response(await readFile(index), { headers: { 'content-type': TYPES.html } });
	}
	const ext = file.split('.').pop()?.toLowerCase() ?? '';
	return new Response(await readFile(file), {
		headers: {
			'content-type': TYPES[ext] ?? 'application/octet-stream',
			'cache-control': 'private, max-age=3600'
		}
	});
};
