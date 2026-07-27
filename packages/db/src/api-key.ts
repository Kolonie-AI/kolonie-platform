import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { API_KEY_PREFIX, ApiKeySchema, type ApiKey } from '@kolonie-ai/core'

/**
 * How much randomness an issued key carries, before encoding.
 *
 * 256 bits. The number that matters is not the length of the string but the
 * work an attacker must do to guess one valid key out of the whole space, and
 * at 256 bits that number is not reachable by anyone. Raising it later is
 * harmless — the column stores a fixed-width hash either way — but lowering it
 * would invalidate the reasoning below about why no slow hash is needed.
 */
export const API_KEY_ENTROPY_BYTES = 32

/**
 * The hash algorithm the `credentials.secret_hash` column holds.
 *
 * DECISION (2026-07-28, D-010): plain SHA-256, unsalted, hex-encoded. This looks
 * wrong to anyone who has learned "never store a password as a fast hash", and
 * the reason it is right here is that an API key is not a password.
 *
 * A password is chosen by a human, comes from a small and heavily biased space,
 * and is usually reused elsewhere. That is what bcrypt and Argon2 exist for:
 * they make each guess expensive because the number of plausible guesses is
 * small. A key from {@link API_KEY_ENTROPY_BYTES} random bytes has no plausible
 * guesses. Stretching it slows down the Colony's own authentication and defends
 * against nothing.
 *
 * There is also a hard constraint, and it is the one that actually decides this.
 * `credentials.secret_hash` carries a unique index, and the schema comment
 * states that authentication hashes the presented key and *looks it up* through
 * that index. A per-row salt would make the hash unreproducible from the key
 * alone, so authentication would have to scan every credential row and compare
 * one at a time. That is O(all credentials) per request on the Colony's hottest
 * path, and it gets worse with every agent that registers.
 *
 * What is deliberately *not* claimed: this protects a stolen key. Nothing does.
 * It protects the database — a dump of `credentials` yields no usable key.
 */
export const API_KEY_HASH_ALGORITHM = 'sha256'

/**
 * Mint a new API key.
 *
 * The plaintext returned here is the only copy that will ever exist: the caller
 * hands it to the agent once, stores {@link hashApiKey} of it, and forgets it.
 * Nothing may log this value, persist it, or put it on an entity — see
 * `CredentialSchema` in core, which omits the secret for exactly that reason.
 *
 * base64url rather than hex: same entropy in two thirds of the characters, and
 * no `+` or `/` to be mangled by an agent that pastes the key into a URL or a
 * shell without quoting it.
 */
export function generateApiKey(): ApiKey {
  const key = `${API_KEY_PREFIX}${randomBytes(API_KEY_ENTROPY_BYTES).toString('base64url')}`
  // Parsing rather than casting: if the prefix or the length ever drifts out of
  // what core promises, this throws at the point of issue instead of handing an
  // agent a key that its own validation will later reject.
  return ApiKeySchema.parse(key)
}

/**
 * The stored form of a key. Deterministic, so it doubles as the lookup value on
 * `credentials.secret_hash` — see {@link API_KEY_HASH_ALGORITHM}.
 */
export function hashApiKey(key: string): string {
  return createHash(API_KEY_HASH_ALGORITHM).update(key, 'utf8').digest('hex')
}

/**
 * Compare two stored hashes without leaking, through timing, how many leading
 * characters matched.
 *
 * The unique index means authentication normally compares nothing — Postgres
 * finds the row or does not. This exists for the paths that do compare in
 * application code, so that the safe comparison is the one already at hand
 * rather than something each caller has to remember to reach for.
 */
export function apiKeyHashEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  // timingSafeEqual throws on a length mismatch, which would itself be an
  // observable signal. Hashes are fixed-width, so unequal lengths mean one side
  // is not a hash at all.
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
