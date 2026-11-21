// Sign-in with passkeys (TEST_APP_AUTH=passkey; see policy.ts). Better Auth keeps users, sessions
// and passkeys in a SQLite file in the data directory (Bun's built-in SQLite). There is no
// password: a passkey is registered with the one-time setup link the server logs while nobody is
// registered (the first person becomes admin), with an invite link an admin creates, or with a
// recovery link the server logs when started with TEST_APP_RECOVERY=on (a new admin, for when no
// admin can sign in any more).
// Runs on Bun only; hooks.server.ts loads it when sign-in is on.
import { passkey } from '@better-auth/passkey';
import { APIError, betterAuth, type BetterAuthOptions } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { admin } from 'better-auth/plugins/admin';
import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements } from 'better-auth/plugins/admin/access';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { getRequestEvent } from '$app/server';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { database, type AppDatabase } from '../db/database.js';
import * as schema from '../db/schema.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { DATA_DIR } from '../paths.js';
import { configuredHosts } from '../host-check.js';
import { foreignOrigin, localAuthHosts } from './policy.js';
import { openStore, type Role, type Store } from './store.js';

const SECRET_FILE = join(DATA_DIR, 'auth-secret');

/** BETTER_AUTH_SECRET, or one generated once and kept in the data directory (readable by this user only). */
function secret(): string {
	const fromEnv = process.env.BETTER_AUTH_SECRET;
	if (fromEnv) return fromEnv;
	if (existsSync(SECRET_FILE)) return readFileSync(SECRET_FILE, 'utf8').trim();
	const generated = randomBytes(32).toString('base64url');
	writeFileSync(SECRET_FILE, generated, { mode: 0o600 });
	chmodSync(SECRET_FILE, 0o600);
	return generated;
}

/** What a passkey registration without a session must carry (the `context` of the request). */
type Registration =
	| { setup: string; name: string }
	| { recover: string; name: string }
	| { invite: string };

function parseRegistration(context: string | null | undefined): Registration | null {
	let value: unknown;
	try {
		value = JSON.parse(context ?? '');
	} catch {
		return null;
	}
	if (typeof value !== 'object' || value === null) return null;
	const invite: unknown = 'invite' in value ? value.invite : null;
	const setup: unknown = 'setup' in value ? value.setup : null;
	const recover: unknown = 'recover' in value ? value.recover : null;
	const name: unknown = 'name' in value ? value.name : null;
	if (typeof invite === 'string' && invite) return { invite };
	if (typeof name !== 'string') return null;
	if (typeof setup === 'string' && setup) return { setup, name };
	if (typeof recover === 'string' && recover) return { recover, name };
	return null;
}

const sameText = (a: string, b: string) =>
	a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** A display name: what the person typed, trimmed and short. */
function personName(name: string): string | null {
	const trimmed = name.trim().replaceAll(/\s+/g, ' ');
	return trimmed && trimmed.length <= 80 ? trimmed : null;
}

/**
 * What admins may do through the admin plugin: list people, change roles, block and remove them,
 * end their sessions. Not impersonate them, set passwords or emails, or create accounts (people
 * join through invites). Members may do none of it.
 */
const ac = createAccessControl(defaultStatements);
const roles = {
	admin: ac.newRole({
		user: ['list', 'get', 'set-role', 'ban', 'delete'],
		session: ['list', 'revoke', 'delete']
	}),
	member: ac.newRole({ user: [], session: [] })
};

/** The app's address on a server; unset on a laptop (see policy.ts). */
const appUrl = process.env.BETTER_AUTH_URL ? new URL(process.env.BETTER_AUTH_URL) : undefined;

/** The one header the reverse proxy sets to the client's address (rate limits per client). */
const clientIpHeader = process.env.TEST_APP_CLIENT_IP_HEADER?.trim().toLowerCase();

