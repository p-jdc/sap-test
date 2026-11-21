import { defineConfig } from 'drizzle-kit';

// `bun run db:generate` writes a migration to drizzle/ from the schema; the app applies it when it
// opens its database (src/lib/server/db/database.ts).
export default defineConfig({
	dialect: 'sqlite',
	schema: './src/lib/server/db/schema.ts',
	out: './drizzle'
});
