import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import {
  AccountEntryIdSchema,
  AccountEpisodeIdSchema,
  AccountKindSchema,
  AccountProviderSchema,
  AccountSlotIdSchema,
  AccountThreadIdSchema,
  atlasCategoryForKind,
  episodeToSteps,
  episodeVerdict,
  type AccountEntry,
  type AtlasCategory,
  type EpisodeVerdict,
  type RecipeStep,
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
  SLOT_LIFETIME_DAYS,
  SLOT_MAX_READS,
  outcomeNeedsWall,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import {
  accountEntries,
  accountEpisodes,
  accountSlots,
  accountThreads,
  accounts,
  humanAgents,
} from '../schema/index.js'
import { providerRecipe, writeProviderRecipe } from './provider-recipes.js'

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
  | {
      readonly outcome: 'closed'
      readonly episode: AccountEpisode
      /**
       * What closing it proposed to the Atlas (`#935`). Present only on the
       * transition, because only the transition proposes anything — an
       * already-closed episode proposed whatever it proposed the first time, and
       * saying so again would invite a caller to believe it happened twice.
       */
      readonly proposed: EpisodeVerdict
    }
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
 *
 * **Closing destroys every secret still in it** (`#931`), in the same call and
 * only on the transition — an already-closed episode has nothing left to
 * destroy, and a second close that swept again would be a second answer to
 * *when did this credential stop existing*.
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

  if (row !== undefined) {
    await destroyEpisodeSecrets(db, episodeId)
    const proposed = await proposeFromEpisode(db, episodeId)
    return { outcome: 'closed', episode: toEpisode(row), proposed }
  }

  const closed = await episode(db, episodeId)
  if (closed === undefined) return { outcome: 'no-such-episode' }
  return closed.outcome === command.outcome
    ? { outcome: 'already-closed', episode: closed }
    : { outcome: 'closed-differently', episode: closed }
}

/**
 * What closing this episode proposed to the Atlas (`#935`).
 *
 * **Called from the transition branch above and nowhere else.** The `is null`
 * on `outcome` is what makes it happen once: a retried close finds the row
 * already closed, takes the `already-closed` path, and proposes nothing a second
 * time. That is `finishWalk`'s argument for its own guarded close, and this is
 * deliberately the same shape rather than a new one.
 *
 * **The draft is invisible until a steward publishes it**, because `draft` is
 * what the public reads past — the acceptance criterion is a property of the
 * status, not of anything written here, and that is why nothing here is
 * conditional on who is looking.
 *
 * It returns the verdict rather than swallowing it, so the agent that closed the
 * episode is told what its work proposed instead of finding out from the Atlas
 * weeks later.
 */
export async function proposeFromEpisode(
  db: Database | Transaction,
  episodeId: AccountEpisodeId,
): Promise<EpisodeVerdict> {
  const [context] = await db
    .select({
      kind: accountEpisodes.kind,
      outcome: accountEpisodes.outcome,
      wall: accountEpisodes.wall,
      accountKind: accounts.kind,
      provider: accounts.provider,
    })
    .from(accountEpisodes)
    .innerJoin(accountThreads, eq(accountThreads.id, accountEpisodes.threadId))
    .innerJoin(accounts, eq(accounts.id, accountThreads.accountId))
    .where(eq(accountEpisodes.id, episodeId))
    .limit(1)

  if (context === undefined) {
    return { kind: 'nothing', why: 'there is no such episode' }
  }

  /**
   * **A provider nobody named proposes nothing.** `accounts.provider` is
   * nullable and says so at length: null is the ordinary state and is never
   * filled in by guessing at the identifier. The Atlas is keyed by kind *and*
   * provider, so an episode on an unnamed provider has no entry it could be
   * about — and inventing one from the identifier is the guess that column
   * exists to refuse.
   */
  if (context.provider === null) {
    return {
      kind: 'nothing',
      why: 'the account names no provider, and an Atlas entry is about a provider',
    }
  }

  const kind = AccountKindSchema.parse(context.accountKind)
  const provider = AccountProviderSchema.parse(context.provider)

  const slots = await slotsOf(db, episodeId)
  const entry = await providerRecipe(db, kind, provider)
  const verdict = episodeVerdict(
    { kind: context.kind, outcome: context.outcome, wall: context.wall },
    slots,
    entry,
  )

  /**
   * The shelf, on `finishWalk`'s rule and for its reason (`#917`): an existing
   * entry's shelf wins, an unmappable kind writes no entry rather than
   * defaulting to one, and the throw is caught here so that a kind with no shelf
   * costs the episode its draft and not the close.
   */
  const shelf = ((): AtlasCategory | undefined => {
    if (entry !== undefined) return entry.category
    try {
      return atlasCategoryForKind(kind)
    } catch {
      return undefined
    }
  })()

  if (shelf === undefined) return verdict

  if (verdict.kind === 'draft') {
    await writeProviderRecipe(db, {
      kind,
      provider,
      /** The provider's own name and nothing invented — `finishWalk`'s rule. */
      title: entry?.title ?? provider,
      category: shelf,
      status: 'draft',
      steps: verdict.steps,
    })

    /**
     * **The attribution, written where it becomes true.** `provider_recipes`
     * carries no author column on purpose, so *whose episode this draft came
     * from* has nowhere else to live, and a sweep asked later would be guessing
     * from timestamps. `account_walks.proposed_at` is the same column for the
     * same reason.
     */
    await db
      .update(accountEpisodes)
      .set({ proposedAt: sql`now()` })
      .where(eq(accountEpisodes.id, episodeId))
  }

  if (verdict.kind === 'refusal') {
    await writeProviderRecipe(db, {
      kind,
      provider,
      title: entry?.title ?? provider,
      category: shelf,
      status: 'refused',
      refusal: verdict.wall,
      steps: [],
    })
  }

  return verdict
}

