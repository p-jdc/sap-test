import { command, query } from '$app/server';
import { z } from 'zod';
import { CHECKLIST, readChecked, setChecked } from '#lib/server/checklist.js';

export const getChecklist = query(async () => ({ phases: CHECKLIST, checked: readChecked() }));

export const toggleChecklistItem = command(
	z.object({ id: z.string().max(40), checked: z.boolean() }),
	async ({ id, checked }) => {
		setChecked(id, checked);
		await getChecklist().refresh();
	}
);
