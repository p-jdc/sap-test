// The app's database: one SQLite file in the data directory, opened with Bun's built-in SQLite
// and used through Drizzle. Migrations (app/drizzle, made with `bun run db:generate` from
// schema.ts) are applied when it opens. Runs on Bun only.
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DATA_DIR } from '../paths.js';
import * as schema from './schema.js';

const FILE = join(DATA_DIR, 'app.sqlite');
/** Next to package.json, where the app runs from (also in a container image). */
const MIGRATIONS = resolve(process.cwd(), 'drizzle');

export function openDatabase() {
	mkdirSync(DATA_DIR, { recursive: true });
	// Holds the session tokens: this user only. SQLite gives its -wal and -shm files the same.
	if (!existsSync(FILE)) writeFileSync(FILE, '', { mode: 0o600 });
	chmodSync(FILE, 0o600);
	const client = new Database(FILE, { create: true });
	client.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
	const db = drizzle({ client, schema });
	migrate(db, { migrationsFolder: MIGRATIONS });
	return db;
}

export type AppDatabase = ReturnType<typeof openDatabase>;