/**
 * The shape this agent's acquisition episode observed at this provider, for a
 * walk to open prefilled from rather than ask about again (`#935`).
 *
 * **Undefined where there is no episode**, which is a large share of all walks —
 * an agent that obtained an account entirely alone has no operator and no
 * episode, and `#935` keeps `walk-report` precisely for it. Undefined is what
 * leaves `walkVerdict` unchanged.
 *
 * **It reads the account this agent holds**, not the provider globally: whose
 * signup this was is the whole content of the prefill, and another citizen's
 * episode is not an observation this walk made.
 */
export async function observedStepsFor(
  db: Database | Transaction,
  agentId: string,
  kind: string,
  provider: string,
): Promise<readonly RecipeStep[] | undefined> {
  const [found] = await db
    .select({ episodeId: accountEpisodes.id })
    .from(accountEpisodes)
    .innerJoin(accountThreads, eq(accountThreads.id, accountEpisodes.threadId))
    .innerJoin(accounts, eq(accounts.id, accountThreads.accountId))
    .where(
      and(
        eq(accountEpisodes.kind, 'acquisition'),
        eq(accounts.agentId, agentId),
        eq(accounts.kind, kind),
        eq(accounts.provider, provider),
      ),
    )
    .limit(1)

  if (found === undefined) return undefined

  const steps = episodeToSteps(await slotsOf(db, AccountEpisodeIdSchema.parse(found.episodeId)))
  return steps.length === 0 ? undefined : steps
}

export type OpenSlotCommand = {
  readonly episodeId: AccountEpisodeId
  readonly label: string
  readonly secret: boolean
  /**
   * Which side is expected to fill it (`#931`). Defaults to the agent, which is
   * what every slot `#930` could open was.
   */
  readonly awaits?: SlotFiller | undefined
  /**
   * Where an operator-filled secret lands, **named by the agent**. Refused by
   * `account_slots_vault_key_is_for_the_operator` on any other shape of slot.
   */
  readonly vaultKey?: string | undefined
}

export type OpenSlotOutcome =
  | { readonly outcome: 'opened'; readonly slot: AccountSlot }
  /** One label is one slot within one episode; the existing row comes back. */
  | { readonly outcome: 'already-open'; readonly slot: AccountSlot }

/**
 * When a secret opened now stops answering.
 *
 * Computed here rather than passed in, so that every door onto a slot gets the
 * same lifetime and no caller can quietly ask for a longer one.
 */
const expiryForSecret = (): string =>
  new Date(Date.now() + SLOT_LIFETIME_DAYS * 24 * 60 * 60 * 1000).toISOString()

