import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema/index.js'

export type Database = ReturnType<typeof createDatabase>

/**
 * The name of the one environment variable this package reads.
 *
 * D-009: everything that needs Postgres addresses it through this variable and
 * knows nothing else. Behind it may sit the Compose stack from `kolonie-infra`,
 * a CI service container, a locally installed server or a throwaway database —
 * that is the caller's business. Nothing in this package may reach past it to
 * ask *how* the database was provided, because the moment it does, "does this
 * test pass?" stops having an answer independent of the machine.
 */
export const DATABASE_URL_VAR = 'DATABASE_URL'

/**
 * Open a connection pool.
 *
 * No secrets and no host names live in this repository — the URL arrives from
 * the environment at run time, and never from a committed default. A localhost
 * fallback would be exactly such a default, and would silently connect a
 * misconfigured production process to nothing.
 */
export function createDatabase(url: string, options: postgres.Options<never> = {}) {
  const client = postgres(url, options)
  return Object.assign(drizzle(client, { schema }), {
    /** Close the pool. Tests must; long-lived processes need not. */
    close: () => client.end(),
  })
}

/**
 * Read the connection URL from the environment, or explain what is missing.
 *
 * Throwing rather than defaulting is deliberate: a process that cannot reach its
 * database has not degraded, it is broken, and it should say so at startup
 * instead of at the first query.
 */
export function databaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const url = env[DATABASE_URL_VAR]
  if (url === undefined || url.trim() === '') {
    throw new Error(
      `${DATABASE_URL_VAR} is not set. It must point at a PostgreSQL 16 server — ` +
        `see operations/testing.md in kolonie-docs for the ways to provide one.`,
    )
  }
  return url
}
