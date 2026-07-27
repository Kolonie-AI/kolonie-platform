/**
 * Persistence for the Kolonie AI platform.
 *
 * `apps/api` and `apps/verifier-runner` import storage from here and shapes from
 * `@kolonie-ai/core`. A dependency in the other direction — core importing this
 * package — is always an error (D-008).
 */
export * from './schema/index.js'
export { createDatabase, databaseUrlFromEnv, DATABASE_URL_VAR, type Database } from './client.js'
