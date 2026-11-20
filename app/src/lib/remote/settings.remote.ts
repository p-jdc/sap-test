import { command } from '$app/server';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { changeSetting } from '#lib/server/env-file.js';
import { SETTING_NAMES } from '#lib/shared/types.js';
import { getEnvStatus } from './specs.remote.js';

const name = z.enum(SETTING_NAMES);

function message(e: unknown) {
	return e instanceof Error ? e.message : String(e);
}

/** Stores one setting in the system credential store. The value never travels back. */
export const saveSetting = command(
	z.object({ name, value: z.string().min(1).max(2000) }),
	async (input) => {
		if (input.name.endsWith('_URL') && !URL.canParse(input.value)) {
			error(400, `${input.name} must be a full URL, for example https://sap.example.com.`);
		}
		try {
			// A password is stored exactly as typed; anything else loses stray spaces from a paste.
			const secret = input.name === 'SAP_PASSWORD' || input.name === 'ARIBA_PASS';
			const result = await changeSetting(input.name, secret ? input.value : input.value.trim());
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
