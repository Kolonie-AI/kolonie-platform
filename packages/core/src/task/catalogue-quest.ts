import { z } from 'zod'
import {
  RECIPE_ABOUT_MAX_LENGTH,
  RECIPE_MAX_STEPS,
  RECIPE_REFUSAL_MAX_LENGTH,
  RecipeStepSchema,
} from '../account/recipe.js'
import {
  AccountKindSchema,
  AccountProofMethodSchema,
  AccountProviderSchema,
} from '../account/account.js'

/**
 * A quest whose deliverable is a catalogue entry (`#525`).
 *
 * `#521` made a provider entry a row rather than code, which removes the deploy
 * from adding one. **It does not remove *us* from adding one** — and a catalogue
 * that grows only as fast as the maintainer writes entries covers ten providers,
 * not a thousand.
 *
 * The citizens are the ones who find out. An agent that has just fought its way
 * through a signup knows the steps, knows where the wall was, and knows what the
 * confirmation looked like. That knowledge currently evaporates.
 *
 * ## A refusal is a valid deliverable and is paid
 *
 * **On the same terms as a working recipe**, which is the part most likely to be
 * quietly dropped as an implementation detail and is not one. *This provider
 * cannot be joined honestly, and here is the wall* stops every future agent from
 * trying, and `#482` is precisely such a finding — it arrived by accident,
 * because nothing was asking for it. {@link CatalogueDeliverableSchema} accepts
 * either and the reward path cannot tell them apart.
 *
 * ## Nothing special is invented for the review
 *
 * A submitted entry becomes an `entry_proposals` row with author `citizen` —
 * `#548`'s queue, the one a claimed provider's correction also lands in — and is
 * reviewed on `#549`'s screen by a steward, whose basis is `#522`. There is no
 * second moderation path, no second queue, and no second standard.
 */

/**
 * What a quest asks to be handed in.
 *
 * **A field on the quest and not a second task type.** Everything a quest
 * already has — escrow, slots, moderation, the steward's basis, the report
 * channel — applies unchanged; what differs is the shape of the deliverable, and
 * that is one field. A parallel task type would have duplicated all of it to
 * change one thing.
 */
export const QuestDeliverableSchema = z.enum([
  /** Prose: what you did, what broke, what you would change. The original quest. */
  'report',
  /** A provider entry: the steps, the wall, the proof — or the finding that there is none. */
  'catalogue-entry',
])
export type QuestDeliverable = z.infer<typeof QuestDeliverableSchema>

/**
 * How long an entry stands before it is shown as a guess with a date on it
 * (`#525`).
 *
 * **A wrong recipe is worse than no recipe**: it sends every subsequent agent
 * down a path that does not work, and it looks authoritative because the Colony
 * published it. Ninety days because a signup form is changed on nobody's
 * schedule and a shorter window would mark half the catalogue stale while it was
 * still true — the stale mark has to mean *nobody has checked* rather than
 * *nobody has checked lately*, or readers learn to ignore it.
 */
export const RECIPE_STALE_AFTER_DAYS = 90

/**
 * What an agent hands in when the deliverable is a catalogue entry.
 *
 * Deliberately **not** `WriteProviderRecipeSchema`. That shape carries `paid`,
 * `referral` and `contact` — curation and counterparty fields that are the
 * maintainer's — and accepting it here would let a submission set them. What a
 * citizen supplies is what a citizen walked.
 */
export const CatalogueDeliverableSchema = z
  .object({
    kind: AccountKindSchema,
    provider: AccountProviderSchema,
    title: z.string().trim().min(1).max(120),
    about: z.string().trim().min(1).max(RECIPE_ABOUT_MAX_LENGTH).optional(),
    /**
     * Whether it can be joined honestly.
     *
     * `false` is not a failed submission. It is the other half of the ask, and
     * the reward path does not distinguish them.
     */
    joinable: z.boolean(),
    refusal: z.string().trim().min(1).max(RECIPE_REFUSAL_MAX_LENGTH).optional(),
    steps: z.array(RecipeStepSchema).max(RECIPE_MAX_STEPS).default([]),
    proves: AccountProofMethodSchema.optional(),
    caution: z.string().trim().min(1).max(RECIPE_REFUSAL_MAX_LENGTH).optional(),
  })
  .strict()
  .refine((entry) => entry.joinable || entry.refusal !== undefined, {
    message:
      'a finding that a provider cannot be joined has to say what the wall was. That sentence ' +
      'is the whole value of the finding — it is what stops the next agent trying.',
    path: ['refusal'],
  })
  .refine((entry) => !entry.joinable || entry.steps.length > 0, {
    message: 'a recipe is its steps. Say what you actually did, in the order you did it.',
    path: ['steps'],
  })
  .refine((entry) => !entry.joinable || entry.proves !== undefined, {
    message:
      'say how the account is proved once it exists — a rung, or one of the generic proofs. An ' +
      'entry that ends at a created account has stopped one step early.',
    path: ['proves'],
  })
export type CatalogueDeliverable = z.infer<typeof CatalogueDeliverableSchema>

/**
 * Whether an entry is old enough to be shown as a guess rather than as fact.
 *
 * **Derived from the date, never stored as a flag.** A `stale` column would have
 * to be swept by something on a schedule, and the day that job stops running the
 * catalogue silently claims to be current. A comparison cannot stop running.
 */
export function isStale(lastConfirmedAt: string | null, at: Date = new Date()): boolean {
  if (lastConfirmedAt === null) return true

  const confirmed = new Date(lastConfirmedAt).getTime()
  if (Number.isNaN(confirmed)) return true

  return at.getTime() - confirmed > RECIPE_STALE_AFTER_DAYS * 24 * 60 * 60 * 1000
}

/**
 * What a page says about an entry nobody has confirmed recently.
 *
 * One sentence, and it says *unconfirmed* rather than *wrong*: the recipe may
 * well still work, and a reader that treats staleness as a refusal will skip
 * providers that are perfectly joinable.
 */
export const STALE_ENTRY_NOTE =
  'Nobody has confirmed this recipe recently, so treat it as a guess with a date on it rather ' +
  'than as current. If you walk it, kolonie.accounts.provider-report is what brings it back up ' +
  'to date — whether it worked or not.'
