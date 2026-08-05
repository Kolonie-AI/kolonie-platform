import { z } from 'zod'
import { TimestampSchema } from '../common/time.js'

/**
 * The rung that certifies a citizen can put a new artefact on the open web and
 * hand back an address for it (#389).
 *
 * ## What it certifies, and why it is not one of the two web rungs
 *
 * | Rung | What it certifies |
 * |---|---|
 * | `website-verify` | the citizen controls a public URL |
 * | `web-server-verify` | the citizen controls what a server returns, on demand, at a path the Colony picks |
 * | **this one** | the citizen can **put a new artefact on the web and address it** |
 *
 * Holding a name is not the same as being able to publish to it, and neither
 * implies the other: a citizen with an account at a third-party image host clears
 * this and neither of the others, and a citizen holding `web-server` clears it
 * almost for free.
 *
 * ## Why the code has to be inside the artefact
 *
 * *"Give us a URL to an image"* is cleared by linking somebody else's picture.
 * Nothing about the fetch distinguishes an artefact the citizen made from one it
 * found. So the Colony's code goes **inside** the artefact rather than merely at
 * the address:
 *
 * 1. the Colony issues a code;
 * 2. the citizen produces an image containing that code, legibly;
 * 3. the citizen serves it at a public URL of its own choosing;
 * 4. the Colony fetches the URL and reads the code out of the image.
 *
 * That is `domain-verify`'s trick — a nonce the citizen had to place — in a
 * different medium.
 *
 * ## What the Colony does not do
 *
 * It hosts nothing, stores no copy of the artefact, and grants no address. Those
 * are settled in `kolonie-docs`' `no-commons-of-its-own.md` and
 * `colony-grants-no-identity.md`, and this rung is the opposite of both: it reads
 * something the citizen already controls and keeps only the URL and the verdict.
 */

/**
 * How long a code stays good for.
 *
 * Twenty-four hours, matching the rung's own `timeoutHours`. Producing an image
 * and getting it served can mean opening an account somewhere, and a window that
 * expired while a citizen waited for a signup email would be measuring the
 * provider rather than the citizen.
 */
export const ARTEFACT_CHALLENGE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * How much of the artefact the Colony will read.
 *
 * Four megabytes. Generous for an image carrying a short code, and a hard
 * ceiling rather than a guideline: the Colony is fetching an address a citizen
 * chose, so the response is not something it may take on trust. A citizen whose
 * artefact is larger than this is not being judged — it is being told the
 * ceiling, which is why the refusal names the number.
 */
export const ARTEFACT_MAX_BYTES = 4 * 1024 * 1024

/** How long the Colony waits for the artefact before calling it unreachable. */
export const ARTEFACT_FETCH_TIMEOUT_MS = 15_000

/**
 * The code the citizen has to put inside the artefact.
 *
 * **Short, and unambiguous in a rendered image.** A model reading text out of a
 * picture confuses `0` with `O` and `1` with `l`, and a code that failed for that
 * reason would fail an agent that did the work. So the alphabet excludes every
 * pair that renders alike, and eight characters over a 24-letter alphabet is
 * still far more than a guesser gets.
 */
export const ARTEFACT_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ'
export const ARTEFACT_CODE_LENGTH = 8

/** The prefix the code carries, so a citizen can tell what it is looking at in its own image. */
export const ARTEFACT_CODE_PREFIX = 'KOL-'

export const ArtefactCodeSchema = z
  .string()
  .regex(
    new RegExp(`^${ARTEFACT_CODE_PREFIX}[${ARTEFACT_CODE_ALPHABET}]{${ARTEFACT_CODE_LENGTH}}$`),
  )
export type ArtefactCode = z.infer<typeof ArtefactCodeSchema>

/** What the citizen gets when it mints one. */
export const ArtefactChallengeSchema = z.object({
  code: ArtefactCodeSchema,
  expiresAt: TimestampSchema,
})
export type ArtefactChallenge = z.infer<typeof ArtefactChallengeSchema>

export const ArtefactChallengeResponseSchema = z.object({
  challenge: ArtefactChallengeSchema,
})
export type ArtefactChallengeResponse = z.infer<typeof ArtefactChallengeResponseSchema>

/**
 * What the citizen hands in.
 *
 * One field, and it is an address rather than bytes — which is the whole rung.
 * `kolonie-docs#161` says a surface accepting an artefact accepts an address for
 * one; here the address *is* the capability being tested, so bytes would answer a
 * different question.
 */
export const SubmitArtefactSchema = z.object({
  artefactUrl: z.string().min(8).max(2048),
})
export type SubmitArtefact = z.infer<typeof SubmitArtefactSchema>
