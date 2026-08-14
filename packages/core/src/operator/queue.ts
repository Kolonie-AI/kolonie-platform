import { z } from 'zod'
import { TimestampSchema } from '../common/time.js'

/**
 * One queue across every agent a person operates (#530).
 *
 * ## The inversion
 *
 * Every onboarding recipe (`#517`, `#521`) stops at one wall where a provider
 * needs a human. Today that is a conversation, per account, per agent: **an
 * operator with ten agents and eight providers has eighty conversations.**
 *
 * The operator's time is the scarce resource, so the design batches the *human
 * steps* rather than the process. Agents run their recipes in parallel, on their
 * own machines and their own rhythms, and pile up at their walls. The operator
 * gets one list, sits down once, and thirty onboardings continue.
 *
 * ## Ordered by what it costs to clear, never by age
 *
 * `#530`: *"A queue that puts a five-second captcha behind a card payment is a
 * queue the operator abandons."* So the ordering is {@link WAITING_EFFORT}, and
 * it is a property of **what is being asked** rather than of how the asking was
 * worded — a rank read off prose would be a rank an agent could game by
 * rephrasing.
 *
 * ## It is not a control panel
 *
 * The operator answers what was asked. Nothing here starts, stops, retries or
 * reconfigures an agent — `#512` refuses that and this inherits the refusal. The
 * only actions are the ones the channels themselves already have: reply to a
 * request, and fill in a drop. A third one — click on the one tab an agent
 * offered (`#738`) — was the closest this ever came to the refusal, and it was
 * removed rather than widened (`#911`, `#912`): `#894` measured that the
 * challenge it existed for never opens for a driven browser, so the operator
 * arrived at a page with nothing on it to clear.
 */

/** Which of the three channels an item is waiting on. */
export const WaitingKindSchema = z.enum([
  /**
   * A one-time value that answers one open challenge — a code off a handset, a
   * digit string from a mail. Read once and gone.
   */
  'code',
  /** A secret that lands in the agent's vault. Something to find, or to create. */
  'credential',
  /** Words. An open question on the operator page, with no answer yet. */
  'question',
])
export type WaitingKind = z.infer<typeof WaitingKindSchema>

/**
 * How quickly each kind can be cleared, lowest first.
 *
 * **A rank per kind and not a number per item**, because the Colony can honestly
 * tell these apart and cannot honestly tell anything finer. A per-item estimate
 * would be a guess dressed as a measurement.
 *
 * - **`code`** is the fastest thing an operator ever does here: a value is
 *   already on a screen in front of them and the field takes it.
 * - **`credential`** is minutes. Something has to be found in a password
 *   manager, or created at a provider.
 * - **`question`** is last because it is the only one that cannot be bounded. A
 *   person has to read it, decide, and write — and a queue that opened with one
 *   of these would spend the operator's attention before any of the cheap items
 *   were cleared.
 *
 * The ranks are 0, 2 and 3 rather than 0, 1 and 2. Nothing sits at 1 any more:
 * `browser-share` did until `#912`, and the numbers are left where they are
 * because only their order is read — renumbering would be a change to every
 * ordering test for no change to any ordering.
 *
 * **Age is deliberately not in the ordering.** It is shown, because *this has
 * been waiting four days* is worth knowing; it does not sort, because sorting by
 * it is what produces the queue an operator abandons.
 */
export const WAITING_EFFORT: Readonly<Record<WaitingKind, number>> = {
  code: 0,
  credential: 2,
  question: 3,
}

/** One thing waiting on this person, wherever in their fleet it arose. */
export const WaitingItemSchema = z.object({
  /** Which agent is stuck. */
  agentId: z.uuid(),
  agentName: z.string(),
  kind: WaitingKindSchema,
  /**
   * What is being asked, in one sentence.
   *
   * **The recipe's own `ask` wherever a recipe raised it** — `RecipeStepSchema`
   * requires one and refuses a step that says only *ask your operator*, which is
   * the narrated wall this list would otherwise fill with. An agent composing
   * the ask is how an operator ends up executing the signup.
   *
   * A request opened outside a recipe carries whatever the citizen wrote, and
   * that is the pre-recipe path rather than a second standard.
   */
  ask: z.string(),
  /** What the agent was doing — the task the wall is inside, where there is one. */
  about: z.string().nullable(),
  /** When it started waiting. Shown, never sorted on. */
  since: TimestampSchema,
  /**
   * Where the operator answers it, or `null` when the Colony cannot produce one.
   *
   * **A drop still has no link here**, for the reason it never had one: its link
   * is a bearer secret the Colony keeps only the hash of, and reproducing it
   * would mean storing what the hash exists to avoid. What `#570` added is not a
   * link — see {@link WaitingItemSchema.shape.dropId}.
   */
  answerAt: z.string().nullable(),
  /**
   * The exchange this row is, for the console's own link (`#587`).
   *
   * **`answerAt` above stays exactly as it is, and this is why there are two.**
   * That field is a `/operator/page/<token>` URL and is correct for the surface
   * it was written for — a mailed digest, where the token *is* how the operator
   * is known. It is wrong for the console, where a session already proves who
   * the reader is and rendering the token would put a durable bearer credential
   * into a page behind a login (`#428`).
   *
   * So the console substitutes: `/agents/:agentId/operator`, plus this id as a
   * fragment so the reader lands on the question they clicked. **Do not "fix"
   * the queue by putting the token back** — the substitution belongs in the
   * console because that is where the session exists.
   *
   * An id and not a link: it authorises nothing. `null` on a drop.
   */
  requestId: z.uuid().nullable(),
  /**
   * The drop this item is, when it is one (`#570`). `null` for a question.
   *
   * **An id and not a link, and the difference is the whole of the change.** The
   * mailed link is a bearer secret: whoever holds it can fill the drop, which is
   * why it is single-use, attempt-limited and never reproduced. This is a row
   * id, it authorises nothing on its own, and it is only ever handed to a person
   * whose console session already proved `operates()` over the agent it belongs
   * to. A queue that names a drop it cannot clear is the state `#570` calls
   * backwards; a queue that reproduced the link would be the leak `#410`
   * refused.
   */
  dropId: z.uuid().nullable().default(null),
})
export type WaitingItem = z.infer<typeof WaitingItemSchema>

/**
 * The queue, ordered.
 *
 * Exported as a function rather than left to each caller, so the console, a
 * future API and any test all order it the same way — the ordering *is* the
 * feature, and two implementations of it would eventually be two queues.
 *
 * Ties break on age, oldest first: among items that cost the same, the one that
 * has waited longest is the one to do.
 */
export function inClearingOrder(items: readonly WaitingItem[]): readonly WaitingItem[] {
  return [...items].sort((a, b) => {
    const byEffort = WAITING_EFFORT[a.kind] - WAITING_EFFORT[b.kind]
    if (byEffort !== 0) return byEffort
    return Date.parse(a.since) - Date.parse(b.since)
  })
}
