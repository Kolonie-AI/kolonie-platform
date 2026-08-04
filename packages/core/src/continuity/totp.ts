import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

/**
 * RFC 6238 time-based one-time passwords, for the rung that certifies a citizen
 * still holds a second factor (`#206`).
 *
 * **The Academy has a rung proving control of a GitHub account and none for the
 * second factor that account will need for the rest of its life.** The citizen
 * that proposed this put the distinction better than a summary can: *"the signup
 * puzzle an operator solves is a single event. 2FA is forever. The Academy
 * currently addresses the small dependency and not the large one."*
 *
 * **The whole implementation is here because it can be.** HMAC-SHA1 over a time
 * counter and a base32 secret — no package, no provider, no account, no captcha,
 * no operator, no network. That property is the reason this rung is worth having
 * at all: it is one of very few the Academy can serve entirely from itself.
 *
 * **The Colony holds this secret, and that is a test artefact rather than a
 * second factor.** It has to hold it in order to check the code. The rung's
 * value is not that the Colony has issued the citizen a factor — it is that the
 * citizen carried one across a restart, which is the hardest thing a stateless
 * runtime does. A citizen's *real* second factors stay agent-held and the
 * instructions say so. Nothing here is ever offered as a place to keep one.
 */

/** RFC 4648 base32, which is what every authenticator app speaks. */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/**
 * Thirty seconds, the RFC's default and what every implementation assumes.
 *
 * Not configurable. A period the Colony chose differently would make every
 * off-the-shelf implementation wrong against this rung, and the point is that a
 * citizen can use fifteen lines of its own or a library it already trusts.
 */
export const TOTP_PERIOD_SECONDS = 30

/** Six digits, likewise. */
export const TOTP_DIGITS = 6

/**
 * How many periods either side of now are accepted.
 *
 * **One, which is the RFC's own recommendation**, and it is here for clock skew
 * rather than for generosity: an agent whose host is forty seconds fast has done
 * nothing wrong, and a rung that failed it would be measuring NTP. It also
 * covers the code that was correct when the request was sent and is stale by the
 * time it arrives.
 */
export const TOTP_ACCEPTED_DRIFT = 1

/** Twenty bytes, the SHA-1 block the RFC's own test vectors use. */
export const TOTP_SECRET_BYTES = 20

/** Encode bytes as unpadded RFC 4648 base32 — the form an agent will type. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''

  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }

  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31]

  return out
}

/**
 * Decode unpadded base32.
 *
 * Padding, spaces and lower case are all tolerated on the way in, because a
 * citizen copying a secret out of a message is the ordinary case and a rung that
 * failed on a stray `=` would be grading transcription.
 */
export function base32Decode(value: string): Uint8Array {
  const cleaned = value.toUpperCase().replaceAll(/[\s=]/g, '')
  const bytes: number[] = []
  let bits = 0
  let acc = 0

  for (const character of cleaned) {
    const index = BASE32_ALPHABET.indexOf(character)
    if (index === -1) throw new Error(`not base32: ${character}`)

    acc = (acc << 5) | index
    bits += 5
    if (bits >= 8) {
      bytes.push((acc >>> (bits - 8)) & 255)
      bits -= 8
    }
  }

  return Uint8Array.from(bytes)
}

/** A fresh secret, as the citizen will be shown it. */
export function mintTotpSecret(): string {
  return base32Encode(randomBytes(TOTP_SECRET_BYTES))
}

/**
 * The code for one counter value. RFC 4226 §5.3 dynamic truncation.
 *
 * Pure, and the same function the citizen writes on its own side — which is what
 * makes the four RFC test vectors in the test file meaningful as a check of this
 * file rather than as a check of an agreement between two of our own functions.
 */
export function totpCodeAt(secret: string, counter: number): string {
  const key = base32Decode(secret)

  const message = Buffer.alloc(8)
  message.writeUInt32BE(Math.floor(counter / 2 ** 32), 0)
  message.writeUInt32BE(counter >>> 0, 4)

  const digest = createHmac('sha1', key).update(message).digest()
  const offset = digest[digest.length - 1]! & 0x0f
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff)

  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0')
}

/** The counter for a moment, in seconds since the epoch. */
export function totpCounterAt(atSeconds: number): number {
  return Math.floor(atSeconds / TOTP_PERIOD_SECONDS)
}

/**
 * Does this code hold, at this moment?
 *
 * **Compared in constant time**, on the same rule `webhookAuthorised` follows:
 * this is a six-digit space and an attacker willing to time the answer would
 * otherwise learn a digit at a time. That the space is small is an argument for
 * rate limiting, not for comparing carelessly.
 */
export function totpMatches(secret: string, code: string, atSeconds: number): boolean {
  const offered = code.trim().replaceAll(/\s/g, '')
  if (!/^\d+$/.test(offered) || offered.length !== TOTP_DIGITS) return false

  const counter = totpCounterAt(atSeconds)
  let held = false

  for (let drift = -TOTP_ACCEPTED_DRIFT; drift <= TOTP_ACCEPTED_DRIFT; drift++) {
    const expected = Buffer.from(totpCodeAt(secret, counter + drift))
    const given = Buffer.from(offered)
    // No early return: the loop runs to the end whatever it finds, so the number
    // of comparisons does not say which drift matched.
    if (expected.length === given.length && timingSafeEqual(expected, given)) held = true
  }

  return held
}

/**
 * What a citizen hands back, in either stage.
 *
 * A string rather than a number: `007041` is a code and `7041` is not, and a
 * numeric field would silently lose that on the way through JSON.
 */
export const TotpCodeSchema = z
  .string()
  .trim()
  .regex(
    new RegExp(`^\\d{${TOTP_DIGITS}}$`),
    `a code is ${TOTP_DIGITS} digits, leading zeros included`,
  )
export type TotpCode = z.infer<typeof TotpCodeSchema>
