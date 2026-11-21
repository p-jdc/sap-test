import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { HELPERS_DIR, TESTS_DIR, toPosix, within } from './paths.js';
import { parseHelpers, parseSpec, type HelperMap } from './spec-parser.js';
import type { SpecFile } from '#lib/shared/types.js';

function walk(dir: string, match: (f: string) => boolean): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full, match));
		else if (match(entry.name)) out.push(full);
	}
	return out.toSorted();
}

const cache = new Map<string, { mtime: number; helpersKey: string; parsed: SpecFile }>();

function loadHelpers(): { map: HelperMap; key: string } {
	const files = walk(HELPERS_DIR, (f) => f.endsWith('.ts'));
	const key = files.map((f) => `${f}:${statSync(f).mtimeMs}`).join('|');
	return {
		key,
		map: parseHelpers(files.map((f) => ({ file: f, source: readFileSync(f, 'utf8') })))
	};
}

/** Parses every spec under sap-tests/tests, re-parsing only files whose mtime or helpers changed. */
export function listSpecs(): SpecFile[] {
	const helpers = loadHelpers();
	return walk(TESTS_DIR, (f) => /\.(spec|test)\.[cm]?[jt]s$/.test(f)).map((full) => {
		const file = toPosix(relative(TESTS_DIR, full));
		const mtime = statSync(full).mtimeMs;
		const hit = cache.get(file);
		if (hit && hit.mtime === mtime && hit.helpersKey === helpers.key) return hit.parsed;
		let parsed: SpecFile;
		try {
			parsed = parseSpec(file, readFileSync(full, 'utf8'), helpers.map);
		} catch (e) {
			parsed = { file, surface: 'other', tests: [], issues: [], parseError: String(e) };
		}
		cache.set(file, { mtime, helpersKey: helpers.key, parsed });
		return parsed;
	});
}

export function readSpecSource(file: string): string | null {
	const full = within(TESTS_DIR, file);
	return full && existsSync(full) ? readFileSync(full, 'utf8') : null;
}