function createAuth(db: AppDatabase, store: Store, setup: { token: string | null }) {
	/**
	 * Who may register now, and as whom: the setup link while nobody is registered, a recovery link,
	 * or an invite.
	 */
	function registrationRight(context: string | null | undefined): { name: string; role: Role } {
		const registration = parseRegistration(context);
		if (registration && 'recover' in registration) {
			const name = personName(registration.name);
			if (name && store.recoveryValid(registration.recover)) return { name, role: 'admin' };
		} else if (registration && 'setup' in registration) {
			const name = personName(registration.name);
			if (
				setup.token &&
				store.userCount() === 0 &&
				sameText(registration.setup, setup.token) &&
				name
			)
				return { name, role: 'admin' };
		} else if (registration) {
			const invite = store.invite(registration.invite);
			if (invite) return invite;
		}
		throw new APIError('FORBIDDEN', {
			message: 'This link is not valid (any more). Ask an admin for an invite.'
		});
	}

	const options = {
		appName: 'SAP Test Lab',
		// Without transactions: Drizzle's driver for Bun's SQLite only runs synchronous ones. The
		// registration below uses up its right synchronously instead (afterVerification).
		database: drizzleAdapter(db, { provider: 'sqlite', schema }),
		secret: secret(),
		// Required off this computer (policy.ts). On a laptop it is taken from each request whose host
		// is one the host check (host-check.ts) also accepts there.
		baseURL: appUrl?.origin ?? { allowedHosts: localAuthHosts(configuredHosts()) },
		basePath: '/api/auth',
		// A working day; using the app moves it on once an hour.
		session: { expiresIn: 60 * 60 * 12, updateAge: 60 * 60 },
		// On, whatever NODE_ENV says: Better Auth enables it only in production mode.
		rateLimit: { enabled: true },
		advanced: {
			// Secure cookies with an https address, also behind a proxy that ends TLS.
			...(appUrl?.protocol === 'https:' ? { useSecureCookies: true } : {}),
			// By default the client address comes from X-Forwarded-For, which a client can set itself.
			...(clientIpHeader ? { ipAddress: { ipAddressHeaders: [clientIpHeader] } } : {})
		},
		hooks: {
			// On a laptop, only the app's own origin, not another local port (foreignOrigin). The admin
			// plugin stops admins from blocking or removing themselves; this also keeps the last admin
			// from giving up the role.
			before: createAuthMiddleware((ctx) => {
				if (!appUrl && ctx.request && foreignOrigin(ctx.request.url, ctx.request.headers))
					return Promise.reject(new APIError('FORBIDDEN', { message: 'Invalid origin' }));
				if (ctx.path !== '/admin/set-role') return Promise.resolve();
				const body: unknown = ctx.body;
				const fields = typeof body === 'object' && body ? body : {};
				const userId: unknown = 'userId' in fields ? fields.userId : null;
				const role: unknown = 'role' in fields ? fields.role : null;
				const target = store.people().find((p) => p.id === userId);
				if (target?.role === 'admin' && role !== 'admin' && store.adminCount() <= 1)
					return Promise.reject(
						new APIError('BAD_REQUEST', { message: 'The last admin keeps the role.' })
					);
				return Promise.resolve();
			})
		},
		databaseHooks: {
			session: {
				create: {
					after: (session) => {
						const person = store.people().find((p) => p.id === session.userId);
						store.record(person ? { id: person.id, name: person.name } : null, 'Signed in');
						return Promise.resolve();
					}
				}
			}
		},
		plugins: [
			passkey({
				rpName: 'SAP Test Lab',
				rpID: appUrl?.hostname ?? 'localhost',
				registration: {
					// Registration without a session needs the setup link or an invite (registrationRight).
					requireSession: false,
					resolveUser: ({ context }) => {
						const { name } = registrationRight(context);
						return { id: randomBytes(16).toString('hex'), name, displayName: name };
					},
					// Creates the person once the passkey is verified. A signed-in person adding a passkey
					// keeps their account.
					afterVerification: async ({ ctx, user, context }) => {
						if (await ctx.context.internalAdapter.findUserById(user.id)) return {};
						// Checked and used up with no await in between, so two registrations at once
						// cannot both use the same setup, recovery or invite link.
						const right = registrationRight(context);
						const registration = parseRegistration(context);
						if (registration && 'invite' in registration && !store.useInvite(registration.invite))
							throw new APIError('FORBIDDEN', { message: 'This invite was used already.' });
						if (
							registration &&
							'recover' in registration &&
							!store.useRecovery(registration.recover)
						)
							throw new APIError('FORBIDDEN', {
								message: 'This recovery link was used already.'
							});
						if (right.role === 'admin' && registration && 'setup' in registration)
							setup.token = null;
						const created = await ctx.context.internalAdapter.createUser(
							{
								name: right.name,
								// Better Auth requires an email; these people have none here.
								email: `${randomBytes(12).toString('hex')}@users.invalid`,
								emailVerified: false,
								role: right.role
							},
							{ method: 'passkey' }
						);
						store.record(
							{ id: created.id, name: created.name },
							'Registered',
							registration && 'recover' in registration
								? 'as admin with a recovery link'
								: `as ${right.role}`
						);
						return { userId: created.id };
					}
				}
			}),
			admin({
				ac,
				roles,
				defaultRole: 'member',
				adminRoles: ['admin'],
				bannedUserMessage: 'Your access is blocked. Ask an admin of SAP Test Lab.'
			}),
			// Last: sets the cookies of auth calls made from server code.
			sveltekitCookies(getRequestEvent)
		]
	} satisfies BetterAuthOptions;
	return { auth: betterAuth(options) };
}

