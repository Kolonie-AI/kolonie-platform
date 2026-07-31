import { BAN_SALT_VAR } from './ban-salt.js'
import { DATABASE_URL_VAR } from './client.js'

/**
 * Every environment variable a process importing this package cannot start
 * without.
 *
 * **What this list is for.** A repository that makes a variable mandatory has
 * changed the deploy contract of `kolonie-infra`, which cannot see this code.
 * On 2026-07-31 that hand-off had no artefact at all: `#93` made
 * `BAN_MARK_SALT` mandatory, `banSaltFromEnv` threw at startup without it, and
 * the name reached `kolonie-infra` nowhere — not its compose file, not its
 * `.env.example`, not the host's `.env`. Every check that repository had was
 * seeded from what its compose file already read, so a variable compose had
 * never heard of was invisible to all of them. Twelve and a half hours, nineteen
 * deploys, each one rolling back with `not healthy after 180s: api(unhealthy)`
 * and nothing else.
 *
 * So the image declares it, in the OCI label `ai.kolonie.required-env`, and
 * `preflight_env()` in `kolonie-infra/scripts/deploy.sh` refuses a deploy whose
 * host does not provide a declared name — before any container is recreated.
 * `kolonie-infra/AGENTS.md` §8 carries the contract from the other side.
 *
 * **This constant is the source, and the Dockerfiles are copies.** A label is a
 * build-time literal and cannot import TypeScript, so each Dockerfile repeats
 * the list. `required-env.test.ts` is what keeps the copies honest: it reads
 * every Dockerfile and fails if any of them disagrees with this array.
 *
 * **Required means the process refuses to start**, not that it matters. The
 * verifier tokens, the OpenRouter key and the Mastodon instance list are all
 * read lazily and all degrade to a named, reported failure of one capability —
 * so a deploy that lacks them is diminished, not broken, and stopping it would
 * be wrong. Only a variable whose absence makes the process exit belongs here.
 */
export const REQUIRED_ENV = [DATABASE_URL_VAR, BAN_SALT_VAR] as const

/** The label the images carry this list in. */
export const REQUIRED_ENV_LABEL = 'ai.kolonie.required-env'

/** The label's value: the form `preflight_env()` parses. */
export function requiredEnvLabelValue(names: readonly string[] = REQUIRED_ENV): string {
  return names.join(',')
}