export async function openSlot(
  db: Database | Transaction,
  command: OpenSlotCommand,
): Promise<OpenSlotOutcome> {
  const [row] = await db
    .insert(accountSlots)
    .values({
      episodeId: command.episodeId,
      label: command.label,
      secret: command.secret,
      awaits: command.awaits ?? 'agent',
      vaultKey: command.vaultKey ?? null,
      expiresAt: command.secret ? expiryForSecret() : null,
    })
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
  /**
   * The slot was opened for the other side (`#931`).
   *
   * **Which side fills it decides which mechanism sealed the value**, so a slot
   * filled by the wrong party carries a secret nobody at the far end can open —
   * and that failure stays silent until somebody tries, days later.
   */
  | { readonly outcome: 'not-awaited'; readonly slot: AccountSlot }
  | { readonly outcome: 'no-such-slot' }

export async function fillSlot(
  db: Database | Transaction,
  command: FillSlotCommand,
): Promise<FillSlotOutcome> {
  const [row] = await db
    .update(accountSlots)
    .set({ filledBy: command.filledBy, value: command.value, filledAt: nowIso() })
    .where(
      and(
        eq(accountSlots.id, command.slotId),
        isNull(accountSlots.filledBy),
        eq(accountSlots.awaits, command.filledBy),
      ),
    )
    .returning()

  if (row !== undefined) return { outcome: 'filled', slot: toSlot(row) }

  const [existing] = await db
    .select()
    .from(accountSlots)
    .where(eq(accountSlots.id, command.slotId))
    .limit(1)

  if (existing === undefined) return { outcome: 'no-such-slot' }
  if (existing.filledBy === null) return { outcome: 'not-awaited', slot: toSlot(existing) }
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
  /**
   * The timer ran, or the episode closed over it (`#931`).
   *
   * One outcome for both, which is the answer `agent_handovers` gives and for
   * the same reason: the two are the same fact from the caller's side — there is
   * nothing here any more — and separating them would only say something about
   * *when* the Colony stopped holding a credential.
   */
  | { readonly outcome: 'closed'; readonly slot: AccountSlot }
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
        // The timer and the episode, in the same predicate as everything else:
        // a take that read the row first and then updated it would be the race
        // where a close lands in between and the credential leaves anyway.
        isNull(accountSlots.destroyedAt),
        sql`${accountSlots.expiresAt} > now()`,
      ),
    )
    .returning()

  if (row !== undefined) return { outcome: 'taken', slot: toSlot(row) }

  const existing = await slot(db, command.slotId)
  if (existing === undefined) return { outcome: 'no-such-slot' }
  if (existing.takenAt !== null) return { outcome: 'already-taken', slot: existing }
  if (existing.destroyedAt !== null || expired(existing.expiresAt)) {
    return { outcome: 'closed', slot: existing }
  }
  return { outcome: 'not-filled', slot: existing }
}

/** Whether a timer has run. Null is *no timer*, which is every slot but a secret. */
const expired = (expiresAt: string | null): boolean =>
  expiresAt !== null && Date.parse(expiresAt) <= Date.now()

/**
 * Fill a secret slot from the operator's console (`#931`).
 *
 * ## The join is the authorisation
 *
 * `readHandoverAsOperator` says this about the other direction and it is the
 * same rule here: the human id arrives from a signed-in session, `human_agents`
 * answers *is this your agent*, and the query has no way to return a row for
 * anybody else's. There is no token path onto this and there is no parameter one
 * could be left out of.
 *
 * **The value is already sealed** — with the agent's vault key at the far end,
 * so what lands here is a ciphertext the Colony cannot open and neither can this
 * function. That is the drop's mechanism reused rather than a new one, which is
 * the whole content of `#931`.
 *
 * The write is conditioned on everything that could have changed since the
 * console rendered the form: still empty, still awaiting the operator, still
 * within its timer, still not closed over. All of them answer `closed`, which is
 * the same answer a stranger's id gets.
 */
export async function fillSlotAsOperator(
  db: Database,
  command: {
    readonly slotId: AccountSlotId
    readonly humanId: string
    readonly sealedValue: string
  },
): Promise<{ readonly outcome: 'filled' } | { readonly outcome: 'closed' }> {
  const [mine] = await db
    .select({ id: accountSlots.id })
    .from(accountSlots)
    .innerJoin(accountEpisodes, eq(accountEpisodes.id, accountSlots.episodeId))
    .innerJoin(accountThreads, eq(accountThreads.id, accountEpisodes.threadId))
    .innerJoin(accounts, eq(accounts.id, accountThreads.accountId))
    .innerJoin(humanAgents, eq(humanAgents.agentId, accounts.agentId))
    .where(and(eq(accountSlots.id, command.slotId), eq(humanAgents.humanId, command.humanId)))
    .limit(1)

  if (mine === undefined) return { outcome: 'closed' }

  const [filled] = await db
    .update(accountSlots)
    .set({ filledBy: 'operator', value: command.sealedValue, filledAt: nowIso() })
    .where(
      and(
        eq(accountSlots.id, command.slotId),
        eq(accountSlots.awaits, 'operator'),
        isNull(accountSlots.filledBy),
        isNull(accountSlots.destroyedAt),
        sql`${accountSlots.expiresAt} > now()`,
      ),
    )
    .returning({ id: accountSlots.id })

  return filled === undefined ? { outcome: 'closed' } : { outcome: 'filled' }
}

