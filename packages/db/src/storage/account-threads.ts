import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import {
  AccountEntryIdSchema,
  AccountEpisodeIdSchema,
  AccountSlotIdSchema,
  AccountThreadIdSchema,
  type AccountEntry,
  type AccountEntryId,
  type AccountEpisode,
  type AccountEpisodeId,
  type AccountSlot,
  type AccountSlotId,
  type AccountThread,
  type AccountThreadId,
  type EpisodeKind,
  type EpisodeOutcome,
  type EpisodeTurn,
  type SlotFiller,
  type ThreadParty,
  outcomeNeedsWall,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import {
  accountEntries,
  accountEpisodes,
  accountSlots,
  accountThreads,
  accounts,
} from '../schema/index.js'

/**
 * The account conversation, in storage (`#929`).
 *
 * ## What this surface deliberately does not have
 *
 * **No way to change an entry and no way to remove one.** That is an acceptance
 * criterion of `#929` rather than an oversight, and it is held twice: a trigger
 * refuses `UPDATE` on the table, and there is no exported function here that
 * would attempt one. The test asserts it over this module's exports, because the
 * thing worth checking is not that a call fails — it is that a caller reading
 * this file finds nothing to reach for.
 *
 * **No sealing and no unsealing.** A secret slot's value arrives already sealed
 * by the direction it came from — the agent's vault key for operator → agent,
 * the console-readable seal for agent → operator — and leaves in exactly that
 * form. `#929` introduces no cryptography, and a storage layer that knew how to
 * open a slot would be a second place a secret could come out of.
 *
 * **No thread creation.** A thread appears because a trigger makes it appear
 * when the account is inserted. A function here would be a second answer to
 * *where do threads come from*, and it would be the one that could be forgotten.
 */

/** One thread, by the account it belongs to. Every account has one. */
export async function threadOf(
  db: Database | Transaction,
  accountId: string,
): Promise<AccountThread | undefined> {
  const [row] = await db
    .select()
    .from(accountThreads)
    .where(eq(accountThreads.accountId, accountId))
    .limit(1)

  return row === undefined ? undefined : toThread(row)
}

export type OpenEpisodeCommand = {
  readonly threadId: AccountThreadId
  readonly openedBy: ThreadParty
  readonly kind: EpisodeKind
  readonly title: string
  /** Whose move it is from the start. Omitted means nobody owes anybody anything yet. */
  readonly turn?: EpisodeTurn
}

export type OpenEpisodeOutcome =
  | { readonly outcome: 'opened'; readonly episode: AccountEpisode }
  /**
   * This thread already had its acquisition.
   *
   * **Returned rather than thrown**, and the existing episode comes back with
   * it. A caller that asks twice is usually a retry, and the honest answer to
   * *open the episode that brought this account into being* when that episode
   * exists is *here it is* — not an error. The database is what makes the answer
   * reliable: a partial unique index refuses the second row whatever this
   * function does, so two callers racing get one episode rather than two.
   */
  | { readonly outcome: 'acquisition-already-happened'; readonly episode: AccountEpisode }

export async function openEpisode(
  db: Database | Transaction,
  command: OpenEpisodeCommand,
): Promise<OpenEpisodeOutcome> {
  if (command.kind === 'acquisition') {
    const existing = await acquisitionOf(db, command.threadId)
    if (existing !== undefined) {
      return { outcome: 'acquisition-already-happened', episode: existing }
    }
  }

  const [row] = await db
    .insert(accountEpisodes)
    .values({
      threadId: command.threadId,
      openedBy: command.openedBy,
      kind: command.kind,
      title: command.title,
      turn: command.turn ?? 'nobody',
    })
    .onConflictDoNothing()
    .returning()

  if (row === undefined) {
    /**
     * The index refused it between the read above and this insert. Two callers
     * raced for one acquisition, and the one that lost reads the winner's row
     * rather than reporting a failure that did not happen to the account.
     */
    const existing = await acquisitionOf(db, command.threadId)
    if (existing === undefined) throw new Error('the episode could not be opened')
    return { outcome: 'acquisition-already-happened', episode: existing }
  }

  return { outcome: 'opened', episode: toEpisode(row) }
}

/** The episode that brought this account into being, if it has happened. */
export async function acquisitionOf(
  db: Database | Transaction,
  threadId: AccountThreadId,
): Promise<AccountEpisode | undefined> {
  const [row] = await db
    .select()
    .from(accountEpisodes)
    .where(and(eq(accountEpisodes.threadId, threadId), eq(accountEpisodes.kind, 'acquisition')))
    .limit(1)

  return row === undefined ? undefined : toEpisode(row)
}

/** Everything that ever happened about this account, newest first. */
export async function episodesOf(
  db: Database | Transaction,
  threadId: AccountThreadId,
): Promise<readonly AccountEpisode[]> {
  const rows = await db
    .select()
    .from(accountEpisodes)
    .where(eq(accountEpisodes.threadId, threadId))
    .orderBy(desc(accountEpisodes.openedAt))

  return rows.map(toEpisode)
}

export async function episode(
  db: Database | Transaction,
  episodeId: AccountEpisodeId,
): Promise<AccountEpisode | undefined> {
  const [row] = await db
    .select()
    .from(accountEpisodes)
    .where(eq(accountEpisodes.id, episodeId))
    .limit(1)

  return row === undefined ? undefined : toEpisode(row)
}

export type PassTurnOutcome =
  | { readonly outcome: 'passed'; readonly episode: AccountEpisode }
  /**
   * The episode is finished, so there is no move to pass.
   *
   * The rejection case `#929` names, and **nothing changes** — the update is
   * conditioned on the episode still being open, so a closed one is not written
   * to at all rather than written to and rolled back. The check constraint
   * `account_episodes_closed_rests` is the backstop for a caller that writes the
   * update itself.
   */
  | { readonly outcome: 'already-closed'; readonly episode: AccountEpisode }
  | { readonly outcome: 'no-such-episode' }

export async function passTurn(
  db: Database | Transaction,
  episodeId: AccountEpisodeId,
  to: EpisodeTurn,
): Promise<PassTurnOutcome> {
  const [row] = await db
    .update(accountEpisodes)
    .set({ turn: to })
    .where(and(eq(accountEpisodes.id, episodeId), isNull(accountEpisodes.outcome)))
    .returning()

  if (row !== undefined) return { outcome: 'passed', episode: toEpisode(row) }

  const closed = await episode(db, episodeId)
  if (closed === undefined) return { outcome: 'no-such-episode' }
  return { outcome: 'already-closed', episode: closed }
}

export type CloseEpisodeCommand = {
  readonly outcome: EpisodeOutcome
  /** Required by `failed` and refused by every other outcome. */
  readonly wall?: string
}

export type CloseEpisodeOutcome =
  | { readonly outcome: 'closed'; readonly episode: AccountEpisode }
  /**
   * It was already closed, and this is not an error.
   *
   * **Idempotent**, which is the criterion `#929` asks for: the second call
   * changes nothing, keeps the original closing date, and hands back the episode
   * as it stands. A caller retrying after a dropped connection has no way to know
   * whether the first call landed, and making it find out by getting an error is
   * making it guess.
   *
   * A *different* outcome the second time is refused rather than applied, below.
   */
  | { readonly outcome: 'already-closed'; readonly episode: AccountEpisode }
  /** Closing it a second time with a different verdict. Refused; nothing changes. */
  | { readonly outcome: 'closed-differently'; readonly episode: AccountEpisode }
  | { readonly outcome: 'wall-required' }
  | { readonly outcome: 'no-such-episode' }

/**
 * Close an episode.
 *
 * `turn` and `closed_at` are not arguments and are not set here: the trigger
 * writes both, so *closed* and *resting* cannot come apart however this is
 * called.
 */
export async function closeEpisode(
  db: Database | Transaction,
  episodeId: AccountEpisodeId,
  command: CloseEpisodeCommand,
): Promise<CloseEpisodeOutcome> {
  const wall = command.wall?.trim()
  if (outcomeNeedsWall(command.outcome) && (wall === undefined || wall.length === 0)) {
    return { outcome: 'wall-required' }
  }

  const [row] = await db
    .update(accountEpisodes)
    .set({
      outcome: command.outcome,
      wall: command.outcome === 'failed' ? (wall ?? null) : null,
    })
    .where(and(eq(accountEpisodes.id, episodeId), isNull(accountEpisodes.outcome)))
    .returning()

  if (row !== undefined) return { outcome: 'closed', episode: toEpisode(row) }

  const closed = await episode(db, episodeId)
  if (closed === undefined) return { outcome: 'no-such-episode' }
  return closed.outcome === command.outcome
    ? { outcome: 'already-closed', episode: closed }
    : { outcome: 'closed-differently', episode: closed }
}

export type OpenSlotCommand = {
  readonly episodeId: AccountEpisodeId
  readonly label: string
  readonly secret: boolean
}

export type OpenSlotOutcome =
  | { readonly outcome: 'opened'; readonly slot: AccountSlot }
  /** One label is one slot within one episode; the existing row comes back. */
  | { readonly outcome: 'already-open'; readonly slot: AccountSlot }

export async function openSlot(
  db: Database | Transaction,
  command: OpenSlotCommand,
): Promise<OpenSlotOutcome> {
  const [row] = await db
    .insert(accountSlots)
    .values({ episodeId: command.episodeId, label: command.label, secret: command.secret })
    .onConflictDoNothing({ target: [accountSlots.episodeId, accountSlots.label] })
    .returning()

  if (row !== undefined) return { outcome: 'opened', slot: toSlot(row) }

  const [existing] = await db
    .select()
    .from(accountSlots)
    .where(
      and(eq(accountSlots.episodeId, command.episodeId), eq(accountSlots.label, command.label)),
    )
    .limit(1)

  if (existing === undefined) throw new Error('the slot could not be opened')
  return { outcome: 'already-open', slot: toSlot(existing) }
}

export type FillSlotCommand = {
  readonly slotId: AccountSlotId
  readonly filledBy: SlotFiller
  /**
   * Already sealed if the slot is a secret one, by the mechanism its direction
   * uses. Nothing here inspects it, and nothing here can open it.
   */
  readonly value: string
}

export type FillSlotOutcome =
  | { readonly outcome: 'filled'; readonly slot: AccountSlot }
  /**
   * Somebody already put something here.
   *
   * **Refused rather than overwritten**, and it is the one place in this module
   * where refusing is clearly right: overwriting would destroy a value the other
   * side may already have acted on, and there is no version of that failure the
   * loser of the race can detect.
   */
  | { readonly outcome: 'already-filled'; readonly slot: AccountSlot }
  | { readonly outcome: 'no-such-slot' }

export async function fillSlot(
  db: Database | Transaction,
  command: FillSlotCommand,
): Promise<FillSlotOutcome> {
  const [row] = await db
    .update(accountSlots)
    .set({ filledBy: command.filledBy, value: command.value, filledAt: nowIso() })
    .where(and(eq(accountSlots.id, command.slotId), isNull(accountSlots.filledBy)))
    .returning()

  if (row !== undefined) return { outcome: 'filled', slot: toSlot(row) }

  const [existing] = await db
    .select()
    .from(accountSlots)
    .where(eq(accountSlots.id, command.slotId))
    .limit(1)

  if (existing === undefined) return { outcome: 'no-such-slot' }
  return { outcome: 'already-filled', slot: toSlot(existing) }
}

/**
 * The slots of one episode.
 *
 * **A secret's value never comes out of here.** It is replaced by `null` and the
 * shape is otherwise unchanged, so a caller listing an episode learns that the
 * slot is filled, by whom and when, and cannot learn what is in it. Reading a
 * secret out is the far end's business — the vault, or the console seal — and a
 * listing that carried the value would be a third way to get at one.
 */
export async function slotsOf(
  db: Database | Transaction,
  episodeId: AccountEpisodeId,
): Promise<readonly AccountSlot[]> {
  const rows = await db
    .select()
    .from(accountSlots)
    .where(eq(accountSlots.episodeId, episodeId))
    .orderBy(asc(accountSlots.label))

  return rows.map((row) => toSlot(row.secret ? { ...row, value: null } : row))
}

/** One slot, value included. For the far end that is entitled to it. */
export async function slot(
  db: Database | Transaction,
  slotId: AccountSlotId,
): Promise<AccountSlot | undefined> {
  const [row] = await db.select().from(accountSlots).where(eq(accountSlots.id, slotId)).limit(1)

  return row === undefined ? undefined : toSlot(row)
}

export type TakeSlotOutcome =
  | { readonly outcome: 'taken'; readonly slot: AccountSlot }
  /**
   * Somebody already took it, and this is the refusal `#930` asks for.
   *
   * **Nothing is written and the previous take is not disturbed**: the update is
   * conditioned on `taken_at` still being null, so the second caller does not
   * move the stamp and does not change where the first one put it. The row comes
   * back so the refusal can name the vault key it went to, which is the one
   * thing a caller that lost its transcript actually needs.
   */
  | { readonly outcome: 'already-taken'; readonly slot: AccountSlot }
  /** Nothing has been put in it yet, so there is nothing to spend. */
  | { readonly outcome: 'not-filled'; readonly slot: AccountSlot }
  | { readonly outcome: 'no-such-slot' }

/**
 * Spend a secret slot: stamp it taken, and say where it went.
 *
 * **Taking is what spends it**, the rule `kolonie.operator.drop.read` already
 * states, and the stamp is a column rather than an inference from the vault —
 * a spend that left no mark is one nothing could refuse a second time.
 *
 * Only a secret slot is ever taken. A slot that is not secret is read, and
 * reading it costs nothing: a code that has already expired is not a secret, and
 * a second look at one rescues the case where the clipboard went wrong. Callers
 * enforce that distinction; the check constraint
 * `account_slots_taken_is_a_secret` is what makes it impossible to get wrong.
 */
export async function takeSlot(
  db: Database | Transaction,
  command: { readonly slotId: AccountSlotId; readonly to: string },
): Promise<TakeSlotOutcome> {
  const [row] = await db
    .update(accountSlots)
    .set({ takenAt: nowIso(), takenTo: command.to })
    .where(
      and(
        eq(accountSlots.id, command.slotId),
        eq(accountSlots.secret, true),
        isNull(accountSlots.takenAt),
        isNotNull(accountSlots.filledAt),
      ),
    )
    .returning()

  if (row !== undefined) return { outcome: 'taken', slot: toSlot(row) }

  const existing = await slot(db, command.slotId)
  if (existing === undefined) return { outcome: 'no-such-slot' }
  if (existing.takenAt !== null) return { outcome: 'already-taken', slot: existing }
  return { outcome: 'not-filled', slot: existing }
}

/**
 * Everything of this agent's that is still running, across every account it
 * holds, turn-first.
 *
 * **This is the waking read**, and the ordering is the whole of why it exists.
 * An agent coming back after a restart wants *what is waiting on me* before
 * *what am I waiting on*, and `nobody` last — an episode where neither side owes
 * the other anything is real work, but it is not the thing to look at first. A
 * list ordered only by date would bury the one episode that is blocked on the
 * caller underneath four that are blocked on somebody else.
 */
export async function openEpisodesFor(
  db: Database | Transaction,
  agentId: string,
): Promise<readonly { readonly episode: AccountEpisode; readonly account: OpenEpisodeAccount }[]> {
  const rows = await db
    .select({ episode: accountEpisodes, account: accounts })
    .from(accountEpisodes)
    .innerJoin(accountThreads, eq(accountThreads.id, accountEpisodes.threadId))
    .innerJoin(accounts, eq(accounts.id, accountThreads.accountId))
    .where(and(eq(accounts.agentId, agentId), isNull(accountEpisodes.outcome)))
    .orderBy(
      sql`case ${accountEpisodes.turn} when 'agent' then 0 when 'operator' then 1 else 2 end`,
      asc(accountEpisodes.openedAt),
    )

  return rows.map((row) => ({
    episode: toEpisode(row.episode),
    account: {
      id: row.account.id,
      kind: row.account.kind,
      identifier: row.account.identifier,
      provider: row.account.provider,
    },
  }))
}

/** As much of the account as an episode listing has to name to be readable. */
export type OpenEpisodeAccount = {
  readonly id: string
  readonly kind: string
  readonly identifier: string
  readonly provider: string | null
}

/**
 * One episode, and only if it hangs off an account this agent holds.
 *
 * **The authorisation read.** Every surface that takes an episode id from a
 * caller goes through here first, so *does this exist* and *is it yours* are one
 * question with one answer — two questions would eventually be asked in the
 * wrong order, and asking them in the wrong order is how an id becomes a way to
 * find out what somebody else is doing.
 */
export async function episodeForAgent(
  db: Database | Transaction,
  agentId: string,
  episodeId: AccountEpisodeId,
): Promise<{ readonly episode: AccountEpisode; readonly account: OpenEpisodeAccount } | undefined> {
  const [row] = await db
    .select({ episode: accountEpisodes, account: accounts })
    .from(accountEpisodes)
    .innerJoin(accountThreads, eq(accountThreads.id, accountEpisodes.threadId))
    .innerJoin(accounts, eq(accounts.id, accountThreads.accountId))
    .where(and(eq(accountEpisodes.id, episodeId), eq(accounts.agentId, agentId)))
    .limit(1)

  if (row === undefined) return undefined
  return {
    episode: toEpisode(row.episode),
    account: {
      id: row.account.id,
      kind: row.account.kind,
      identifier: row.account.identifier,
      provider: row.account.provider,
    },
  }
}

/** One slot, value included, and only if it hangs off an account this agent holds. */
export async function slotForAgent(
  db: Database | Transaction,
  agentId: string,
  slotId: AccountSlotId,
): Promise<AccountSlot | undefined> {
  const [row] = await db
    .select({ slot: accountSlots })
    .from(accountSlots)
    .innerJoin(accountEpisodes, eq(accountEpisodes.id, accountSlots.episodeId))
    .innerJoin(accountThreads, eq(accountThreads.id, accountEpisodes.threadId))
    .innerJoin(accounts, eq(accounts.id, accountThreads.accountId))
    .where(and(eq(accountSlots.id, slotId), eq(accounts.agentId, agentId)))
    .limit(1)

  return row === undefined ? undefined : toSlot(row.slot)
}

/**
 * Append a note.
 *
 * **The turn is not consulted**, and that is decided rather than omitted: an
 * operator realising two hours later that the address was wrong must be able to
 * say so without seizing the move. Whose move it is says who owes the other
 * something, not who may speak.
 */
export async function writeEntry(
  db: Database | Transaction,
  command: {
    readonly episodeId: AccountEpisodeId
    readonly author: ThreadParty
    readonly body: string
  },
): Promise<AccountEntry> {
  const [row] = await db
    .insert(accountEntries)
    .values({ episodeId: command.episodeId, author: command.author, body: command.body })
    .returning()

  if (row === undefined) throw new Error('the entry could not be written')
  return toEntry(row)
}

/** One episode's notes, in the order they were written. There is no other read. */
export async function entriesOf(
  db: Database | Transaction,
  episodeId: AccountEpisodeId,
): Promise<readonly AccountEntry[]> {
  const rows = await db
    .select()
    .from(accountEntries)
    .where(eq(accountEntries.episodeId, episodeId))
    .orderBy(asc(accountEntries.createdAt), asc(accountEntries.id))

  return rows.map(toEntry)
}

const nowIso = (): string => new Date().toISOString()

type ThreadRow = typeof accountThreads.$inferSelect
type EpisodeRow = typeof accountEpisodes.$inferSelect
type SlotRow = typeof accountSlots.$inferSelect
type EntryRow = typeof accountEntries.$inferSelect

const toThread = (row: ThreadRow): AccountThread => ({
  id: AccountThreadIdSchema.parse(row.id),
  accountId: row.accountId,
  createdAt: row.createdAt,
})

const toEpisode = (row: EpisodeRow): AccountEpisode => ({
  id: AccountEpisodeIdSchema.parse(row.id),
  threadId: AccountThreadIdSchema.parse(row.threadId),
  openedBy: row.openedBy,
  kind: row.kind,
  turn: row.turn,
  title: row.title,
  outcome: row.outcome,
  wall: row.wall,
  openedAt: row.openedAt,
  closedAt: row.closedAt,
})

const toSlot = (row: SlotRow): AccountSlot => ({
  id: AccountSlotIdSchema.parse(row.id),
  episodeId: AccountEpisodeIdSchema.parse(row.episodeId),
  label: row.label,
  secret: row.secret,
  filledBy: row.filledBy,
  filledAt: row.filledAt,
  value: row.value,
  takenAt: row.takenAt,
  takenTo: row.takenTo,
})

const toEntry = (row: EntryRow): AccountEntry => ({
  id: AccountEntryIdSchema.parse(row.id),
  episodeId: AccountEpisodeIdSchema.parse(row.episodeId),
  author: row.author,
  body: row.body,
  createdAt: row.createdAt,
})

export type { AccountEntryId, AccountEpisodeId, AccountSlotId, AccountThreadId }
