import { command, getRequestEvent, query } from '$app/server';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { currentUser, requireAdmin } from '#lib/server/auth/access.js';
import { authMode } from '#lib/server/auth/policy.js';

/** Bun's SQLite and Better Auth, loaded only with sign-in on. */
async function signedIn() {
	if (authMode() === 'off') error(400, 'Sign-in is off.');
	const { signIn } = await import('#lib/server/auth/auth.js');
	return signIn();
}

/** The admin plugin's endpoints, as the admin asking: it checks their permissions again. */
const asMe = () => ({ headers: getRequestEvent().request.headers });

/** An admin plugin refusal (blocking yourself, the last admin) as a message for the page. */
async function adminCall<T>(call: () => Promise<T>): Promise<T> {
	try {
		return await call();
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		return error(400, message);
	}
}

/** Who is signed in, or none with sign-in off. */
export const getMe = query(() => ({ auth: authMode() !== 'off', user: currentUser() ?? null }));

export const getPeople = query(async () => {
	requireAdmin();
	if (authMode() === 'off') return [];
	return (await signedIn()).store.people();
});

export const getActivity = query(async () => {
	requireAdmin();
	if (authMode() === 'off') return [];
	return (await signedIn()).store.activity();
});

/** An invite link for one passkey; the token is shown once and only its hash is kept. */
export const createInvite = command(
	z.object({ name: z.string().trim().min(1).max(80), role: z.enum(['admin', 'member']) }),
	async ({ name, role }) => {
		requireAdmin();
		const { store } = await signedIn();
		const me = currentUser() ?? null;
		const invite = store.createInvite(name, role, me?.id ?? null);
		store.record(me, 'Invited', `${name} as ${role}`);
		await getActivity().refresh();
		return invite;
	}
);

const target = z.object({ id: z.string().min(1) });

function personNamed(people: { id: string; name: string }[], id: string): string {
	const person = people.find((p) => p.id === id);
	if (!person) error(404, 'No such person.');
	return person.name;
}

async function changed(action: string, name: string) {
	const { store } = await signedIn();
	store.record(currentUser() ?? null, action, name);
	await Promise.all([getPeople().refresh(), getActivity().refresh()]);
}

export const setPersonRole = command(
	target.extend({ role: z.enum(['admin', 'member']) }),
	async ({ id, role }) => {
		requireAdmin();
		const { auth, store } = await signedIn();
		const name = personNamed(store.people(), id);
		await adminCall(() => auth.api.setRole({ body: { userId: id, role }, ...asMe() }));
		await changed(role === 'admin' ? 'Made admin' : 'Made member', name);
	}
);

/** Blocks a person: their sessions end, and they cannot sign in until unblocked. */
export const blockPerson = command(
	target.extend({ blocked: z.boolean() }),
	async ({ id, blocked }) => {
		requireAdmin();
		const { auth, store } = await signedIn();
		const name = personNamed(store.people(), id);
		await adminCall(() =>
			blocked
				? auth.api.banUser({ body: { userId: id }, ...asMe() })
				: auth.api.unbanUser({ body: { userId: id }, ...asMe() })
		);
		await changed(blocked ? 'Blocked' : 'Unblocked', name);
	}
);

/** Removes a person. Nobody removes themselves (the admin plugin refuses). */
export const removePerson = command(target, async ({ id }) => {
	requireAdmin();
	const { auth, store } = await signedIn();
	const name = personNamed(store.people(), id);
	// Their sessions and passkeys go with them (the schema deletes them in cascade).
	await adminCall(() => auth.api.removeUser({ body: { userId: id }, ...asMe() }));
	await changed('Removed', name);
});
