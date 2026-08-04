import { DEPOSIT_SEALING_KEY_VAR } from '@kolonie-ai/core'

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
 * **This file is the source, and the Dockerfiles are copies.** A label is a
 * build-time literal and cannot import TypeScript, so each Dockerfile repeats
 * the list. `required-env.test.ts` is what keeps the copies honest: it reads
 * every Dockerfile and fails if any of them disagrees with the list
 * `IMAGE_REQUIRED_ENV` gives it.
 *
 * **Required means the process refuses to start**, not that it matters. The
 * verifier tokens, the OpenRouter key and the Mastodon instance list are all
 * read lazily and all degrade to a named, reported failure of one capability —
 * so a deploy that lacks them is diminished, not broken, and stopping it would
 * be wrong. Only a variable whose absence makes the process exit belongs here.
 *
 * **This array is the base every image needs, and not the whole contract.** A
 * variable one image cannot start without is declared for that image in
 * `IMAGE_REQUIRED_ENV` below; adding it here instead would stop a deploy of the
 * three processes that never read it, and a check that is wrong in that
 * direction is one people switch off.
 */
export const REQUIRED_ENV = [DATABASE_URL_VAR, BAN_SALT_VAR] as const

/**
 * What `apps/api` additionally cannot start without.
 *
 * `DEPOSIT_SEALING_KEY` seals the secret half of every deposit address and
 * `server.ts` throws without it. The three runners never construct the deposit
 * desk and would not notice its absence — which is why it took `#252` to have
 * anywhere to be declared, and why `#250` found `main` red instead.
 */
export const API_REQUIRED_ENV = [...REQUIRED_ENV, DEPOSIT_SEALING_KEY_VAR] as const

/**
 * Every image built from this repository, and the list each one declares.
 *
 * **Keyed by the Dockerfile's directory, because the test reads the file.** An
 * image added without an entry here is an image whose label nothing checks, so
 * `required-env.test.ts` asserts that this record and the set of Dockerfiles in
 * the repository are the same set — a new image cannot be quietly omitted.
 */
export const IMAGE_REQUIRED_ENV = {
  'apps/api': API_REQUIRED_ENV,
  'apps/verifier-runner': REQUIRED_ENV,
  'apps/moderation-runner': REQUIRED_ENV,
  'apps/support-triage-runner': REQUIRED_ENV,
  'apps/badge-runner': REQUIRED_ENV,
} as const satisfies Record<string, readonly string[]>

/** The label the images carry their list in. */
export const REQUIRED_ENV_LABEL = 'ai.kolonie.required-env'

/** The label's value: the form `preflight_env()` parses. */
export function requiredEnvLabelValue(names: readonly string[] = REQUIRED_ENV): string {
  return names.join(',')
}
