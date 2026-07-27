import { defineConfig } from 'drizzle-kit'

/**
 * `drizzle-kit generate` reads the schema and emits SQL into `drizzle/`.
 *
 * The generated SQL is committed and reviewed as SQL — that is why Drizzle was
 * chosen over Prisma in the first place (`ARCHITECTURE.md` in kolonie-docs). For
 * a double-entry ledger, being able to read exactly what will run against the
 * database is the point, not a detail.
 *
 * No credentials here. The URL comes from the environment; see D-009.
 */
export default defineConfig({
  schema: './src/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
})
