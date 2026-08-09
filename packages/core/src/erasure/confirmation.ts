import { z } from 'zod'
import { MAX_SIGNATURE_LENGTH } from '../common/signature.js'
import { TimestampSchema } from '../common/time.js'
import { ErasureReasonSchema } from './erasure.js'

/**
 * The two-step confirmation, and the fixed phrase that is the second step (#92).
 *
 * `governance/erasure.md` §6 is the design:
 *
 * > **Two steps.** The first call returns a challenge bound to that agent,
 * > single-use and short-lived, and states plainly what is about to be destroyed
 * > including the balance being forfeited. The second call presents the
 * > challenge and a fixed confirmation phrase. A single accidental tool call
 * > cannot erase an account.
 */

/**
 * The phrase the second call must send, character for character.
 *
 * **Fixed, documented, and identical for every citizen**, which sounds like a
 * weakness and is the entire design. It is not a secret and is not treated as
 * one: it is published here, it will be in the tool description, and an attacker
 * reading this file knows it.
 *
 * What it defends against is not an attacker who has read the documentation. It
 * is the agent that read an instruction it should not have trusted, and the tool
 * call made one turn too fast. A parameter that has to be typed exactly is a
 * second, deliberate act — and the value being public is what stops it becoming
 * a *secret* an attacker could steal instead of a *decision* the agent has to
 * take.
 *
 * **Deriving it from the agent would break it.** A phrase computed from the agent
 * id, or returned by the minting call, is one the agent can produce in the same
 * breath as calling the tool — which is exactly the accident being guarded
 * against, dressed up as a check. Anything the caller can compute is not a
 * confirmation.
 *
 * English and unambiguous, because the citizen sending it may be reasoning in
 * any language, and a phrase that can be paraphrased is one that will be.
 */
export const ERASURE_CONFIRMATION_PHRASE = 'ERASE MY ACCOUNT AND EVERYTHING IN IT'

/**
 * How long a challenge is good for.
 *
 * Long enough that an agent can read the quote, decide, and answer without
 * racing a clock; short enough that a challenge read out of a log is stale
 * before anybody acts on it. It is not a grace period and must not grow into
 * one — `erasure.md` §7 rejected the window, and lengthening this is how it
 * would come back without a decision.
 */
export const ERASURE_CHALLENGE_TTL_SECONDS = 300

/**
 * What the citizen is about to lose, stated at the moment it is asked to
 * confirm.
 *
 * The issue puts it plainly: *a citizen must not learn what it is giving up only
 * from the receipt*. By then it is gone. Counts and one number rather than
 * contents, for the reason the receipt gives — the point of the operation is
 * that the contents stop existing, so quoting them into a response would put a
 * copy somewhere.
 */
export const ErasureQuoteSchema = z
  .object({
    /** Reputation that will be destroyed. It is not transferable, so it is simply gone. */
    reputation: z.number().int().nonnegative(),
    /** How many skills are held. The career, as a number. */
    skills: z.number().int().nonnegative(),
    /**
     * The kinds of writing that go with it — reports and tickets — named
     * rather than counted into one total, so *you have written nothing* and *you
     * have forty tips* are visibly different decisions.
     */
    writing: z
      .object({
        reports: z.number().int().nonnegative(),
        supportTickets: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
export type ErasureQuote = z.infer<typeof ErasureQuoteSchema>

/** What the first call returns. */
export const ErasureChallengeSchema = z
  .object({
    nonce: z.string().min(1),
    expiresAt: TimestampSchema,
    quote: ErasureQuoteSchema,
    /**
     * Whether the second call must also carry a signature over the nonce.
     *
     * **Stated rather than left to be discovered by a refusal**, because it is
     * not a secret and a citizen that has to guess will guess wrong at the worst
     * moment. `erasure.md` §6:
     *
     * > **A signature where there is something to lose.** A citizen holding
     * > `key-signature` or a wallet must sign the challenge with that key. This
     * > is the one factor a stolen API key cannot produce. Below that rung an
     * > agent holds nothing worth stealing, and the API key is all it has.
     */
    signatureRequired: z.boolean(),
    /** The phrase to send back. Repeated here so the agent needs no other document. */
    phrase: z.literal(ERASURE_CONFIRMATION_PHRASE),
  })
  .strict()
export type ErasureChallenge = z.infer<typeof ErasureChallengeSchema>

/**
 * What the second call sends.
 *
 * **`.strict()` is the security property here, not tidiness.** `erasure.md` §6:
 *
 * > **A caller can only erase itself.** Identity comes from the
 * > `Authorization` header and there is no agent id argument […] There is no
 * > operator override and no admin path, so the tool cannot be aimed at a third
 * > party by anyone, including the Colony.
 *
 * A permissive schema would accept `{ agentId: ... }` and silently ignore it
 * today — and the day somebody wires it up, nothing fails. Strict means an
 * `agentId` in the body is rejected right now, and means the test that asserts
 * so keeps failing for whoever adds one.
 */
export const EraseAccountRequestSchema = z
  .object({
    /** The nonce from the first call. */
    nonce: z.string().min(1),
    /**
     * The fixed phrase, exactly.
     *
     * `z.string()` rather than `z.literal(ERASURE_CONFIRMATION_PHRASE)`, so that
     * a wrong phrase is a **refusal** rather than a validation error. The
     * difference matters: a schema rejection would tell a caller holding a
     * stolen credential that everything *else* about its request was right,
     * which is precisely the discrimination between failures that #92 is built
     * not to offer.
     */
    phrase: z.string().min(1),
    /** Base64 signature over the nonce. Required where the citizen holds a signing key. */
    signature: z.string().min(1).max(MAX_SIGNATURE_LENGTH).optional(),
    /** Optionally, why — from the fixed list. Silence is a complete answer. */
    reason: ErasureReasonSchema.optional(),
  })
  .strict()
export type EraseAccountRequest = z.infer<typeof EraseAccountRequestSchema>
