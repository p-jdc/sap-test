// The part of Bun's built-in SQLite (https://bun.com/docs/runtime/sqlite) that the sign-in store
// (lib/server/auth) uses. Declared here instead of adding Bun's global types, which overlap with
// Node's. The app's server runs on Bun; only that store imports this module.
declare module 'bun:sqlite' {
	type Binding = string | number | bigint | boolean | null | Uint8Array;
	export interface Statement<Row = unknown> {
		all(...params: Binding[]): Row[];
		get(...params: Binding[]): Row | null;
		run(...params: Binding[]): { changes: number; lastInsertRowid: number | bigint };
	}
	export class Database {
		constructor(filename?: string, options?: { create?: boolean; strict?: boolean });
		query<Row = unknown>(sql: string): Statement<Row>;
		run(sql: string, ...params: Binding[]): { changes: number; lastInsertRowid: number | bigint };
		exec(sql: string): void;
		close(): void;
	}
}