let ready:
	| Promise<{
			auth: ReturnType<typeof createAuth>['auth'];
			store: Store;
			/** Whether `token` is the setup link's, while nobody is registered. */
			setupValid: (token: string) => boolean;
	  }>
	| undefined;

/** A token from the environment, when it is long enough not to be guessed. */
const fixedToken = (name: string) => {
	const value = process.env[name];
	return value && value.length >= 24 ? value : null;
};

/**
 * Logs a recovery link when started with TEST_APP_RECOVERY=on: whoever opens it within the hour
 * registers a passkey as a new admin, once. For when no admin can sign in any more (a lost
 * passkey); only who starts the server and reads its log gets it. TEST_APP_RECOVERY_TOKEN fixes
 * its token, for automation; a fixed token works once, also across restarts.
 */
function openRecovery(store: Store, base: string) {
	if (process.env.TEST_APP_RECOVERY !== 'on') return;
	const token = fixedToken('TEST_APP_RECOVERY_TOKEN') ?? randomBytes(24).toString('base64url');
	const { opened, expiresAt } = store.openRecovery(token);
	if (!opened) {
		console.warn(
			'TEST_APP_RECOVERY is on, but TEST_APP_RECOVERY_TOKEN was used already. Set another token, or unset it for a random one.'
		);
		return;
	}
	console.log(
		// oxlint-disable-next-line secure-coding/no-sensitive-data-exposure -- the one-time recovery link is meant for whoever starts the app; it ends with its first use or after an hour
		`Recovery is on. Open ${base}/signin?recover=${token} on this app before ${expiresAt.toISOString()} to register a new admin. It works once; unset TEST_APP_RECOVERY afterwards.`
	);
	store.record(null, 'Recovery link opened', `valid until ${expiresAt.toISOString()}`);
}

/**
 * Opens the database (db/database.ts applies its migrations) and, while nobody is registered,
 * logs the one-time setup link for the first admin (TEST_APP_SETUP_TOKEN fixes its token, for
 * automation). With TEST_APP_RECOVERY=on, also logs a recovery link (openRecovery).
 */
export function signIn() {
	ready ??= Promise.resolve().then(() => {
		const db = database();
		const setup = { token: null as string | null };
		const store = openStore(db);
		const { auth } = createAuth(db, store, setup);
		const base = process.env.BETTER_AUTH_URL?.replace(/\/$/, '') ?? '';
		if (store.userCount() === 0) {
			setup.token = fixedToken('TEST_APP_SETUP_TOKEN') ?? randomBytes(24).toString('base64url');
			console.log(
				// oxlint-disable-next-line secure-coding/no-sensitive-data-exposure -- the one-time setup link is meant for whoever starts the app; it ends with the first registration
				`Sign-in is on and nobody is registered yet. Open ${base}/signin?setup=${setup.token} on this app to register the first admin.`
			);
		}
		openRecovery(store, base);
		const setupValid = (token: string) =>
			!!setup.token && store.userCount() === 0 && sameText(token, setup.token);
		return { auth, store, setupValid };
	});
	return ready;
}