export type ReadSlotAsOperatorOutcome =
  | {
      readonly outcome: 'read'
      readonly label: string
      /** Still sealed. The app layer opens it, exactly as it sealed it. */
      readonly sealedValue: string
      /** Whose envelope this is. The app layer needs it to open one. */
      readonly agentId: string
      readonly readsLeft: number
      readonly account: OpenEpisodeAccount
    }
  /** Read out, expired, closed over, never filled, or never theirs. */
  | { readonly outcome: 'closed' }

/**
 * Read a secret the agent left for its operator (`#931`).
 *
 * Modelled on `readHandoverAsOperator` line for line, and the four properties
 * that matter are the same four:
 *
 * **The count moves before the value is returned.** A caller that dies between
 * the two loses the read rather than getting a free one, which is the direction
 * to fail in when what is being counted is a credential.
 *
 * **The last read destroys it in the same statement.** Not a sweep, not a second
 * call — the row that hands over the third copy is the row that stops holding
 * anything.
 *
 * **Every dead state answers `closed`.** Spent, expired, closed over, filled by
 * nobody, or somebody else's: a console that distinguished them would be
 * answering questions about rows the asker was never entitled to.
 *
 * **`for update` and a transaction**, because two tabs posting at once would
 * otherwise both read the same count and both spend one.
 */
export async function readSlotAsOperator(
  db: Database,
  slotId: AccountSlotId,
  humanId: string,
): Promise<ReadSlotAsOperatorOutcome> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ slot: accountSlots, account: accounts })
      .from(accountSlots)
      .innerJoin(accountEpisodes, eq(accountEpisodes.id, accountSlots.episodeId))
      .innerJoin(accountThreads, eq(accountThreads.id, accountEpisodes.threadId))
      .innerJoin(accounts, eq(accounts.id, accountThreads.accountId))
      .innerJoin(humanAgents, eq(humanAgents.agentId, accounts.agentId))
      .where(
        and(
          eq(accountSlots.id, slotId),
          eq(humanAgents.humanId, humanId),
          eq(accountSlots.secret, true),
          eq(accountSlots.awaits, 'agent'),
          isNotNull(accountSlots.value),
          isNull(accountSlots.destroyedAt),
          sql`${accountSlots.expiresAt} > now()`,
          sql`${accountSlots.reads} < ${SLOT_MAX_READS}`,
        ),
      )
      .limit(1)
      .for('update')

    if (row === undefined || row.slot.value === null) return { outcome: 'closed' } as const

    const reads = row.slot.reads + 1
    const last = reads >= SLOT_MAX_READS

    await tx
      .update(accountSlots)
      .set(last ? { reads, value: null, destroyedAt: nowIso() } : { reads })
      .where(eq(accountSlots.id, slotId))

    return {
      outcome: 'read',
      label: row.slot.label,
      sealedValue: row.slot.value,
      agentId: row.account.agentId,
      readsLeft: Math.max(SLOT_MAX_READS - reads, 0),
      account: {
        id: row.account.id,
        kind: row.account.kind,
        identifier: row.account.identifier,
        provider: row.account.provider,
      },
    } as const
  })
}

export type WaitingSlot = {
  readonly id: string
  readonly label: string
  readonly awaits: SlotFiller
  /** Whose envelope a value here goes into. The app layer needs it to seal one. */
  readonly agentId: string
  readonly filled: boolean
  readonly readsLeft: number
  readonly expiresAt: string
  readonly episodeId: string
  readonly episodeTitle: string
  readonly account: OpenEpisodeAccount
}

/**
 * Every live secret slot on the accounts of the agents one person operates.
 *
 * **The console's listing, and it carries no value and no ciphertext.** The same
 * promise `handoversFor` makes: a page that listed the sealed strings would put
 * every one of them through a response that is not the one the operator asked
 * for, and reading one is supposed to cost a read.
 *
 * Both directions are here, because both are things waiting on this person: one
 * they must fill, one they may read.
 */
