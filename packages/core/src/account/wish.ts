import { z } from 'zod'
import { WishIdSchema } from '../common/ids.js'
import { TimestampSchema } from '../common/time.js'
import { AccountProviderSchema } from './account.js'

/**
 * One list per agent that the agent and its operator both write to (#527).
 *
 * ## What did not exist
 *
 * An operator and an agent have two channels, and **neither can hold a plan**.
 * `operator_requests` is words and `operator_drops` is a secret, and both are
 * reactive: the agent asks, the operator answers. So *your agent should have a
 * Trello account* and *I keep failing tasks that need Figma* have nowhere to
 * live, and both end up in a chat nobody can find again.
 *
 * ## Why this is worth a mechanism rather than a note
 *
 * It is the **first planning surface between an operator and an agent**.
 * Everything that exists today is question and answer about one thing; this is a
 * shared view of what the agent should become, and it is the difference between
 * an operator who supervises and one who invests.
 *
 * **An agent's own entry is the more valuable half.** It knows what it failed at
 * and the operator does not — which is also why {@link WishSchema.noticedWhile}
 * exists and is not optional decoration.
 *
 * ## What it is not
 *
 * **Not an instruction.** An item is a wish. The operator marks it wanted, and
 * only then may a recipe ask that operator for anything on account of it — see
 * {@link WishSchema.wantedAt}. Nothing starts by itself, from either side.
 *
 * **Not a queue of work for the operator.** That is `#530`, and it lists what is
 * *already blocked* on a person right now. This is the plan behind it.
 *
 * **Not a place for secrets.** Both free boxes on the operator channels refuse
 * them outright, and that refusal is what keeps `operator_drops` meaning *a
 * secret*. A third box that accepted one would undo it for all three.
 */

/** How long a note about why an account is wanted may be. */
export const WISH_NOTE_MAX_LENGTH = 600

/**
 * Who put an item on the list.
 *
 * **The same two parties as an operator exchange, and deliberately the same
 * vocabulary.** `OperatorRequestAuthorSchema` names exactly `citizen` and
 * `operator`, for exactly this distinction; a second enum with identical members
 * would be two vocabularies for one question, and the first surface that had to
 * translate between them would get it wrong.
 */
export { OperatorRequestAuthorSchema as WishAuthorSchema } from '../operator/request.js'
export type { OperatorRequestAuthor as WishAuthor } from '../operator/request.js'

/** One thing on the list. */
export const WishSchema = z.object({
  id: WishIdSchema,
  /** Who runs the account, in the form the Atlas prints it — `trello.com`. */
  provider: AccountProviderSchema,
  /** Which side put it there. */
  author: z.enum(['citizen', 'operator']),
  /**
   * What the agent was doing when it found the need, in its own words.
   *
   * **This is the half an operator cannot supply**, and the reason `#527` calls
   * the agent's entry the more valuable one: *I failed three tasks that wanted a
   * Figma file* is a fact about the world that only the agent holds. Absent on
   * an operator's entry, where there is nothing to have noticed.
   */
  noticedWhile: z.string().nullable(),
  /**
   * When the operator said yes, or `null`.
   *
   * **The one thing that turns a wish into something that may be acted on.** A
   * recipe may not ask this operator for anything on account of an entry that is
   * still `null` — the operator decides what is attempted, and the agent does
   * the work. Neither can start an onboarding alone: the operator because it is
   * not its account, the agent because a wall needs a human.
   */
  wantedAt: TimestampSchema.nullable(),
  addedAt: TimestampSchema,
})
export type Wish = z.infer<typeof WishSchema>

/** What either side sends to put something on the list. */
export const AddWishSchema = z.object({
  provider: AccountProviderSchema,
  /**
   * Why, in a sentence or two. Optional, and the Colony asks for it rather than
   * requiring it: an agent that has just failed at something should not have to
   * write an essay to record that it did.
   */
  noticedWhile: z.string().trim().min(1).max(WISH_NOTE_MAX_LENGTH).optional(),
})
export type AddWish = z.infer<typeof AddWishSchema>

export const WishListSchema = z.object({ wishes: z.array(WishSchema) })
export type WishList = z.infer<typeof WishListSchema>
