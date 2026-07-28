/**
 * Persistence for the Kolonie AI platform.
 *
 * `apps/api` and `apps/verifier-runner` import storage from here and shapes from
 * `@kolonie-ai/core`. A dependency in the other direction — core importing this
 * package — is always an error (D-008).
 */
export * from './schema/index.js'
export * from './storage/index.js'
export { ACADEMY_TASKS, seedAcademyTasks, type SeedResult } from './academy-tasks.js'
export {
  API_KEY_ENTROPY_BYTES,
  API_KEY_HASH_ALGORITHM,
  apiKeyHashEquals,
  generateApiKey,
  hashApiKey,
} from './api-key.js'
export {
  createDatabase,
  databaseUrlFromEnv,
  DATABASE_URL_VAR,
  type Database,
  type Transaction,
} from './client.js'
