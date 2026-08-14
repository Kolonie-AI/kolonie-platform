import { z } from 'zod'
import {
  AccountEntryIdSchema,
  AccountEpisodeIdSchema,
  AccountSlotIdSchema,
  AccountThreadIdSchema,
} from '../common/ids.js'
import { TimestampSchema } from '../common/time.js'

/**
 * The conversation that hangs off an account (`#929`).
 *
 * ## The shape, and why it has three levels rather than one
 *
 * `kolonie-docs/state/decisions/the-account-is-the-permanent-object.md` is the
 * argument; this is the vocabulary it decided, and the reasons repeated here are
 * only the ones a reader of *this file* needs in order not to model it wrongly.
 *
 * **Account** is permanent. **Thread** is one per account, created with it, and
 * never closes — it holds no state at all, and its only job is to make
 * *everything that ever happened about this account* a single query. **Episode**
 * is the thing that opens, runs and closes: it has a turn and it has an outcome.
 *
 * The level that is easy to leave out is the middle one, and leaving it out is
 * what the previous shape did. Without a thread, the second time an account
 * needs attention there is nowhere to put it except beside the first — so
 * *getting the account* and *repairing it eight months later* end up in one
 * record, and the record either never closes or closes over work that is still
 * live. Two episodes on one thread is the whole of the fix.
 *
 * ## What is not here
 *
 * **No state on the thread.** A thread that could be open or closed would be a
 * second answer to *is anything happening with this account* — the episodes are
 * the first, and two answers disagree eventually.
 *
 * **No cryptography.** A secret slot carries a value the caller has already
 * sealed with the mechanism its direction already uses. `#929` introduces no new
 * one, and the reason is that there is nothing wrong with either existing one:
 * operator → agent lands in the agent's vault, agent → operator is a
 * console-readable seal, and a third mechanism would be a third thing to get
 * right.
 */

/** How long an episode's one-line title may be. */
export const EPISODE_TITLE_MAX_LENGTH = 200

/**
 * How long the sentence explaining a failure may be.
 *
 * Longer than a title and much shorter than an entry: a wall is *what stopped
 * this*, and the account of how it was reached belongs in the entries, which is
 * where a reader looking for it will go.
 */
export const EPISODE_WALL_MAX_LENGTH = 1000

/**
 * How long one note in an episode may be.
 *
 * **Line breaks are preserved and nothing is rendered as markdown.** Both halves
 * are decided rather than incidental: an operator writing three lines of a
 * recovery code should see three lines, and a body that rendered would make the
 * channel a place where an agent could compose something that looks like the
 * Colony speaking.
 */
export const ENTRY_BODY_MAX_LENGTH = 2000

/** How long a slot's label may be. It names one thing to be handed over. */
export const SLOT_LABEL_MAX_LENGTH = 120

/**
 * How much a slot may carry.
 *
 * The vault's own ceiling, and the same for a reason: a slot that could hold
 * more than the vault it is destined for would accept a value that cannot be
 * stored at the far end, and it would find that out after the operator had
 * pasted it.
 */
export const SLOT_VALUE_MAX_LENGTH = 8192

/**
 * Who acted — on an episode, and on a note within it.
 *
 * **One vocabulary for both**, because they are the same three parties and a
 * second enum with identical members is two vocabularies for one question. The
 * first surface that had to translate between them would get it wrong; the same
 * argument `WishAuthorSchema` makes about not minting a second `agent |
 * operator`.
 *
 * **`colony` is here and it is not decoration.** A re-check that fails opens an
 * episode without either party having acted (`#934`), and *who opened this* has
 * to have an honest answer in that case. An episode opened by the Colony that
 * had to name an agent or an operator as its opener would be a small lie told at
 * exactly the moment the account is in trouble.
 */
export const ThreadPartySchema = z.enum(['agent', 'operator', 'colony'])
export type ThreadParty = z.infer<typeof ThreadPartySchema>

/** Who opened an episode. */
export { ThreadPartySchema as EpisodeOpenerSchema }
export type EpisodeOpener = ThreadParty

/** Who wrote a note. */
export { ThreadPartySchema as EntryAuthorSchema }
export type EntryAuthor = ThreadParty

/**
 * What an episode is for.
 *
 * **`acquisition` happens at most once per thread, ever**, and that is enforced
 * in the database rather than in application code. It is the episode that
 * brought the account into being, so a second one is not a rare case to be
 * handled but a statement that cannot be true — and the Atlas draft is derived
 * from it *alone*, which means a second one would silently change what the
 * Colony publishes about a provider.
 *
 * Everything afterwards is `maintenance`: the password rotation, the recovery
 * address that turned out to be wrong, the re-check that failed. There is no
 * third kind, because the only distinction that carries a rule is *did this
 * bring the account into existence*.
 */
export const EpisodeKindSchema = z.enum(['acquisition', 'maintenance'])
export type EpisodeKind = z.infer<typeof EpisodeKindSchema>

/**
 * Whose move it is.
 *
 * **`nobody` is a resting state and not an error.** An episode where neither
 * side owes the other anything is ordinary — the operator has done its step and
 * the agent has not started, or the whole thing is finished. Without a third
 * value the turn would always point at somebody, and *waiting on you* would be
 * indistinguishable from *nothing is waiting on anyone*, which is the difference
 * an operator opening a console actually wants to see.
 *
 * A closed episode always rests here, and the database refuses any other
 * combination.
 *
 * **The turn is not permission to speak.** Either side may write a note at any
 * time, including the side that is not on turn — an operator realising two hours
 * later that the address was wrong must be able to say so without seizing the
 * move.
 */
