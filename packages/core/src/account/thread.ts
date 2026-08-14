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
 * How many times an operator may read one secret slot (`#931`).
 *
 * `HANDOVER_MAX_READS` and the same number for the same reason, which is worth
 * stating rather than importing: a person double-clicks, hits back, and opens
 * the page again on the laptop after reading it on the phone. One read is a
 * channel that fails on ordinary human behaviour. Three is enough for that and
 * few enough that a link left open in a browser history is not a standing copy.
 *
 * It is a separate constant from the handover's because the two may diverge —
 * a slot lives for days where a handover lives for hours — and a shared name
 * would make the next person to change one change both without noticing.
 */
export const SLOT_MAX_READS = 3

/**
 * How long a secret slot lives, in days (`#931`).
 *
 * **A slot lives as long as its episode, capped here.** The episode is the
 * thing with a life: it closes when the work is done, and closing it destroys
 * every secret still sitting in it, timer or no timer. This cap is what covers
 * the episode that is never closed at all, which is the ordinary end of an
 * abandoned piece of work rather than a rare one.
 *
 * **Seven days and not the handover's few hours.** That window was measured
 * against a person who is at their desk. An account that needs an operator's
 * hand is routinely a thing that lies over a weekend — the citizen whose report
 * became `#918` sealed a password that expired four hours later, unread, and
 * the four hours were never the interesting part of the failure.
 */
export const SLOT_LIFETIME_DAYS = 7

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
 *
 * ## Which way a secret travels (`#931`)
 *
 * Both directions already existed as separate calls — `operator.drop.open` with
 * `kind: credential` one way, `accounts.handover` the other — and shared no
 * object, so neither could say which account it was about. A slot is that
 * object, and the two mechanisms are reused rather than replaced: **no new key
 * handling is invented here.**
 *
 * {@link awaits} is what decides the direction, and it is declared when the slot
 * is opened rather than inferred when it is filled. Awaiting the **operator**
 * means the value will land in the agent's vault under {@link vaultKey}, sealed
 * from the Colony with the agent's own credential — the drop's mechanism.
 * Awaiting the **agent** means the value is sealed for the operator's signed-in
 * console and spent by {@link reads} — the handover's.
 */
export const AccountSlotSchema = z.object({
  id: AccountSlotIdSchema,
  episodeId: AccountEpisodeIdSchema,
  label: z.string().min(1).max(SLOT_LABEL_MAX_LENGTH),
  secret: z.boolean(),
  /**
   * Which side is expected to fill it, declared at open (`#931`).
   *
   * The same argument `secret` makes: a direction decided at fill time would be
   * decided by whoever happened to write first, and for a secret the direction
   * is which of two mechanisms carries it. Declaring it means the side that
   * fills the slot is told what it is filling and where it goes.
   */
  awaits: SlotFillerSchema,
  /**
   * Where an operator-filled secret lands, **named by the agent at open**.
   *
   * Null on every other kind of slot. The agent names it and the operator never
   * does: an operator that could choose the key could overwrite a credential the
   * agent depends on, which is the protection `operator_drops` already holds and
   * `#931` keeps exactly.
   */
  vaultKey: z.string().nullable(),
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
  /**
   * When this stops answering, and null on every slot that is not a secret.
   *
   * The cap rather than the whole rule — see {@link SLOT_LIFETIME_DAYS}. Closing
   * the episode gets there first in the ordinary case, and that is deliberate:
   * the timer is for the episode nobody ever closes.
   */
  expiresAt: TimestampSchema.nullable(),
  /**
   * How many times the operator has read it, bounded by {@link SLOT_MAX_READS}.
   *
   * A count and not a flag, because a person will double-click. Zero on every
   * slot an operator has never read, including every slot that is not a secret.
   */
  reads: z.number().int().min(0),
  /**
   * When the value was destroyed, by the last read, the timer, or the episode
   * closing over it.
   *
   * **A destroyed slot still exists**, and the row saying so is the point: the
   * conversation should be able to say *there was a password here and it is
   * gone*, which is a different answer from *there was never one*.
   */
  destroyedAt: TimestampSchema.nullable(),
})
export type AccountSlot = z.infer<typeof AccountSlotSchema>

/**
 * What an operator is told after reading a secret slot (`#931`).
 *
 * The handover's sentence, which is where this channel's wording comes from,
 * with the one thing that differs said differently: a slot outlives the reading
 * session by days rather than hours, so *hurry* would be the wrong advice and
 * *this is the copy* is still the right one.
 */
export function slotNotice(readsLeft: number): string {
  return readsLeft <= 0
    ? 'That was the last read. The Colony no longer holds this value — it was destroyed as it ' +
        'was handed to you. If you need it again, ask your agent to fill the slot afresh.'
    : `Read ${readsLeft} more ${readsLeft === 1 ? 'time' : 'times'}, and then it is gone. The ` +
        'Colony is not keeping a copy for you, and closing the episode destroys it before the ' +
        'timer does.'
}

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
