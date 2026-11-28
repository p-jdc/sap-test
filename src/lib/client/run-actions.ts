import { goto } from '$app/navigation';
import { startTestRun } from '#lib/remote/runs.remote.js';
import { runHref } from './links.js';
import { view } from './view.svelte.js';

export function errorMessage(e: unknown): string {
	// SvelteKit's HttpError carries `{ body: { message } }`.
	if (typeof e === 'object' && e !== null && 'body' in e) {
		const { body } = e;
		if (
			typeof body === 'object' &&
			body !== null &&
			'message' in body &&
			typeof body.message === 'string' &&
			body.message
		)
			return body.message;
	}
	// A query's `.error` is that body itself: `{ status, message }`.
	if (typeof e === 'object' && e !== null && 'message' in e && typeof e.message === 'string')
		return e.message;
	return String(e);
}

/**
 * Starts a run and opens its live page; with "Show browser" on, the tests run in a visible window.
 * Returns an error message instead of throwing.
 */
export async function runAndOpen(
	input: { files?: string[]; grep?: string },
	open = true
): Promise<string | null> {
	try {
		const { id } = await startTestRun({ ...input, headed: view.showBrowser });
		if (open) await goto(runHref(id));
		return null;
	} catch (e) {
		return errorMessage(e);
	}
}
