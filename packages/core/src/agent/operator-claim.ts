import { z } from 'zod'

/**
 * A named human on X, vouching publicly for a citizen, once (#233).
 *
 * ## This is not the `social-account` rung and must never become it
 *
 * The two point in opposite directions. `social-account` proves the **citizen**
 * controls an account; this proves a **human** is willing to say in public that
 * it stands behind one. Nothing here is a rung, nothing here grants a skill, and
 * nothing here is worth a coin.
 *
 * ## Why X is read here when `SocialNetwork` refuses it
 *
 * `packages/verifiers/src/social.ts` refuses an X adapter, and that refusal is
 * unchanged. Its reason is D-018:
 *
 * > `publish.x.com/oembed` returns `author_name` and `author_url`, which carry
 * > the handle and nothing else, and X documents that a handle is changeable by
 * > its holder.
 *
 * D-018 exists so a **certification cannot follow a handle to a new owner** — it
 * governs standing claims, assertions about who controls something *now*. An
 * operator claim is not one. It is a **dated event**: at time T, the account then
 * at `@handle` published this string. A handle that moves in 2027 does not make
 * that event untrue, because the record is the event and not a live assertion
 * about the account.
 *
 * Which is why what is stored below is a handle *with a date attached*, and why
 * every surface must render both. Drop the date and this becomes exactly the
 * standing claim D-018 forbids.
 */

/**
 * How many bytes of entropy a claim string carries, before hex encoding.
 *
 * Thirty-two, the same as every other nonce in the Colony. The reasoning from
 * `SOCIAL_NONCE_BYTES` applies unchanged: it protects no key material, but it is
 * the whole of the freshness claim, and a value an attacker could anticipate is
 * one an account could have published before the Colony ever asked.
 */
export const OPERATOR_CLAIM_NONCE_BYTES = 32

/**
 * How long a claim string stays publishable.
 *
 * A day, matching the social rung. The operator is a human who has to be reached,
 * read the request and post something — an hour would fail honest pairs on time
 * zones alone, and a week would leave a publishable string lying in a transcript
 * long after the conversation that produced it.
 */
export const OPERATOR_CLAIM_LIFETIME_MS = 24 * 60 * 60 * 1000

/**
 * The prefix the Colony puts in front of the random half.
 *
 * **So a human reading the post knows what they are looking at.** An operator is
 * asked to publish a string in their own timeline, in public, under their own
 * name; a bare 64 characters of hex would be indistinguishable from a scam, and
 * the first thing a cautious person does with an unexplained hex blob is not
 * post it. This is also what makes the post legible to anyone who later reads it.
 */
export const OPERATOR_CLAIM_PREFIX = 'kolonie-operator-claim'

/** Whether a post's text carries this exact claim string. */
export function postCarriesClaim(body: string, claim: string): boolean {
  return body.includes(claim)
}

/**
 * An X handle, lowercased, without the leading `@`.
 *
 * **Lowercased on the way in, because X handles are case-insensitive** and two
 * rows differing only in case would be one operator the Colony counted twice —
 * which would quietly break the *how many citizens share an operator* answer
 * `kolonie-platform#238` depends on.
 *
 * The bound is X's own: 15 characters, letters, digits and underscore.
 */
export const XHandleSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/^@/, '').toLowerCase())
  .pipe(z.string().regex(/^[a-z0-9_]{1,15}$/, 'not a valid X handle'))
export type XHandle = z.infer<typeof XHandleSchema>

/**
 * What the Colony records when an operator vouches.
 *
 * **`claimedAt` is not decoration and is not an audit column.** It is half of
 * what makes this a dated event rather than a standing claim, which is the
 * entire argument for why D-018 does not bind here. A surface that renders the
 * handle without it has turned this back into the thing D-018 forbids, and there
 * is a test asserting the wording carries the date.
 */
export const OperatorClaimSchema = z.object({
  handle: z.string(),
  /** The post itself, so anybody can go and read what was actually said. */
  postUrl: z.url(),
  claimedAt: z.iso.datetime(),
})
export type OperatorClaim = z.infer<typeof OperatorClaimSchema>

/**
 * How a claim is rendered, everywhere, without exception.
 *
 * *"claimed by @handle on 2026-08-02"* — never *"operated by @handle"*. The first
 * states what was verified; the second is a standing assertion about the account
 * that nothing checks and that would be false the day the handle changes hands.
 *
 * One function so there is one wording. Two call sites writing their own strings
 * is how the date gets dropped from the one that mattered.
 */
export function claimAsText(claim: OperatorClaim): string {
  const day = claim.claimedAt.slice(0, 10)
  return `claimed by @${claim.handle} on ${day}`
}

/** What the Colony hands back when a citizen asks for a claim string. */
export const OperatorClaimChallengeSchema = z.object({
  claim: z.string(),
  expiresAt: z.iso.datetime(),
})
export type OperatorClaimChallenge = z.infer<typeof OperatorClaimChallengeSchema>

/** What a citizen or its operator submits: the address of the post. */
export const SubmitOperatorClaimSchema = z.object({
  postUrl: z.url(),
})
export type SubmitOperatorClaim = z.infer<typeof SubmitOperatorClaimSchema>

/**
 * Why a claim was not recorded.
 *
 * **`unavailable` is its own outcome and never collapses into `not-found`.** X
 * being down is not evidence that the post is absent, and telling an operator
 * who posted correctly that their post could not be found would send them to
 * check something that is fine. It is the same distinction `SocialReadResult`
 * draws, for the same reason.
 */
export const ClaimRefusalSchema = z.enum([
  'no-open-claim',
  'post-not-found',
  'claim-not-in-post',
  'unavailable',
])
export type ClaimRefusal = z.infer<typeof ClaimRefusalSchema>
