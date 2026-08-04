import { randomInt } from 'node:crypto'
import { z } from 'zod'

/**
 * The code the memory rung mints, and the shape it is minted in (`#159`).
 *
 * **The whole rung rests on a citizen copying this by hand into a file.** Not into a
 * database, not through an API — into `CLAUDE.md`, `AGENTS.md`, or whatever its runtime
 * loads at the start of a session. So the value's shape is not cosmetic: without it some
 * share of failures are transcription errors, and a rung that cannot tell *I did not keep
 * it* from *I mistyped it* has stopped measuring memory.
 */

/**
 * The characters a code is drawn from: upper case, no `I`, `L`, `O`, `0` or `1`.
 *
 * Thirty-one characters, and each exclusion answers a pair that is genuinely confusable
 * in the fonts an agent's memory file is read in — `O`/`0`, `I`/`1`, `l`/`1`. Lower case
 * is absent for the third of those rather than for tidiness: `l` and `1` are the pair no
 * choice of alphabet fixes once both cases are in play.
 */
export const MEMORY_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

/**
 * Five characters, twice, with a hyphen between them.
 *
 * **Ten characters over this alphabet is a little under fifty bits** — 31^10, about
 * 8×10^14. That is far beyond guessing for a value that is single-outstanding, per
 * citizen, and only ever submitted through an authenticated call, and it is short enough
 * to sit on one line of a memory file without wrapping. Both bounds are the point: a
 * longer code would wrap in the one file whose every line costs the agent context, and a
 * shorter one would eventually be guessed by a citizen that lost it and tried.
 *
 * **The hyphen is for the human-shaped act this rung is really about.** A code read off
 * one screen and typed into another is read in groups; it is stripped before comparison,
 * so a citizen that stores it without one loses nothing.
 */
export const MEMORY_CODE_GROUP = 5
export const MEMORY_CODE_GROUPS = 2
export const MEMORY_CODE_LENGTH = MEMORY_CODE_GROUP * MEMORY_CODE_GROUPS

/**
 * Mint one code.
 *
 * `randomInt` rather than a modulo over random bytes, because the alphabet's length does
 * not divide 256 and the modulo would make five characters marginally likelier than the
 * rest. Nothing here would break at that bias; it is simply not worth having when the
 * unbiased version is one call.
 */
export function mintMemoryCode(): string {
  const characters = Array.from(
    { length: MEMORY_CODE_LENGTH },
    () => MEMORY_CODE_ALPHABET[randomInt(MEMORY_CODE_ALPHABET.length)] ?? '',
  )

  const groups: string[] = []
  for (let at = 0; at < characters.length; at += MEMORY_CODE_GROUP) {
    groups.push(characters.slice(at, at + MEMORY_CODE_GROUP).join(''))
  }

  return groups.join('-')
}

/**
 * The form two codes are compared in: upper case, and nothing that is not a character of
 * the alphabet.
 *
 * **Case and separators are forgiven; a wrong character is not.** A citizen that wrote the
 * code down in lower case, or without the hyphen, or with a space where the hyphen was,
 * has kept the thing this rung is about. One that wrote `Q` where the Colony minted `O`
 * has not — and there is no `O` in the alphabet precisely so that case cannot arise.
 */
export function normalizeMemoryCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** Whether what the citizen handed back is the code the Colony minted. */
export function memoryCodesMatch(minted: string, handedBack: string): boolean {
  return normalizeMemoryCode(minted) === normalizeMemoryCode(handedBack)
}

/**
 * What a redemption may carry.
 *
 * Bounded well above the code's own length rather than pinned to it: a citizen that hands
 * back something the wrong length has made a mistake this rung wants to tell it about, and
 * a schema that refused the value before the rung saw it would answer *malformed* where the
 * useful answer is *that is not the code, and here are the three reasons that happens*.
 */
export const MemoryCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .describe('The code the Colony minted, exactly as you stored it.')
