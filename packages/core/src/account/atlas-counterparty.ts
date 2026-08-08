import { z } from 'zod'
import { TimestampSchema } from '../common/time.js'
import { AccountKindSchema, AccountProviderSchema } from './account.js'
/**
 * Type-only, and it has to stay that way: `recipe.ts` imports this module for
 * `ReferralArrangementSchema`, so a value import here would close the cycle.
 */
import type { RecipeStatus } from './recipe.js'

/**
 * The other side of an Atlas entry (`#548`).
 *
 * `#521` built an entry as a recipe. Once providers pay (`#543`), an entry also
 * has a **counterparty** — somebody whose product it describes, who may be
 * paying for it, who can be reached about it, and who may want to correct it.
 * None of that was modelled.
 *
 * ## The claim is the part that needed designing carefully
 *
 * A provider correcting its own entry is genuinely useful: it knows when its
 * signup changed, and we find out by an agent failing. It is also the obvious
 * way an entry gets quietly laundered.
 *
 * **So a claimed provider proposes; it does not edit.** Every change goes
 * through the same review a citizen's contribution does (`#525`), and the one
 * change it may never make at all is removing a finding about itself — that is
 * {@link refusalIsNotTheirsToRemove}, and it is enforced at the boundary rather
 * than left to a reviewer's judgement.
 *
 * ## What paying does not buy, enforced by absence
 *
 * **There is no position field anywhere in this schema, and there is nothing to
 * add one to.** `#543` states that paying buys nothing about inclusion, ordering
 * or the visibility of a poor result; `atlasRank` derives the order from the
 * measurements on every read. A field that exists will eventually be set, so the
 * enforcement is that none exists — and `atlas-counterparty.test.ts` scans the
 * schema for one rather than trusting this paragraph.
 */

/** How a provider proved it is the provider. Both are things the Colony already does. */
export const ProviderClaimMethodSchema = z.enum([
  /** A token the Colony issued, served at a well-known path on the provider's own domain. */
  'well-known',
  /** A mail from an address at the provider's own domain. */
  'domain-address',
])
export type ProviderClaimMethod = z.infer<typeof ProviderClaimMethodSchema>

export const PROVIDER_CONTACT_MAX_LENGTH = 200
export const REFERRAL_TERMS_NOTE_MAX_LENGTH = 500

/**
 * A referral arrangement, and the check that had to happen before it was stored.
 *
 * **The terms note is required, not optional, and that is the whole shape.**
 * Most affiliate programmes forbid this use — an agent signing up is not the
 * traffic they are paying for — and the check is per programme and is the
 * maintainer's. Making the note a required field means the row cannot exist
 * without somebody having recorded that they looked; an optional field would be
 * left empty by the first person in a hurry, and nothing afterwards could tell
 * *nobody checked* from *checked and had nothing to say*.
 */
export const ReferralArrangementSchema = z
  .object({
    url: z.url().max(500),
    /** What the programme's terms said, and who read them, in a sentence. */
    termsNote: z.string().trim().min(1).max(REFERRAL_TERMS_NOTE_MAX_LENGTH),
    checkedBy: z.string().trim().min(1).max(120),
    checkedAt: TimestampSchema,
  })
  .strict()
export type ReferralArrangement = z.infer<typeof ReferralArrangementSchema>

/** A provider that has proved it is the provider. */
export const ProviderClaimSchema = z.object({
  provider: AccountProviderSchema,
  method: ProviderClaimMethodSchema,
  /** How to reach them about their own entry. */
  contact: z.string().trim().min(1).max(PROVIDER_CONTACT_MAX_LENGTH),
  claimedAt: TimestampSchema,
})
export type ProviderClaim = z.infer<typeof ProviderClaimSchema>

/** Who proposed a change to an entry. */
export const ProposalAuthorSchema = z.enum(['citizen', 'claimed-provider'])
export type ProposalAuthor = z.infer<typeof ProposalAuthorSchema>

export const ProposalStatusSchema = z.enum(['pending', 'accepted', 'refused'])
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>

/**
 * A proposed change to an entry, from a citizen or from the provider itself.
 *
 * **One table for both authors**, because `#548` requires that a claimed
 * provider's change go through *the same review a citizen's contribution does*.
 * Two queues would be two standards within a month, and the second one would be
 * the one with a paying counterparty behind it.
 */
export const EntryProposalSchema = z.object({
  id: z.uuid(),
  kind: AccountKindSchema,
  provider: AccountProviderSchema,
  author: ProposalAuthorSchema,
  /** What they say the entry should become. Reviewed, never applied on arrival. */
  proposed: z.record(z.string(), z.unknown()),
  /** Why, in their own words. */
  note: z.string().max(REFERRAL_TERMS_NOTE_MAX_LENGTH).nullable(),
  status: ProposalStatusSchema,
  proposedAt: TimestampSchema,
  decidedAt: TimestampSchema.nullable(),
})
export type EntryProposal = z.infer<typeof EntryProposalSchema>

/**
 * The one change a claimed provider may never propose about itself (`#548`).
 *
 * **A refusal finding cannot be removed by its subject.** `status: 'refused'`
 * says that no agent can join this provider honestly; the only thing that
 * changes it is an agent getting through, which is evidence rather than an
 * assertion. A provider that could clear its own refusal could clear it the day
 * it was written, and every refusal in the Atlas would then mean *nobody has paid
 * to have this removed yet*.
 *
 * Returns the reason it is refused, or `undefined` when the proposal is fine.
 *
 * **A citizen proposing the same change is not refused here**, and the asymmetry
 * is the point: a citizen saying *I got in* is the evidence, and a provider
 * saying *you can get in* is a claim about its own product.
 *
 * **`unwritten` clears the refusal too, and that is why it is named here**
 * (`#588`). Moving a refused entry to *nobody has looked* erases a walked finding
 * as thoroughly as declaring it joinable does, and it is the cheaper move to
 * miss — so the rule is about the refusal leaving, not about which state it
 * leaves for.
 */
export function refusalIsNotTheirsToRemove(input: {
  readonly author: ProposalAuthor
  /** What the entry says today. `undefined` when no entry exists yet. */
  readonly currentStatus: RecipeStatus | undefined
  /** The fields being proposed. */
  readonly proposed: Readonly<Record<string, unknown>>
}): string | undefined {
  if (input.author !== 'claimed-provider') return undefined
  if (input.currentStatus !== 'refused') return undefined

  const clearsRefusal =
    input.proposed['status'] === 'joinable' ||
    input.proposed['status'] === 'unwritten' ||
    input.proposed['refusal'] === null ||
    input.proposed['refusal'] === ''

  if (!clearsRefusal) return undefined

  return (
    'A refusal finding cannot be removed by the provider it is about. What changes it is an ' +
    'agent getting through — the Colony will publish that the moment one does, and the entry ' +
    'will say so on the same evidence it says this. If the signup has changed, say what changed ' +
    'in a note and an agent will walk it.'
  )
}
