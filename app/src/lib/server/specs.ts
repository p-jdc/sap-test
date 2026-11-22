import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { HELPERS_DIR, TESTS_DIR, toPosix, within } from './paths.js';
import { parseHelpers, parseSpec, type HelperMap } from './spec-parser.js';
import { systemsOfFiles } from './systems.js';
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

let helpers: { map: HelperMap; key: string } | undefined;

/** The helper functions, parsed again only when a helper file was added, removed or changed. */
function loadHelpers(): { map: HelperMap; key: string } {
	const files = walk(HELPERS_DIR, (f) => f.endsWith('.ts'));
	const key = files.map((f) => `${f}:${statSync(f).mtimeMs}`).join('|');
	if (helpers?.key !== key) {
		const sources = files.map((f) => ({ file: f, source: readFileSync(f, 'utf8') }));
		helpers = { key, map: parseHelpers(sources) };
	}
	return helpers;
}

/**
 * Parses every spec under sap-tests/tests, re-parsing only files whose mtime or helpers changed,
 * and names the system each starts signed in to (systems.json).
 */
export function listSpecs(): SpecFile[] {
	const specs = parsedSpecs();
	const systems = systemsOfFiles(specs.map((s) => s.file));
	// Set on every call, also on a cached spec: systems.json may have changed since it was parsed.
	for (const spec of specs) {
		const system = systems.get(spec.file);
		if (system) spec.system = system;
		else delete spec.system;
	}
	return specs;
}

function parsedSpecs(): SpecFile[] {
	const current = loadHelpers();
	return walk(TESTS_DIR, (f) => /\.(spec|test)\.[cm]?[jt]s$/.test(f)).map((full) => {
		const file = toPosix(relative(TESTS_DIR, full));
		const mtime = statSync(full).mtimeMs;
		const hit = cache.get(file);
		if (hit && hit.mtime === mtime && hit.helpersKey === current.key) return hit.parsed;
		let parsed: SpecFile;
		try {
			parsed = parseSpec(file, readFileSync(full, 'utf8'), current.map);
		} catch (e) {
			parsed = { file, surface: 'other', tests: [], issues: [], parseError: String(e) };
		}
		cache.set(file, { mtime, helpersKey: current.key, parsed });
		return parsed;
	});
}

export function readSpecSource(file: string): string | null {
	const full = within(TESTS_DIR, file);
	return full && existsSync(full) ? readFileSync(full, 'utf8') : null;
}
