import { command, query } from '$app/server';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { recorderState, startRecording, stopRecording } from '#lib/server/recorder.js';

export const getRecorder = query(() => recorderState());

export const startRecorder = command(
	z.object({
		surface: z.enum(['fiori', 'webgui', 'ariba']),
		name: z.string().min(1).max(80),
		url: z.string().url().optional().or(z.literal('')),
		saveStorage: z.boolean().optional()
	}),
	async (input) => {
		const result = startRecording({ ...input, url: input.url || undefined });
		if (!result.ok) error(400, result.error);
		await getRecorder().refresh();
		return { file: result.file };
	}
);

export const stopRecorder = command(async () => {
	stopRecording();
	await getRecorder().refresh();
});
