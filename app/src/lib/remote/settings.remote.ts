import { command } from '$app/server';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { changeSetting } from '#lib/server/env-file.js';
import { settingProblem } from '#lib/server/setting-value.js';
import { SECRET_SETTINGS, SETTING_NAMES } from '#lib/shared/types.js';
import { getEnvStatus } from './specs.remote.js';

const name = z.enum(SETTING_NAMES);

function message(e: unknown) {
	return e instanceof Error ? e.message : String(e);
}

/** Stores one setting in the system credential store. The value never travels back. */
export const saveSetting = command(
	z.object({ name, value: z.string().min(1).max(2000) }),
	async (input) => {
		// A password is stored exactly as typed; anything else loses stray spaces from a paste.
		const value = SECRET_SETTINGS.includes(input.name) ? input.value : input.value.trim();
		const problem = settingProblem(input.name, value);
		if (problem) error(400, problem);
		try {
			const result = await changeSetting(input.name, value);
			await getEnvStatus().refresh();
			return result;
		} catch (e) {
			return error(500, `Could not save ${input.name}: ${message(e)}`);
		}
	}
);

export const removeSetting = command(name, async (setting) => {
	try {
		const result = await changeSetting(setting, null);
		await getEnvStatus().refresh();
		return result;
	} catch (e) {
		return error(500, `Could not remove ${setting}: ${message(e)}`);
	}
});
