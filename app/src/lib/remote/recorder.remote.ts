import { command, query } from '$app/server';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { recordActivity } from '#lib/server/auth/access.js';
import { recorderState, startRecording, stopRecording } from '#lib/server/recorder.js';

export const getRecorder = query(() => recorderState());

export const startRecorder = command(
	z.object({
		surface: z.enum(['fiori', 'webgui', 'ariba']),
		name: z.string().min(1).max(80),
		url: z.url().optional().or(z.literal('')),
		saveStorage: z.boolean().optional(),
		noLogin: z.boolean().optional()
	}),
	async (input) => {
		const result = await startRecording({ ...input, url: input.url || undefined });
		if (!result.ok) error(400, result.error);
		await recordActivity('Started a recording', result.file);
		await getRecorder().refresh();
		return { file: result.file };
	}
);

export const stopRecorder = command(async () => {
	stopRecording();
	await getRecorder().refresh();
});
