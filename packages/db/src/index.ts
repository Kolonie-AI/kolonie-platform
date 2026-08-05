/**
 * Persistence for the Kolonie AI platform.
 *
 * `apps/api` and `apps/verifier-runner` import storage from here and shapes from
 * `@kolonie-ai/core`. A dependency in the other direction — core importing this
 * package — is always an error (D-008).
 */
export * from './schema/index.js'
export * from './storage/index.js'
export {
  ACADEMY_TASKS,
  POW_DIFFICULTY_BITS,
  SKILLS_THE_ACADEMY_GRANTS,
  seedAcademyTasks,
  type SeedResult,
} from './academy-tasks.js'
export {
  backfillAgentSkills,
  BACKFILL_AGENT_SKILLS_SQL,
  SKILL_GRAPH_MIGRATION,
} from './skill-backfill.js'
export {
  API_KEY_ENTROPY_BYTES,
  API_KEY_HASH_ALGORITHM,
  apiKeyHashEquals,
  generateApiKey,
  hashApiKey,
} from './api-key.js'
export { fingerprintOf, REGISTRATION_FINGERPRINT_ALGORITHM } from './registration-fingerprint.js'
export {
  API_REQUIRED_ENV,
  IMAGE_REQUIRED_ENV,
  REQUIRED_ENV,
  REQUIRED_ENV_LABEL,
  requiredEnvLabelValue,
} from './required-env.js'
/**
 * The vault's sealing primitives.
 *
 * Exported so a test outside this package can prove the negative — that stored
 * bytes do not open without the token that wrote them — against the same code
 * the storage layer calls. Nothing in `apps/` should reach for these to seal
 * something of its own: the vault's whole claim is that one module decides what
 * a stored value looks like.
 */
export {
  openVaultValue,
  sealVaultValue,
  VAULT_CIPHER,
  VAULT_ENVELOPE_VERSION,
} from './vault-crypto.js'
export {
  banMarkHash,
  banSaltFromEnv,
  BAN_MARK_ALGORITHM,
  BAN_SALT_MIN_LENGTH,
  BAN_SALT_VAR,
} from './ban-salt.js'
export {
  createDatabase,
  databaseUrlFromEnv,
  DATABASE_URL_VAR,
  type Database,
  type Transaction,
} from './client.js'
