import { goto } from '$app/navigation';
import { startTestRun } from '#lib/remote/runs.remote.js';
import { runHref } from './links.js';

export function errorMessage(e: unknown): string {
	if (e && typeof e === 'object' && 'body' in e) {
		const body = (e as { body?: { message?: string } }).body;
		if (body?.message) return body.message;
	}
	return e instanceof Error ? e.message : String(e);
}

/** Starts a run and opens its live page. Returns an error message instead of throwing. */
export async function runAndOpen(
	input: { files?: string[]; grep?: string },
	open = true
): Promise<string | null> {
	try {
		const { id } = await startTestRun(input);
		if (open) await goto(runHref(id));
		return null;
	} catch (e) {
		return errorMessage(e);
	}
}
