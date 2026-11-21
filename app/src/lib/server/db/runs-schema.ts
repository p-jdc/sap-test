import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { RunStatus, RunTest, TestStatus } from '#lib/shared/types.js';

/**
 * The run history (lib/server/runs-store.ts). The log, the Playwright report, screenshots, videos
 * and traces stay files in the run's directory (<data dir>/runs/<id>).
 */
export const run = sqliteTable(
	'run',
	{
		id: text('id').primaryKey(),
		startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
		finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
		status: text('status').$type<RunStatus>().notNull(),
		files: text('files', { mode: 'json' }).$type<string[]>().notNull(),
		grep: text('grep'),
		total: integer('total').notNull(),
		passed: integer('passed').notNull(),
		failed: integer('failed').notNull(),
		skipped: integer('skipped').notNull(),
		exitCode: integer('exit_code'),
		/** When the retention rules deleted the report, screenshots, videos and traces. */
		artifactsRemovedAt: integer('artifacts_removed_at', { mode: 'timestamp_ms' }),
		/** When the retention rules left nothing more to delete: no steps, error messages or log. */
		detailsRemovedAt: integer('details_removed_at', { mode: 'timestamp_ms' })
	},
	(t) => [index('run_started_at').on(t.startedAt)]
);

/**
 * One test of a finished run. The columns are what the reliability table and the retention rules
 * read for every run; `result` is the whole test with its steps, read when the run is opened.
 */
export const runTest = sqliteTable(
	'run_test',
	{
		runId: text('run_id')
			.notNull()
			.references(() => run.id, { onDelete: 'cascade' }),
		/** The test's place in the run, for the order it is shown in. */
		position: integer('position').notNull(),
		key: text('key').notNull(),
		file: text('file').notNull(),
		title: text('title').notNull(),
		status: text('status').$type<TestStatus>(),
		/** A sign-in, which is no flow. */
		setup: integer('setup', { mode: 'boolean' }).notNull(),
		/** Where the test failed (`file:line`). */
		failedAt: text('failed_at'),
		/** The retention rules deleted its steps and error message. */
		detailsRemoved: integer('details_removed', { mode: 'boolean' }).notNull(),
		result: text('result', { mode: 'json' }).$type<RunTest>().notNull()
	},
	(t) => [primaryKey({ columns: [t.runId, t.position] })]
);
