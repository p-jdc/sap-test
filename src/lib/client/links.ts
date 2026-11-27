import { resolve } from '$app/paths';

// Every in-app URL goes through resolve() so a configured base path is respected; the return type
// (ResolvedPathname) is what svelte/no-navigation-without-resolve accepts for href and goto.

export const homeHref = () => resolve('/');
export const testsHref = () => resolve('/tests');
export const runsHref = () => resolve('/runs');
/** The page for a new test; `way` 'plan' opens it on the AI planner. */
export const recorderHref = (way?: 'plan' | null) =>
	resolve(way ? `/recorder?way=${way}` : '/recorder');
export const settingsHref = () => resolve('/settings');

export const runHref = (id: string) => resolve('/runs/[id]', { id });

export const flowHref = (key: string, run?: string | null) =>
	resolve(`/flow?key=${encodeURIComponent(key)}${run ? `&run=${encodeURIComponent(run)}` : ''}`);

/** A file inside a run directory (report, screenshot, video, trace), served by routes/runs/[id]/files. */
export const runFileHref = (id: string, path: string) =>
	resolve('/runs/[id]/files/[...path]', { id, path });

/** Playwright's HTML report of a run, opened on one test case when `testId` is given. */
export function reportHref(id: string, testId?: string) {
	if (!testId) return runFileHref(id, 'report/index.html');
	const hash = `?testId=${encodeURIComponent(testId)}`;
	return resolve(`/runs/[id]/files/[...path]#${hash}`, { id, path: 'report/index.html' });
}

/** The HTML report's trace viewer, pointed at one trace.zip of the run. */
export const traceHref = (id: string, tracePath: string) =>
	resolve(
		`/runs/[id]/files/[...path]?trace=${encodeURIComponent(`${location.origin}${runFileHref(id, tracePath)}`)}`,
		{ id, path: 'report/trace/index.html' }
	);
