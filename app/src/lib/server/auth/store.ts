import { and, count, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import type { AppDatabase } from '../db/database.js';
import { appActivity, appInvite, passkey, session, user } from '../db/schema.js';

/**
 * The app's own sign-in data next to Better Auth's tables: invites and the activity log, plus
 * read-only views of Better Auth's people for Settings. Queries on Bun's SQLite run synchronously,
 * so a check and its write (using up an invite) cannot interleave with another request's.
 */
export type Role = 'admin' | 'member';

export interface Person {
	id: string;
	name: string;
	role: Role;
	createdAt: string;
	passkeys: number;
	lastSignIn: string | null;
	/** Blocked by an admin (the admin plugin's ban): cannot sign in until unblocked. */
	blocked: boolean;
}

export interface ActivityEntry {
	at: string;
	who: string | null;
	action: string;
	detail: string | null;
}

/** An invite link is good for one passkey, for this long. */
const INVITE_HOURS = 72;

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export function openStore(db: AppDatabase) {
	return {
		userCount(): number {
			return db.select({ n: count() }).from(user).get()?.n ?? 0;
		},

		adminCount(): number {
			return db.select({ n: count() }).from(user).where(eq(user.role, 'admin')).get()?.n ?? 0;
		},

		/** A new invite; the token is in the link only, the store keeps its hash. */
		createInvite(name: string, role: Role, createdBy: string | null) {
			const token = randomBytes(24).toString('base64url');
			const now = new Date();
			const expiresAt = new Date(now.getTime() + INVITE_HOURS * 3_600_000);
			db.insert(appInvite)
				.values({ tokenHash: hash(token), name, role, createdBy, createdAt: now, expiresAt })
				.run();
			return { token, expiresAt: expiresAt.toISOString() };
		},

		/** The invite behind a link, while it is unused and not expired. */
		invite(token: string): { name: string; role: Role } | null {
			return (
				db
					.select({ name: appInvite.name, role: appInvite.role })
					.from(appInvite)
					.where(
						and(
							eq(appInvite.tokenHash, hash(token)),
							isNull(appInvite.usedAt),
							gt(appInvite.expiresAt, new Date())
						)
					)
					.get() ?? null
			);
		},

		/** Uses up an invite; false when it was used or expired in the meantime. */
		useInvite(token: string): boolean {
			const used = db
				.update(appInvite)
				.set({ usedAt: new Date() })
				.where(
					and(
						eq(appInvite.tokenHash, hash(token)),
						isNull(appInvite.usedAt),
						gt(appInvite.expiresAt, new Date())
					)
				)
				.returning({ tokenHash: appInvite.tokenHash })
				.all();
			return used.length === 1;
		},

		people(): Person[] {
			return db
				.select({
					id: user.id,
					name: user.name,
					role: user.role,
					createdAt: user.createdAt,
					banned: user.banned,
					passkeys: sql<number>`(SELECT count(*) FROM ${passkey} WHERE ${passkey.userId} = ${user.id})`,
					lastSignIn: sql<
						number | null
					>`(SELECT max(${session.createdAt}) FROM ${session} WHERE ${session.userId} = ${user.id})`
				})
				.from(user)
				.orderBy(user.createdAt)
				.all()
				.map((r) => ({
					id: r.id,
					name: r.name,
					role: r.role === 'admin' ? 'admin' : 'member',
					createdAt: r.createdAt.toISOString(),
					passkeys: r.passkeys,
					lastSignIn: r.lastSignIn === null ? null : new Date(r.lastSignIn).toISOString(),
					blocked: r.banned === true
				}));
		},

		record(who: { id: string; name: string } | null, action: string, detail?: string) {
			db.insert(appActivity)
				.values({
					at: new Date(),
					userId: who?.id ?? null,
					userName: who?.name ?? null,
					action,
					detail: detail ?? null
				})
				.run();
		},

		activity(limit = 200): ActivityEntry[] {
			return db
				.select()
				.from(appActivity)
				.orderBy(desc(appActivity.id))
				.limit(limit)
				.all()
				.map((r) => ({
					at: r.at.toISOString(),
					who: r.userName,
					action: r.action,
					detail: r.detail
				}));
		}
	};
}

export type Store = ReturnType<typeof openStore>;
