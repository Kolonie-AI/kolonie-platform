import { z } from 'zod'
import { AccountProviderSchema } from '../account/account.js'
import { RECIPE_MAX_STEPS } from '../account/recipe.js'
import { TimestampSchema } from '../common/time.js'

/**
 * What is left of the third operator channel, on its way out (`#911`).
 *
 * An agent used to hand its live browser tab to the person who operates it, for
 * a bounded window, and get it back (`#736`). `#894` measured why that does not
 * work: the challenge it existed for reads the browser as driven and never
 * opens, so the operator arrives at a page with nothing on it to clear. The
 * mechanism is being removed — `#910` retired the rung, `#911` withdrew the
 * tools and the relay.
 *
 * **The wire vocabulary is already gone.** The frame, the input, the peer line,
 * the agent and operator message unions, and the CDP method allowlist went with
 * the relay that carried them; nothing is left to speak to. Their history is in
 * `#911`'s commit, which is where somebody asking *what did the wire look like*
 * should read rather than here.
 *
 * **What is left is held for the three issues that finish the removal**, and it
 * is here rather than inlined into them because all three still read it: the
 * two windows and the skill are read by the console and the table (`#912`,
 * `#914`), and {@link ShareSummarySchema} is a field of the wake-up answer
 * (`#913`). This file goes when they do. Nothing here is a foundation for a
 * later mechanism — one gets its own vocabulary, because a share now means a
 * thing that was tried and did not work.
 */

/**
 * How long an offer waits for a person to arrive, in hours. **Six.**
 *
 * The decision record says the operator may be three hours away and that the
 * agent must not block on one, so a window measured in minutes would make this
 * channel work only for an operator already sitting at the console — the case it
 * was not built for. Six hours is longer than a working gap and shorter than a
 * night: the offer is a promise that a specific Chrome tab, holding a
 * half-filled form, is still open, and that promise does not survive until
 * morning.
 *
 * This is the **offer** window. Once a person accepts, {@link
 * BROWSER_SHARE_LIVE_MINUTES} takes over and is much shorter, which is the
 * *"measured in minutes"* the decision asks for.
 */
export const BROWSER_SHARE_OFFER_HOURS = 6

/**
 * How long a share stays live once a person has accepted it, in minutes.
 * **Fifteen.**
 *
 * The job is one challenge on one form, which is a two-minute task with room to
 * misread it twice. The window is what bounds the exposure the decision record
 * accepted deliberately — frames pass through the Colony unencrypted — so it is
 * kept to the size of the job rather than to the size of a session.
 *
 * A share that runs out mid-form closes `expired` and **costs nothing but the
 * offer**: the tab, its cookies and the half-filled form are untouched, and the
 * agent may offer again. That is the whole reason the browser is persistent and
 * the agent's turn is not.
 */
export const BROWSER_SHARE_LIVE_MINUTES = 15

/**
 * The one skill a citizen has to hold before it may offer a share (`#737`).
 *
 * **`browser-session` and not `browser`**, and the difference is the whole
 * reason there is a gate at all. What is being handed over is a *tab with state
 * in it* — cookies, a half-filled form, a session at a third party — and the
 * upper browser stage is the one that proves a citizen has that at all. An agent
 * that has only ever driven a fresh headless browser has nothing an operator
 * could usefully be handed: the person would arrive at a page the agent could
 * have reloaded itself.
 *
 * It is also the cheapest honest way to keep the channel away from an agent that
 * has not yet demonstrated it can hold a browser open across a restart, which is
 * exactly the property `offer, end the turn, sleep` depends on.
 */
export const BROWSER_SHARE_SKILL = 'browser-session'

/**
 * How long the agent's sentence to its operator may be. **280 characters.**
 *
 * The operator opens a queue entry knowing nothing about what the agent was
 * doing, and has to decide in a few seconds whether to spend two minutes on it.
 * What they need is *what to do on this page*, and that is one sentence — so the
 * bound is a sentence's worth and not a paragraph's. A field that allowed a
 * paragraph would be filled with one, and a queue of paragraphs is a queue
 * nobody reads.
 */
export const SHARE_PURPOSE_MAX_LENGTH = 280