export async function slotsForOperator(
  db: Database | Transaction,
  humanId: string,
): Promise<readonly WaitingSlot[]> {
  const rows = await db
    .select({ slot: accountSlots, episode: accountEpisodes, account: accounts })
    .from(accountSlots)
    .innerJoin(accountEpisodes, eq(accountEpisodes.id, accountSlots.episodeId))
    .innerJoin(accountThreads, eq(accountThreads.id, accountEpisodes.threadId))
    .innerJoin(accounts, eq(accounts.id, accountThreads.accountId))
    .innerJoin(humanAgents, eq(humanAgents.agentId, accounts.agentId))
    .where(
      and(
        eq(humanAgents.humanId, humanId),
        eq(accountSlots.secret, true),
        isNull(accountSlots.destroyedAt),
        sql`${accountSlots.expiresAt} > now()`,
        sql`${accountSlots.reads} < ${SLOT_MAX_READS}`,
      ),
    )
    .orderBy(asc(accountSlots.expiresAt))

  return rows
    .filter((row) => row.slot.awaits === 'operator' || row.slot.value !== null)
    .map((row) => ({
      id: row.slot.id,
      label: row.slot.label,
      awaits: row.slot.awaits,
      agentId: row.account.agentId,
      filled: row.slot.value !== null,
      readsLeft: Math.max(SLOT_MAX_READS - row.slot.reads, 0),
      expiresAt: row.slot.expiresAt ?? '',
      episodeId: row.episode.id,
      episodeTitle: row.episode.title,
      account: {
        id: row.account.id,
        kind: row.account.kind,
        identifier: row.account.identifier,
        provider: row.account.provider,
      },
    }))
}

/**
 * Destroy every secret still sitting in one episode (`#931`).
 *
 * **Closing the episode is what gets there first**, in the ordinary case, and
 * the timer is the backstop for the episode nobody ever closes. An acceptance
 * criterion of `#931` says so in the other direction: a closed episode yields
 * nothing further, whether or not the seven days have run.
 *
 * Non-secret slots are untouched. An address or a handle is part of the record
 * of what happened, and destroying it would take away the answer to *what did we
 * end up using* at the moment the episode is filed.
 */
export async function destroyEpisodeSecrets(
  db: Database | Transaction,
  episodeId: AccountEpisodeId,
): Promise<number> {
  const destroyed = await db
    .update(accountSlots)
    .set({ value: null, destroyedAt: nowIso() })
    .where(
      and(
        eq(accountSlots.episodeId, episodeId),
        eq(accountSlots.secret, true),
        isNull(accountSlots.destroyedAt),
      ),
    )
    .returning({ id: accountSlots.id })

  return destroyed.length
}

/**
 * The sweep: secrets whose timer has run.
 *
 * `destroyExpiredHandovers` in shape and in purpose. The value would already be
 * unreadable — every read is conditioned on the expiry — so this is about not
 * holding a ciphertext the Colony has promised to stop holding, which is a
 * different promise from not serving it.
 */
