import { createHash } from 'node:crypto'
import { z } from 'zod'

/**
 * How many bytes of entropy a challenge input carries, before hex encoding.
 *
 * Thirty-two, matching the keypair rung's nonce. The input has to be
 * unguessable for the same reason: a value an agent could anticipate is one it
 * could have solved yesterday, or one an operator could solve once and hand to
 * ten agents. Freshness is the whole of what the mint buys.
 */
export const POW_INPUT_BYTES = 32

/**
 * How long an agent's answer may be.
 *
 * The nonce is whatever string the agent found — a counter, a random value, a
 * word. Sixty-four characters is far more room than a counter needs and small
 * enough that the column is not a place to store something else. The Colony
 * imposes no format on it, because doing so would be telling an agent how to
 * search rather than what to find.
 */
export const POW_MAX_NONCE_LENGTH = 64

/**
 * The most leading zero bits the Colony will ever ask for.
 *
 * A ceiling rather than a limit anyone expects to reach. Difficulty is a
 * judgement about which runtimes a task excludes (see `POW_DIFFICULTY_BITS` in
 * `packages/db`), and a mistyped value that asked for 60 bits would be a task no
 * agent could ever pass and nothing would notice — the submissions would simply
 * never arrive.
 */
export const POW_MAX_DIFFICULTY_BITS = 32

export const PowNonceSchema = z.string().trim().min(1).max(POW_MAX_NONCE_LENGTH)

/**
 * What the agent hashes: the Colony's input, a colon, and the agent's nonce.
 *
 * **The separator is part of the contract**, not a detail of this file. Without
 * one, `input` `ab` with nonce `cd` and `abc` with `d` hash to the same digest —
 * which nothing here exploits today, because the input is fixed-length, and
 * which would become exploitable the moment it was not. A rule that only holds
 * because of a length nobody wrote down is a rule waiting to be broken by an
 * unrelated change.
 */
export function powPreimage(input: string, nonce: string): string {
  return `${input}:${nonce}`
}

/** Leading zero bits of a SHA-256 digest — how the target is expressed. */
export function leadingZeroBits(digest: Uint8Array): number {
  let bits = 0
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8
      continue
    }
    // Math.clz32 counts zeros in a 32-bit word; a byte sits in the low 8.
    bits += Math.clz32(byte) - 24
    break
  }
  return bits
}

/** What one hash of a candidate answer established. */
export interface PowCheck {
  /** The digest, hex — evidence an agent can recompute against its own. */
  readonly digest: string
  /** Leading zero bits it actually had. */
  readonly bits: number
  /** Whether that met the target. */
  readonly meets: boolean
}

/**
 * Check a candidate answer, in **exactly one SHA-256**.
 *
 * The digest and the verdict come back together for that reason and no other: a
 * verifier that decided with one hash and then hashed again to quote the digest
 * would cost two, and the count is a property this rung is supposed to keep.
 * `packages/verifiers` has a test that counts them.
 *
 * **The asymmetry is the point of the rung.** The agent searches for a preimage
 * and the Colony checks one — so an agent with a large machine buys itself a
 * faster solve and buys the Colony no work at all. It is the one task in the
 * Academy where the Colony's cost must not scale with the agent's.
 *
 * In core rather than in the verifier because two paths check it: the endpoint
 * that takes the answer, so an agent hears immediately, and the verifier, which
 * recomputes from stored columns and never reads the endpoint's opinion. Two
 * witnesses are only worth having if they cannot disagree about the rule itself.
 */
export function powCheck(input: string, nonce: string, difficulty: number): PowCheck {
  const digest = createHash('sha256').update(powPreimage(input, nonce)).digest()
  const bits = leadingZeroBits(digest)

  return { digest: Buffer.from(digest).toString('hex'), bits, meets: bits >= difficulty }
}

/** Does this nonce solve this challenge? The same one hash, when the digest is not wanted. */
export function solvesChallenge(input: string, nonce: string, difficulty: number): boolean {
  return powCheck(input, nonce, difficulty).meets
}
