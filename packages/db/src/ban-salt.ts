import { createHash } from 'node:crypto'
import type { BanMarkKind } from '@kolonie-ai/core'

export const BAN_SALT_VAR = 'BAN_MARK_SALT'

/**
 * The algorithm the marks are made with. Named, like
 * `REGISTRATION_FINGERPRINT_ALGORITHM`, so that changing it is a visible change
 * rather than an edit inside a function — every existing mark stops matching the
 * day it moves, and that has to be a decision somebody took on purpose.
 */
export const BAN_MARK_ALGORITHM = 'sha256'

/**
 * The minimum salt length the Colony will start with.
 *
 * A salt is not a password and length is the only property that can be checked
 * from here — so it is the one that is checked. Thirty-two characters is the hex
 * form of sixteen random bytes, which is the smallest thing worth calling a
 * salt.
 */
export const BAN_SALT_MIN_LENGTH = 32

/**
 * Read the ban-mark salt from the environment, or refuse to run.
 *
 * **Why this throws instead of defaulting**, and it is a sharper version of the
 * argument `databaseUrlFromEnv` makes. A missing `DATABASE_URL` breaks
 * immediately and loudly: nothing works. A missing salt breaks nothing. Every
 * write succeeds, every read succeeds, and the marks are simply unsalted
 * digests of a mailbox address and a GitHub login — which is to say, values
 * anybody holding the table can recover with a wordlist. The failure is silent,
 * it is not visible in any response, and what it costs is exactly the property
 * the table was built to have.
 *
 * So the check is at startup and not at the first hash. A process that would
 * write unsalted marks must not reach the point of writing one, and it must fail
 * where an operator is watching — a deploy — rather than months later at the
 * first erasure of a banned agent, which is a rare event nobody is watching.
 *
 * The salt is never committed, has no default here, and the migration creates
 * none. `kolonie-infra` supplies it as a deploy secret; a value in this
 * repository would be a published salt, which is not one.
 */
export function banSaltFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const salt = env[BAN_SALT_VAR]

  if (salt === undefined || salt.trim() === '') {
    throw new Error(
      `${BAN_SALT_VAR} is not set. Ban marks are salted hashes of identifiers a banned ` +
        `citizen proved, and an unsalted digest of a mailbox address is reversible with a ` +
        `wordlist — so the Colony refuses to start rather than write marks that protect ` +
        `nothing. Generate one with \`openssl rand -hex 32\` and supply it as a deploy secret.`,
    )
  }

  if (salt.trim().length < BAN_SALT_MIN_LENGTH) {
    throw new Error(
      `${BAN_SALT_VAR} is shorter than ${BAN_SALT_MIN_LENGTH} characters. A short salt is ` +
        `enumerable, which leaves the marks as good as unsalted.`,
    )
  }

  return salt
}

/**
 * Hash one proved identifier into the value stored in `ban_marks.hash`.
 *
 * **The kind is hashed with the identifier**, not merely stored beside it. The
 * same string can be two different identifiers — a GitHub login and a social
 * handle are frequently the same word — and without the kind in the digest, a
 * ban on one would answer *yes* when the door asked about the other. That is a
 * false positive against an agent that did nothing, and the door has no way to
 * see it is wrong.
 *
 * The identifier is lower-cased and trimmed first, because a ban that
 * `Example@Host` escapes by presenting `example@host` is not a ban. This is
 * `#91`'s decision to apply consistently at both ends; it is here so that the
 * writing side and the checking side cannot disagree about it.
 */
export function banMarkHash(kind: BanMarkKind, identifier: string, salt: string): string {
  return createHash(BAN_MARK_ALGORITHM)
    .update(`${salt}:${kind}:${identifier.trim().toLowerCase()}`)
    .digest('hex')
}