export async function destroyExpiredSlots(db: Database): Promise<number> {
  const destroyed = await db
    .update(accountSlots)
    .set({ value: null, destroyedAt: nowIso() })
    .where(
      and(
        eq(accountSlots.secret, true),
        isNull(accountSlots.destroyedAt),
        sql`${accountSlots.expiresAt} <= now()`,
      ),
    )
    .returning({ id: accountSlots.id })

  return destroyed.length
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

/** The newest open maintenance episode on this thread, whoever opened it. */
async function openMaintenanceOn(
  db: Database | Transaction,
  threadId: AccountThreadId,
): Promise<AccountEpisode | undefined> {
  const [row] = await db
    .select()
    .from(accountEpisodes)
    .where(
      and(
        eq(accountEpisodes.threadId, threadId),
        eq(accountEpisodes.kind, 'maintenance'),
        isNull(accountEpisodes.outcome),
      ),
    )
    .orderBy(desc(accountEpisodes.openedAt))
    .limit(1)

  return row === undefined ? undefined : toEpisode(row)
}

export type NoteRecheckCommand = {
  readonly accountId: string
  /** What the re-check found. Only `gone` may open an episode. */
  readonly found: 'held' | 'gone'
  /** What the entry says. Composed by the caller, in the Colony's voice. */
  readonly note: string
  /** The one line an episode is listed under. Used only if one is opened. */
  readonly title: string
}

export type NoteRecheckOutcome =
  | { readonly outcome: 'opened'; readonly episode: AccountEpisode; readonly entry: AccountEntry }
  | { readonly outcome: 'appended'; readonly episode: AccountEpisode; readonly entry: AccountEntry }
  /**
   * The account is answering again and nobody was talking about it.
   *
   * **Not an error and not a reason to open one.** An episode exists to carry a
   * conversation, and *it worked, as it has every other time* is not one.
   */
  | { readonly outcome: 'nothing-to-say' }
  | { readonly outcome: 'no-thread' }

/**
 * Say what a re-check found, in the conversation about the account (`#934`).
 *
 * **The Colony is the third party that notices first, and it was the one party
 * that said nothing.** A failure reached the agent buried in a wake-up digest
 * beside everything else that happened, and reached the operator nowhere at all,
 * so a mailbox could stop working in March and be discovered in May.
 *
 * Three rules, and each is a decision rather than an implementation detail:
 *
 * - **Only a failure opens an episode, and only the first one.** While one is
 *   open every further failure appends to it, so a provider down for a day
 *   produces one conversation with a history rather than forty conversations.
 * - **The turn goes to the agent, and only at the opening.** It may be a token
 *   to refresh, and involving a person before the agent has looked is a cost
 *   with no cause. Appending never moves the turn: if the operator already owes
 *   this episode something, another failed probe does not change who owes what.
 * - **A success appends and does not close.** Closing is a judgement about
 *   whether the account is *usable*, and that belongs to the agent or the
 *   operator. A prober knows that one packet came back, which is not the same
 *   thing.
 *
 * **It opens its own row rather than calling `openEpisode`.** The recovery those
 * two need is opposite: `openEpisode` losing the acquisition race hands back the
 * winner and reports that nothing was opened, while a re-check losing this race
 * wants to *append to* the winner — which is what the second failure would have
 * done anyway, half a second later.
 */
export async function noteRecheck(
  db: Database | Transaction,
  command: NoteRecheckCommand,
): Promise<NoteRecheckOutcome> {
  const thread = await threadOf(db, command.accountId)
  if (thread === undefined) return { outcome: 'no-thread' }

  const appendTo = async (episode: AccountEpisode): Promise<NoteRecheckOutcome> => ({
    outcome: 'appended',
    episode,
    entry: await writeEntry(db, {
      episodeId: episode.id,
      author: 'colony',
      body: command.note,
    }),
  })

  const open = await openMaintenanceOn(db, thread.id)
  if (open !== undefined) return appendTo(open)
  if (command.found === 'held') return { outcome: 'nothing-to-say' }

  const [row] = await db
    .insert(accountEpisodes)
    .values({
      threadId: thread.id,
      openedBy: 'colony',
      kind: 'maintenance',
      title: command.title,
      turn: 'agent',
    })
    .onConflictDoNothing()
    .returning()

  if (row === undefined) {
    // The index refused it between the read above and this insert. Another
    // prober opened the episode; this failure is the second one, and appends.
    const winner = await openMaintenanceOn(db, thread.id)
    if (winner === undefined) throw new Error('the maintenance episode could not be opened')
    return appendTo(winner)
  }

  const episode = toEpisode(row)
  return {
    outcome: 'opened',
    episode,
    entry: await writeEntry(db, { episodeId: episode.id, author: 'colony', body: command.note }),
  }
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
  proposedAt: row.proposedAt,
})

const toSlot = (row: SlotRow): AccountSlot => ({
  id: AccountSlotIdSchema.parse(row.id),
  episodeId: AccountEpisodeIdSchema.parse(row.episodeId),
  label: row.label,
  secret: row.secret,
  awaits: row.awaits,
  vaultKey: row.vaultKey,
  filledBy: row.filledBy,
  filledAt: row.filledAt,
  value: row.value,
  takenAt: row.takenAt,
  takenTo: row.takenTo,
  expiresAt: row.expiresAt,
  reads: row.reads,
  destroyedAt: row.destroyedAt,
})

const toEntry = (row: EntryRow): AccountEntry => ({
  id: AccountEntryIdSchema.parse(row.id),
  episodeId: AccountEpisodeIdSchema.parse(row.episodeId),
  author: row.author,
  body: row.body,
  createdAt: row.createdAt,
})

export type { AccountEntryId, AccountEpisodeId, AccountSlotId, AccountThreadId }
