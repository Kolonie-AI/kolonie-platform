import { z } from 'zod'
import {
  AtlasCategorySchema,
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
  /**
   * *N* walks of an entry that already exists (`#602`).
   *
   * **A quest is the wrong instrument for a first entry and the right one for
   * this.** To get a recipe for `notion.so` into the catalogue through a quest,
   * somebody must first decide to pay for one — so the catalogue would grow only
   * where money was spent in advance, and an agent that walked `notion.so`
   * yesterday for its own reasons would have nowhere to put what it learned.
   * `#600` and `#601` are the light instrument for that.
   *
   * What only money can buy is the answer to *does this hold at scale*. One
   * agent got through — does the twentieth, from a different country, a
   * different runtime, a different time of day? That question cannot be answered
   * by writing anything, and it is the only Atlas question with an obvious
   * counterparty: a provider that wants to know whether agents can onboard has a
   * reason to fund it and the answer is worth what it costs them.
   */
  'entry-walks',
])
export type QuestDeliverable = z.infer<typeof QuestDeliverableSchema>

/** The most walks one quest may buy. A sponsor wanting more buys a second. */
export const MAX_WALKS_ASKED = 500

/**
 * What every `entry-walks` quest says, before anybody signs one (`#602`).
 *
 * **The sentence has to be in the quest's own terms rather than in a policy
 * document**, because the moment it matters is the moment a sponsor is deciding
 * whether to pay, and a rule discovered afterwards is a rule the sponsor will
 * reasonably feel misled by.
 *
 * `growth/README.md`'s standing rule is that *measured figures are shown whether
 * or not they flatter*, and the ranking is not purchasable. A provider may pay
 * for its entry to be **tested** and may not pay for what the test says. The two
 * halves are separable and both have to be said: the figures are published
 * whatever they are, and a failed run is still a result and is still paid —
 * twenty agents attempting and four getting through *is* the finding, and a
 * quest that only paid on success would be buying optimism.
 */
export const ENTRY_WALKS_TERMS =
  'What this quest buys is the walks, not what they show. The figures it produces are published ' +
  'on the entry whether or not they flatter — the Colony shows measured figures either way, and ' +
  'no payment moves an entry’s position, because the order is recomputed from the measurements ' +
  'on every read and there is no field to move. A run where most agents did not get through is ' +
  'a result, is accepted, and is paid: twenty attempting and four succeeding is the answer you ' +
  'came for. If that is not what you want to find out, this is not the quest to sponsor.'

/**
 * How far an `entry-walks` quest has got.
 *
 * **Measured in recorded walks and not in submitted documents**, which is the
 * whole shape of this deliverable. `#601` records a walk as a by-product of an
 * agent obtaining an account; nothing is written up, and nothing is handed in.
 * What the sponsor bought is the attempts.
 *
 * **A walk that failed counts.** It has to, or the quest is one that only pays
 * on success and the figures it produces are drawn from a population selected
 * for having got through — which is the one result that would be worth less than
 * nothing.
 */
export function entryWalksProgress(input: { readonly asked: number; readonly recorded: number }): {
  readonly done: boolean
  readonly remaining: number
} {
  const remaining = Math.max(0, input.asked - input.recorded)

  return { done: remaining === 0, remaining }
}

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
    /**
     * What sort of thing it is (`#589`).
     *
     * **The citizen's to state, from the closed list.** They walked it, so they
     * know what it is — and the vocabulary being closed means the worst they can
     * do is file it on a slightly wrong shelf, which the review queue is there to
     * correct. Deriving it from `kind` was the alternative and it does not work:
     * for two of the three seeded entries the kind is the provider spelled again.
     */
    category: AtlasCategorySchema,
    about: z.string().trim().min(1).max(RECIPE_ABOUT_MAX_LENGTH).optional(),
    /**
     * Whether it can be joined honestly.
     *
     * `refused` is not a failed submission. It is the other half of the ask, and
     * the reward path does not distinguish them.
     *
     * **Two of the catalogue's three states, and the omission is deliberate**
     * (`#588`). `unwritten` means nobody has looked; a quest deliverable is a
     * walk, so a citizen handing one in has looked by definition and the third
     * state is not something they can honestly report. It is the Colony's own
     * word for an entry it has listed and not investigated, and a submission that
     * could set it would be a citizen paid for having done nothing.
     */
    status: z.enum(['joinable', 'refused']),
    refusal: z.string().trim().min(1).max(RECIPE_REFUSAL_MAX_LENGTH).optional(),
    steps: z.array(RecipeStepSchema).max(RECIPE_MAX_STEPS).default([]),
    proves: AccountProofMethodSchema.optional(),
    caution: z.string().trim().min(1).max(RECIPE_REFUSAL_MAX_LENGTH).optional(),
  })
  .strict()
  .refine((entry) => entry.status === 'joinable' || entry.refusal !== undefined, {
    message:
      'a finding that a provider cannot be joined has to say what the wall was. That sentence ' +
      'is the whole value of the finding — it is what stops the next agent trying.',
    path: ['refusal'],
  })
  .refine((entry) => entry.status !== 'joinable' || entry.steps.length > 0, {
    message: 'a recipe is its steps. Say what you actually did, in the order you did it.',
    path: ['steps'],
  })
  .refine((entry) => entry.status !== 'joinable' || entry.proves !== undefined, {
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