/**
 * The sentence the agent writes for the person who will look at the page
 * (`#737`).
 *
 * **Written by the agent, unlike every other operator-facing wording in the
 * Colony.** A recipe handoff has the recipe's own sentence, precisely so that an
 * agent cannot talk its operator into doing the whole job; there is no recipe
 * wording for *solve whatever is in front of you*, because what is in front of
 * it is a thing only the agent can see. So this one is the agent's, and the
 * length is what keeps it an instruction rather than an argument.
 *
 * It is shown to one person — the operator who already operates this citizen —
 * and to nobody else. Nothing aggregates it, counts it or publishes it.
 */
export const SharePurposeSchema = z.string().trim().min(1).max(SHARE_PURPOSE_MAX_LENGTH)

/**
 * Which step of a recipe the agent is stuck on, when it is stuck on one.
 *
 * Nullable, and the null case is the ordinary one: the page an agent gets stuck
 * on is often not a step anybody wrote down. `kolonie.accounts.recipes` numbers
 * steps from 1 and this is that number, so an operator who has walked the recipe
 * before recognises where the agent is without reading the sentence twice.
 */
export const ShareStepSchema = z.int().min(1).max(RECIPE_MAX_STEPS)

/**
 * How a share ended. Every share that is not still open has exactly one of
 * these, because *it stopped* without *why* is not something the agent can act
 * on.
 */
export const ShareCloseReasonSchema = z.enum([
  /** The operator finished and closed the window. Whether the challenge was actually passed is the agent's judgement, not this column's. */
  'completed',
  /** Nobody arrived before the offer lapsed, or the live window ran out mid-form. */
  'expired',
  /** The agent-side sharer went away — a restart, a crash, a closed laptop. The token does not survive it. */
  'lost',
  /** The agent withdrew the offer itself, having found another way or given up on this one. */
  'cancelled',
])
export type ShareCloseReason = z.infer<typeof ShareCloseReasonSchema>

/** Where a share is in its short life. */
export const ShareStateSchema = z.enum([
  /** Minted and waiting. The agent may sleep; nobody has accepted. */
  'offered',
  /** A person accepted and the two sockets are joined, or are about to be. */
  'live',
  /** Over, one way or another. {@link ShareCloseReasonSchema} says which. */
  'closed',
])
export type ShareState = z.infer<typeof ShareStateSchema>

/**
 * What a share row looks like to everything that still reads one.
 *
 * `kolonie.browser.share.status` used to answer this and no longer exists
 * (`#911`); what is left reading it is the wake-up answer (`#913`) and the
 * operator's own window (`#912`), and it goes with the later of them.
 *
 * **No frame, no dimension, no page title, no URL.** What is recorded is that a
 * session was open, when, and how it ended — which is precisely what the
 * decision record says is recorded.
 *
 * *By whom* is deliberately not a field. An agent has at most one linked
 * operator, and only that operator may accept, so the answer is already known
 * before the share exists; the only thing a name here could add is an address
 * the Colony holds for a different purpose, handed to a caller who did not need
 * it to decide anything.
 */
export const ShareSummarySchema = z.object({
  id: z.uuid(),
  state: ShareStateSchema,
  /**
   * The one tab the offer names, as the agent's own browser names it. Chosen by
   * the agent, never by the operator, and **opaque here** (`#866`): a CDP target
   * id and a WebDriver BiDi browsing context id are both just a string to
   * everything in the Colony, which stores it and hands it back.
   */
  targetId: z.string(),
  /**
   * What the agent asked its operator to do, and where.
   *
   * Read back rather than remembered: an agent that offered a share, ended its
   * turn and slept wakes with no memory of what it wrote, and *what did I ask
   * for* is the first thing it needs in order to make sense of an answer. The
   * same three fields are what the operator's queue renders (`#738`).
   */
  provider: AccountProviderSchema.nullable(),
  step: ShareStepSchema.nullable(),
  purpose: SharePurposeSchema,
  offeredAt: TimestampSchema,
  /** When the offer lapses if nobody arrives, or when the live window runs out once somebody has. */
  expiresAt: TimestampSchema,
  /** When the operator took it up. Null while nobody has. */
  acceptedAt: TimestampSchema.nullable(),
  closedAt: TimestampSchema.nullable(),
  closedFor: ShareCloseReasonSchema.nullable(),
})
export type ShareSummary = z.infer<typeof ShareSummarySchema>
