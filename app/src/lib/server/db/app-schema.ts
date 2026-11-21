import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Invite links (lib/server/auth/store.ts). The token is only in the link; this keeps its hash. */
export const appInvite = sqliteTable('app_invite', {
	tokenHash: text('token_hash').primaryKey(),
	name: text('name').notNull(),
	role: text('role', { enum: ['admin', 'member'] }).notNull(),
	createdBy: text('created_by'),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
	expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
	usedAt: integer('used_at', { mode: 'timestamp_ms' })
});

/** What people did in the app (Settings → Activity). Never a secret value. */
export const appActivity = sqliteTable('app_activity', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	at: integer('at', { mode: 'timestamp_ms' }).notNull(),
	userId: text('user_id'),
	userName: text('user_name'),
	action: text('action').notNull(),
	detail: text('detail')
});

/**
 * Recovery links for admin access (lib/server/auth/auth.ts), made at a start with
 * TEST_APP_RECOVERY=on. Kept after use, so a fixed token cannot be used twice.
 */
export const appRecovery = sqliteTable('app_recovery', {
	tokenHash: text('token_hash').primaryKey(),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
	expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
	usedAt: integer('used_at', { mode: 'timestamp_ms' })
});