export const EpisodeTurnSchema = z.enum(['agent', 'operator', 'nobody'])
export type EpisodeTurn = z.infer<typeof EpisodeTurnSchema>

/**
 * How an episode ended.
 *
 * Null while it is open, and one of these afterwards. `taken-over` is an account
 * that already existed and came under the agent's hand; `created` is a new one;
 * `repaired` is a maintenance episode that fixed what it opened for; `failed`
 * stopped at something, and **carries a wall saying what**; `abandoned` stopped
 * without one, which is a different and honest answer.
 *
 * **`failed` and `abandoned` are kept apart deliberately.** A wall is what the
 * next citizen reads and what the Atlas learns from; folding the two would make
 * *I ran out of interest* and *this provider refuses agents* the same record.
 */
export const EpisodeOutcomeSchema = z.enum([
  'taken-over',
  'created',
  'repaired',
  'failed',
  'abandoned',
])
export type EpisodeOutcome = z.infer<typeof EpisodeOutcomeSchema>

/**
 * Who put something in a slot.
 *
 * **Two members where {@link ThreadPartySchema} has three**, and the missing one
 * is the point: the Colony never fills a slot, because it has nothing to put in
 * one. It can notice that an account is broken and open an episode about it; it
 * cannot know the password.
 *
 * This is also what decides how a secret is carried, which is why it is recorded
 * rather than derived from context. A secret an operator filled travels the
 * operator → agent way and lands in the agent's vault; one the agent filled
 * travels the other way and is a console-readable seal. One column, and no
 * caller has to be told which mechanism it is in.
 */
export const SlotFillerSchema = z.enum(['agent', 'operator'])
export type SlotFiller = z.infer<typeof SlotFillerSchema>

/** The container. One per account, and it has no state of its own. */
export const AccountThreadSchema = z.object({
  id: AccountThreadIdSchema,
  accountId: z.uuid(),
  createdAt: TimestampSchema,
})
export type AccountThread = z.infer<typeof AccountThreadSchema>

/** One stretch of work about the account. */
export const AccountEpisodeSchema = z.object({
  id: AccountEpisodeIdSchema,
  threadId: AccountThreadIdSchema,
  openedBy: ThreadPartySchema,
  kind: EpisodeKindSchema,
  turn: EpisodeTurnSchema,
  title: z.string().min(1).max(EPISODE_TITLE_MAX_LENGTH),
  outcome: EpisodeOutcomeSchema.nullable(),
  wall: z.string().max(EPISODE_WALL_MAX_LENGTH).nullable(),
  openedAt: TimestampSchema,
  closedAt: TimestampSchema.nullable(),
})
export type AccountEpisode = z.infer<typeof AccountEpisodeSchema>

/**
 * A labelled container for one thing that has to change hands.
 *
 * **The label is free text and that is deliberate.** A closed vocabulary of
 * *password*, *recovery code*, *verification link* would be wrong at the fourth
 * provider, and being wrong there would mean the thing that has to be handed
 * over has nowhere to go — which is exactly the failure the whole design is for.
 */
export const AccountSlotSchema = z.object({
  id: AccountSlotIdSchema,
  episodeId: AccountEpisodeIdSchema,
  label: z.string().min(1).max(SLOT_LABEL_MAX_LENGTH),
  secret: z.boolean(),
  filledBy: SlotFillerSchema.nullable(),
  filledAt: TimestampSchema.nullable(),
  /** Absent until it is filled, and **never returned for a secret slot** by any read that lists. */
  value: z.string().max(SLOT_VALUE_MAX_LENGTH).nullable(),
  /**
   * When a secret slot was taken, and null on every slot that is not one.
   *
   * **Taking is what spends it** — the rule `kolonie.operator.drop.read` already
   * states — and a spend that left no mark would be one nobody could refuse
   * twice. A slot that is not secret is not spent by being read, so it never
   * stamps this: a code that has already expired is not a secret, and a second
   * look at one rescues the case where the clipboard went wrong.
   */
  takenAt: TimestampSchema.nullable(),
  /**
   * Where it went, so the refusal of a second take can say something useful.
   *
   * A vault key, which is a plaintext label rather than a secret — the same
   * thing `kolonie.operator.drop.read` names when it declines to repeat a value.
   */
  takenTo: z.string().nullable(),
})
export type AccountSlot = z.infer<typeof AccountSlotSchema>

/**
 * One note, appended.
 *
 * **There is no update path and no delete path, including for the author.** An
 * episode is what an operator reads to find out what happened, and a record
 * either side could revise afterwards is not that. What replaces editing is
 * writing again: the correction is a second entry, and the sequence shows that
 * somebody changed their mind, which is usually the thing worth knowing.
 */
export const AccountEntrySchema = z.object({
  id: AccountEntryIdSchema,
  episodeId: AccountEpisodeIdSchema,
  author: ThreadPartySchema,
  body: z.string().min(1).max(ENTRY_BODY_MAX_LENGTH),
  createdAt: TimestampSchema,
})
export type AccountEntry = z.infer<typeof AccountEntrySchema>

/**
 * Whether this outcome requires a wall.
 *
 * One function rather than the condition written out at each caller, because the
 * database holds the same rule as a check constraint and two statements of one
 * rule drift. This is the readable half; `account_episodes_failed_has_a_wall` is
 * the half that cannot be forgotten.
 */
export function outcomeNeedsWall(outcome: EpisodeOutcome): boolean {
  return outcome === 'failed'
}
