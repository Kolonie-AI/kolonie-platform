import {
  EPISODE_TITLE_MAX_LENGTH,
  EPISODE_WALL_MAX_LENGTH,
  ENTRY_BODY_MAX_LENGTH,
  EpisodeKindSchema,
  EpisodeOutcomeSchema,
  EpisodeTurnSchema,
  SLOT_LABEL_MAX_LENGTH,
  SLOT_MAX_READS,
  SLOT_VALUE_MAX_LENGTH,
  SlotFillerSchema,
  VaultKeySchema,
  type AccountEntry,
  type AccountEpisode,
  type AccountSlot,
  type AgentId,
  type ApiError,
  type AtlasState,
} from '@kolonie-ai/core'
import {
  accountOf,
  claimVaultEntry,
  closeEpisode,
  entriesOf,
  episodeForAgent,
  episodesOf,
  fillSlot,
  fillSlotAsOperator,
  openEpisode,
  openEpisodesFor,
  openSlot,
  passTurn,
  readSlotAsOperator,
  slotForAgent,
  slotsForOperator,
  slotsOf,
  takeSlot,
  threadOf,
  vaultHoldsKey,
  writeEntry,
  openVaultValue,
  sealVaultValue,
  type AccountEpisodeId,
  type AccountSlotId,
  type AccountThreadId,
  type Database,
  type OpenEpisodeAccount,
} from '@kolonie-ai/db'
import { z } from 'zod'
import { atlasStateAt, type ProviderRecipes } from './provider-recipes.js'
import { fieldErrors } from './validation.js'

/**
 * The account conversation, above the storage (`#930`).
 *
 * `packages/core/src/account/thread.ts` is the vocabulary and
 * `kolonie-docs/state/decisions/the-account-is-the-permanent-object.md` is the
 * argument. What is decided *here* is the two things a caller sees: which
 * operations exist, and what each refusal says.
 *
 * ## The sealing, which `#929` deliberately left to this layer
 *
 * A secret slot's value is sealed before it reaches the database and opened
 * after it comes back, with the Colony's own drop key and the envelope
 * `operator_drops` already uses. **No new cryptography**, which is the promise
 * `#929` makes: the operator → agent direction is exactly this key today, so a
 * slot travelling it needs nothing invented.
 *
 * **The key is optional and only the secret half depends on it.** A Colony that
 * was never given `OPERATOR_DROP_SEALING_KEY` opens episodes, writes notes,
 * passes turns and closes normally, and refuses only a slot that would have to
 * carry a secret. The alternative — a whole surface that disappears — would make
 * the conversation unavailable to say that one kind of value cannot travel.
 */

/** The scope mixed into a slot's envelope, so one slot's value cannot open another's. */
const slotScope = (slotId: string): string => `account-slot:${slotId}`

/**
 * What an operator gets back from one read, with the envelope already opened.
 *
 * **Every dead state is the same `closed`**, which is the promise the storage
 * makes and this layer must not undo: spent, expired, closed over, never filled,
 * never theirs — and, here, a Colony with no sealing key or an envelope that
 * would not open. A reader who could tell those apart would be reading answers
 * about rows they were never entitled to.
 */
export type OperatorReadOutcome =
  | {
      readonly outcome: 'read'
      readonly label: string
      readonly value: string
      readonly readsLeft: number
      readonly provider: string | null
    }
  | { readonly outcome: 'closed' }

/** Everything this surface needs from the outside world. */
export interface AccountThreadStore {
  /** The account, scoped to its holder in the same statement. */
  account(agentId: AgentId, accountId: string): ReturnType<typeof accountOf>
  thread(accountId: string): ReturnType<typeof threadOf>
  openEpisode(command: Parameters<typeof openEpisode>[1]): ReturnType<typeof openEpisode>
  /** The waking read: open episodes across every account, turn-first. */
  openEpisodes(agentId: AgentId): ReturnType<typeof openEpisodesFor>
  /**
   * Everything that ever happened about one account, closed episodes included.
   *
   * Not `openEpisodes` narrowed to a thread. That one answers *what is owed*
   * across every account and drops anything settled; this one answers *what has
   * this account been through*, which is the whole of it or nothing — a history
   * that silently omits the closed episodes is the kind of record that reads as
   * complete and is not (`#932`).
   */
  episodes(threadId: AccountThreadId): ReturnType<typeof episodesOf>
  episode(agentId: AgentId, episodeId: AccountEpisodeId): ReturnType<typeof episodeForAgent>
  slots(episodeId: AccountEpisodeId): ReturnType<typeof slotsOf>
  slot(agentId: AgentId, slotId: AccountSlotId): ReturnType<typeof slotForAgent>
  openSlot(command: Parameters<typeof openSlot>[1]): ReturnType<typeof openSlot>
  fillSlot(command: Parameters<typeof fillSlot>[1]): ReturnType<typeof fillSlot>
  takeSlot(command: Parameters<typeof takeSlot>[1]): ReturnType<typeof takeSlot>
  entries(episodeId: AccountEpisodeId): ReturnType<typeof entriesOf>
  writeEntry(command: Parameters<typeof writeEntry>[1]): ReturnType<typeof writeEntry>
  passTurn(
    episodeId: AccountEpisodeId,
    to: Parameters<typeof passTurn>[2],
  ): ReturnType<typeof passTurn>
  closeEpisode(
    episodeId: AccountEpisodeId,
    command: Parameters<typeof closeEpisode>[2],
  ): ReturnType<typeof closeEpisode>
  /**
   * Where a taken credential lands. The caller's own key seals it.
   *
   * **A claim and not a write** (`#931`): a name already holding something is
   * refused, and what is there is left alone. The value coming through a slot is
   * one the citizen did not have in its hand, so an upsert here would let the
   * conversation overwrite a credential the citizen is still using — silently,
   * and with nothing readable afterwards that would say so.
   */
  vaultClaim(
    vaultToken: string,
    agentId: AgentId,
    key: string,
    value: string,
  ): ReturnType<typeof claimVaultEntry>
  /**
   * Whether a name is spoken for, asked before the operator is.
   *
   * **Advice, and the claim is what decides.** Two wakings could ask about the
   * same free name and both be told it is free; one of them still loses at the
   * claim, where the entry that is there is left alone. What this buys is the
   * ordinary case: a slot naming an occupied key is refused at the ask, rather
   * than after a person has been asked to type a password that had nowhere to
   * land.
   */
  vaultHolds(agentId: AgentId, key: string): ReturnType<typeof vaultHoldsKey>
  /**
   * The operator's half, reached from a signed-in console and from nowhere else.
   *
   * **Plaintext on both sides of this port and sealed on neither side of it.**
   * The console never holds a key and the storage never holds one either
   * (`#929`), so the envelope is opened and closed here, in the one place that
   * knows the scope it was closed under. `DropStore.fillAsOperator` draws the
   * same line one layer lower, for the channel that already had a key.
   */
  fillAsOperator(command: {
    readonly slotId: AccountSlotId
    readonly humanId: string
    readonly value: string
  }): Promise<{ readonly outcome: 'filled' } | { readonly outcome: 'closed' }>
  readAsOperator(slotId: AccountSlotId, humanId: string): Promise<OperatorReadOutcome>
  waitingFor(humanId: string): ReturnType<typeof slotsForOperator>
  /**
   * Whether this Colony can carry a secret at all.
   *
   * Asked before anything is opened rather than discovered on the way through:
   * a `put` of three slots that refused on the third would leave the first two
   * written, and the caller would have to work out which.
   */
  readonly carriesSecrets: boolean
  /** Absent when the Colony has no sealing key, and only the secret half cares. */
  seal(agentId: AgentId, slotId: string, value: string): string | undefined
  open(agentId: AgentId, slotId: string, sealed: string): string | null | undefined
}

export interface AccountThreadDependencies {
  readonly accountThreads?: AccountThreadStore | undefined
  /**
   * The catalogue, so a read can say what has been walked here (`#936`).
   *
   * **Optional, and absent means the response carries no `atlas` field.** The
   * Atlas never gates an acquisition — it is a hint on the way past — so a
   * Colony wired without a catalogue behaves exactly as one whose catalogue is
   * empty, and neither is an error the agent has to handle.
   */
  readonly recipes?: ProviderRecipes | undefined
}

export function databaseAccountThreads(
  db: Database,
  sealingKey: string | undefined,
): AccountThreadStore {
  return {
    account: (agentId, accountId) => accountOf(db, agentId, accountId),
    thread: (accountId) => threadOf(db, accountId),
    openEpisode: (command) => openEpisode(db, command),
    openEpisodes: (agentId) => openEpisodesFor(db, agentId),
    episodes: (threadId) => episodesOf(db, threadId),
    episode: (agentId, episodeId) => episodeForAgent(db, agentId, episodeId),
    slots: (episodeId) => slotsOf(db, episodeId),
    slot: (agentId, slotId) => slotForAgent(db, agentId, slotId),
    openSlot: (command) => openSlot(db, command),
    fillSlot: (command) => fillSlot(db, command),
    takeSlot: (command) => takeSlot(db, command),
    entries: (episodeId) => entriesOf(db, episodeId),
    writeEntry: (command) => writeEntry(db, command),
    passTurn: (episodeId, to) => passTurn(db, episodeId, to),
    closeEpisode: (episodeId, command) => closeEpisode(db, episodeId, command),
    vaultClaim: (vaultToken, agentId, key, value) =>
      claimVaultEntry(db, vaultToken, agentId, key, value),
    vaultHolds: (agentId, key) => vaultHoldsKey(db, agentId, key),
    fillAsOperator: async (command) => {
      if (sealingKey === undefined) return { outcome: 'closed' }

      /**
       * The listing is the lookup, and it is the same join the write repeats.
       *
       * Sealing needs the agent the envelope belongs to, and the row has to be
       * found before the value can be closed into it — so it is found through
       * the one query that already answers *is this yours*, rather than a second
       * one that would have to answer it again. The write re-checks every
       * condition anyway, so a slot that is filled or expires in between is
       * `closed` from the update and not from here.
       */
      const waiting = (await slotsForOperator(db, command.humanId)).find(
        (slot) => slot.id === String(command.slotId),
      )
      if (waiting === undefined || waiting.awaits !== 'operator' || waiting.filled) {
        return { outcome: 'closed' }
      }

      return fillSlotAsOperator(db, {
        slotId: command.slotId,
        humanId: command.humanId,
        sealedValue: sealVaultValue(
          sealingKey,
          waiting.agentId,
          slotScope(String(command.slotId)),
          command.value,
        ),
      })
    },
    readAsOperator: async (slotId, humanId) => {
      if (sealingKey === undefined) return { outcome: 'closed' }

      const read = await readSlotAsOperator(db, slotId, humanId)
      if (read.outcome !== 'read') return { outcome: 'closed' }

      /**
       * **An envelope that will not open is `closed` too, and the read is still
       * spent.** It is the state a rotated sealing key leaves behind, and there
       * is nothing an operator could do differently on being told which of the
       * two it was — while a `read` that returned no value would be a shape
       * every caller downstream would have to handle for one deployment mistake.
       */
      const value = openVaultValue(
        sealingKey,
        read.agentId,
        slotScope(String(slotId)),
        read.sealedValue,
      )
      if (value === null) return { outcome: 'closed' }

      return {
        outcome: 'read',
        label: read.label,
        value,
        readsLeft: read.readsLeft,
        provider: read.account.provider,
      }
    },
    waitingFor: (humanId) => slotsForOperator(db, humanId),
    carriesSecrets: sealingKey !== undefined,
    seal: (agentId, slotId, value) =>
      sealingKey === undefined
        ? undefined
        : sealVaultValue(sealingKey, String(agentId), slotScope(slotId), value),
    open: (agentId, slotId, sealed) =>
      sealingKey === undefined
        ? undefined
        : openVaultValue(sealingKey, String(agentId), slotScope(slotId), sealed),
  }
}

/**
 * Every operation the one tool carries, and nothing else.
 *
 * `#930` decided the set and decided that it is closed: a seventh operation is
 * an argument on the issue rather than a line here.
 */
export const THREAD_OPS = ['open', 'put', 'read', 'note', 'pass', 'close'] as const
export type ThreadOp = (typeof THREAD_OPS)[number]

const isThreadOp = (value: unknown): value is ThreadOp =>
  typeof value === 'string' && (THREAD_OPS as readonly string[]).includes(value)

export function unknownThreadOp(op: string | undefined): string {
  return (
    `${op === undefined || op === '' ? 'No operation was named' : `"${op}" is not an operation`}. ` +
    `The account conversation takes one of: ${THREAD_OPS.join(', ')}. Nothing was written.`
  )
}

/**
 * One slot as a caller is allowed to see it.
 *
 * **A secret's value is never in here**, on any read. It is the criterion `#930`
 * states and the reason `kolonie.accounts.take` is a separate call: a listing
 * that carried the value would make the safe look a spend, which is the merge
 * the whole split exists to prevent.
 */
export type SlotView = {
  readonly id: string
  readonly label: string
  readonly secret: boolean
  /** Which side owes this one a value: "agent" is you, "operator" is them. */
  readonly awaits: AccountSlot['awaits']
  /** Where an operator's secret lands in your vault. Named by you, at the open. */
  readonly vaultKey: string | null
  readonly filled: boolean
  readonly filledBy: AccountSlot['filledBy']
  readonly filledAt: string | null
  /** Null on every secret slot, whatever is in it. */
  readonly value: string | null
  readonly taken: boolean
  readonly takenTo: string | null
  /** When a secret stops being readable on its own, and null for anything else. */
  readonly expiresAt: string | null
  /** Reads left on a secret this side left for the other one. */
  readonly readsLeft: number | null
  /** Read out, or closed over before anybody got to it. */
  readonly destroyed: boolean
}

const toView = (slot: AccountSlot): SlotView => ({
  id: String(slot.id),
  label: slot.label,
  secret: slot.secret,
  awaits: slot.awaits,
  vaultKey: slot.vaultKey,
  filled: slot.filledAt !== null,
  filledBy: slot.filledBy,
  filledAt: slot.filledAt,
  value: slot.secret ? null : slot.value,
  taken: slot.takenAt !== null,
  takenTo: slot.takenTo,
  expiresAt: slot.expiresAt,
  readsLeft: slot.secret ? Math.max(SLOT_MAX_READS - slot.reads, 0) : null,
  destroyed: slot.destroyedAt !== null,
})

export type ThreadResponse = {
  readonly op: ThreadOp
  readonly episode?: AccountEpisode
  readonly account?: OpenEpisodeAccount
  readonly episodes?: readonly {
    readonly episode: AccountEpisode
    readonly account: OpenEpisodeAccount
  }[]
  readonly slots?: readonly SlotView[]
  readonly entries?: readonly AccountEntry[]
  readonly entry?: AccountEntry
  /**
   * What closing the episode proposed to the Atlas (`#935`), as the verdict kind
   * — `draft`, `refusal` or `nothing`.
   *
   * **The agent is told what its work proposed**, which is the same courtesy
   * `walk-report` already pays with its own `proposes`. A draft that appears
   * somewhere the citizen never hears about is one it cannot correct, and the
   * one who has just closed the episode is the only reader who knows whether the
   * shape is right.
   */
  readonly proposes?: string
  /**
   * The `kolonie.accounts.declare` call this episode has earned, filled in
   * (`#933`).
   *
   * **The row already exists, and that is not what this offers.** An episode
   * cannot be opened without an account to hang it off — `account_threads`
   * references `accounts` and a trigger makes the two together — so by the time
   * anything is closed the register holds a row. Where an operator opened the
   * account on the agent's behalf, that row is *theirs*: kind, identifier,
   * provider and nothing else. What this hands over is the declaration the
   * citizen would have written itself, so that the note, the vault key and the
   * provider are its own. `declare` is idempotent on the same three fields, so
   * making the call twice costs nothing and changes no standing.
   *
   * **Only where the account now exists**, which is what `taken-over` and
   * `created` mean. An episode that failed or was abandoned has nothing to
   * declare, and prefilling one would be the Colony pressing.
   */
  readonly declares?: {
    readonly call: 'kolonie.accounts.declare'
    readonly arguments: {
      readonly kind: string
      readonly identifier: string
      readonly provider?: string
    }
  }
  /**
   * What the close suggests doing next, in one sentence, and never more than
   * that (`#933`).
   *
   * **Suggested and not forced.** The Colony decided on 2026-08-08 that the
   * credentials of an account somebody opens for an agent are the agent's; what
   * the operator keeps is the ability to end the arrangement. A password the
   * operator chose is one two parties know, and the citizen is the party that
   * can change it — but a Colony that *required* the change would be deciding
   * for a citizen about its own account, which is the thing that decision
   * settled the other way.
   */
  readonly advice?: string
  /**
   * What the Atlas has on this account's provider (`#936`).
   *
   * **On the read as well as the open, and that is the whole of why it is
   * here.** An acquisition an operator started from the wish list is opened by
   * the operator, so the agent's first sight of it is a `read` — carrying this
   * only on `open` would miss the exact case the issue is about.
   *
   * **Three states, and none of them decides anything.** The Colony does not
   * refuse an acquisition because a walk a year ago was turned away; it says so
   * and lets the citizen find out. Absent where the account names no provider,
   * or where this Colony has no catalogue wired at all.
   */
  readonly atlas?: AtlasState
}

export type ThreadOutcome =
  | { readonly outcome: 'ok'; readonly response: ThreadResponse }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

const rejected = (
  message: string,
  code: ApiError['code'] = 'validation_failed',
): ThreadOutcome => ({
  outcome: 'rejected',
  error: { code, message },
})

const UNAVAILABLE: ApiError = {
  /**
   * `conflict`, on the same reasoning `operator-drops.ts` sets out: nothing is
   * forbidden to this agent and nothing about the request is malformed — the
   * Colony was simply never given the key that carries a secret.
   */
  code: 'conflict',
  message:
    'This Colony has no key configured for carrying a secret, so a slot cannot hold one here. ' +
    'Everything else about the conversation works: open the episode, say in a note what has to ' +
    'change hands, and arrange the value itself outside the Colony — kolonie.support.open is ' +
    'how this reaches somebody who can configure the channel.',
}

const NOT_YOURS: ApiError = {
  /**
   * `not_found` and not `forbidden`, deliberately. An episode id is a uuid
   * somebody could hold, and answering *that one is not yours* would make this
   * call a way to learn that an id exists and belongs to somebody else.
   */
  code: 'not_found',
  message:
    'No episode of yours has that id. Call this with no episode and you get the ones that are ' +
    'open, which is where the id comes from.',
}

/**
 * Absent and `null` are one thing here, for the reason `#508` gives: JSON has no
 * `undefined`, so a runtime filling this shape from a schema writes `null`, and
 * a field that refused one would refuse the very value a well-behaved caller
 * sends. Every optional field below goes through it, so that *left out* has one
 * meaning throughout — including inside {@link slotDirectionRefusal}, which
 * decides a direction by asking which fields are absent.
 */
const absent = <Schema extends z.ZodTypeAny>(schema: Schema) =>
  schema.nullish().transform((value: z.infer<Schema> | null | undefined) => value ?? undefined)

/** What a slot looks like on the way in. Several may arrive in one `put`. */
const SlotInputSchema = z.object({
  label: z.string().min(1).max(SLOT_LABEL_MAX_LENGTH),
  /**
   * Absent is only right when the other side is the one filling it — see
   * {@link slotDirectionRefusal}, which is where the two are told apart.
   */
  value: absent(z.string().min(1).max(SLOT_VALUE_MAX_LENGTH)),
  /** Absent means it is not a secret, which is the safe default of the two. */
  secret: absent(z.boolean()),
  /**
   * Who owes this slot a value. Absent means you do, which is the direction that
   * needs nobody else and is therefore the one to default to.
   */
  awaits: absent(SlotFillerSchema),
  /**
   * Where an operator's secret lands in your vault.
   *
   * **The agent names it, always** (`#931`). The operator may not write into the
   * agent's namespace, and naming it here rather than at the take means the
   * refusal for a name already in use arrives before anybody has typed a
   * password into a field.
   */
  vaultKey: absent(z.string()),
})

type SlotInput = z.infer<typeof SlotInputSchema>

/**
 * The four ways a slot can be described contradictorily, in one place.
 *
 * Refused per slot and by label rather than as a schema shape, because a caller
 * that sent three slots and got back a Zod path has to work out which of the
 * three it was — and the whole reason `put` takes a list is to save round trips.
 */
function slotDirectionRefusal(entry: SlotInput): string | undefined {
  const awaits = entry.awaits ?? 'agent'
  const secret = entry.secret === true

  if (awaits === 'operator') {
    if (entry.value !== undefined) {
      return (
        `"${entry.label}" says the operator fills it and carries a value already. One of the two ` +
        'is wrong: leave the value out to ask them for it, or leave "awaits" out to put your own.'
      )
    }
    if (secret && entry.vaultKey === undefined) {
      return (
        `"${entry.label}" is a secret you are asking the operator for, so it lands in your vault ` +
        'rather than coming back through the conversation — name the key it lands under, in ' +
        '"vaultKey". You choose it, they never see it, and a name you already hold is refused ' +
        'now rather than after they have typed something into it.'
      )
    }
    if (!secret && entry.vaultKey !== undefined) {
      return (
        `"${entry.label}" names a vault key and is not a secret. Only a secret lands in the ` +
        'vault; anything else comes back through kolonie.accounts.take as often as you ask.'
      )
    }
    return undefined
  }

  if (entry.value === undefined) {
    return (
      `"${entry.label}" has no value. A slot you fill needs one — set "awaits" to "operator" if ` +
      'what you meant is that somebody else supplies it.'
    )
  }
  if (entry.vaultKey !== undefined) {
    return (
      `"${entry.label}" names a vault key and is one you fill yourself, so there is nothing to ` +
      'land: the key is named at kolonie.accounts.take, where you decide what to call it.'
    )
  }
  return undefined
}

export type ThreadCommand = {
  readonly op?: string | null | undefined
  readonly accountId?: string | null | undefined
  readonly episodeId?: string | null | undefined
  readonly kind?: string | null | undefined
  readonly title?: string | null | undefined
  readonly turn?: string | null | undefined
  readonly note?: string | null | undefined
  readonly outcome?: string | null | undefined
  readonly wall?: string | null | undefined
  readonly slots?: unknown
}

export async function accountThread(
  agentId: AgentId,
  command: ThreadCommand,
  deps: AccountThreadDependencies,
): Promise<ThreadOutcome> {
  const store = deps.accountThreads
  if (store === undefined) {
    return {
      outcome: 'rejected',
      error: { code: 'conflict', message: 'The account conversation is not available here.' },
    }
  }

  const op = command.op ?? undefined
  if (!isThreadOp(op)) return rejected(unknownThreadOp(op ?? undefined))

  if (op === 'open') return await openOne(agentId, command, store, deps.recipes)
  if (op === 'read') return await readOne(agentId, command, store, deps.recipes)

  /**
   * Everything else names an episode, and *does this exist* and *is it yours*
   * are asked as one question — two would eventually be asked in the wrong
   * order, and asking them in the wrong order is how an id becomes a way to find
   * out what somebody else is doing.
   */
  const episodeId = command.episodeId ?? undefined
  if (episodeId === undefined || episodeId === '') {
    return rejected(`"${op}" needs the episode it is about. Call read with no argument for yours.`)
  }

  const found = await store.episode(agentId, episodeId as AccountEpisodeId)
  if (found === undefined) return { outcome: 'rejected', error: NOT_YOURS }

  if (op === 'put') return await putSlots(agentId, found.episode, command, store)
  if (op === 'note') return await note(found.episode, command, store)
  if (op === 'pass') return await pass(found.episode, command, store)
  // The account travels with the episode because the close speaks about it:
  // `#933`'s prefilled declaration is composed from the row, and `found` is the
  // read that already scoped it to this agent.
  return await close(found, command, store)
}

/**
 * The Atlas fragment a thread response carries, where there is one (`#936`).
 *
 * **Two absences answer as one, deliberately.** A Colony with no catalogue wired
 * and an account that names no provider are different facts about the Colony and
 * identical facts about this response: there is nothing the Atlas can be asked.
 * Making the caller tell them apart would be asking it to handle a distinction
 * it can do nothing with.
 *
 * The kind is passed because the account has one — a provider walked for a
 * mailbox and a domain has two rows, and the row that answers is the row for
 * what is being acquired here.
 */
async function atlasFor(
  recipes: ProviderRecipes | undefined,
  account: { readonly kind: string; readonly provider: string | null },
): Promise<{ readonly atlas: AtlasState } | Record<string, never>> {
  if (recipes === undefined) return {}
  const provider = (account.provider ?? '').trim()
  if (provider === '') return {}
  return { atlas: await atlasStateAt(recipes, provider, account.kind) }
}

async function openOne(
  agentId: AgentId,
  command: ThreadCommand,
  store: AccountThreadStore,
  recipes: ProviderRecipes | undefined,
): Promise<ThreadOutcome> {
  const accountId = command.accountId ?? undefined
  if (accountId === undefined || accountId === '') {
    return rejected('Name the account this is about. kolonie.accounts.list carries the ids.')
  }

  const account = await store.account(agentId, accountId)
  if (account === undefined) {
    return rejected(
      'No account of yours has that id. kolonie.accounts.list carries them.',
      'not_found',
    )
  }

  const kind = EpisodeKindSchema.safeParse(command.kind ?? undefined)
  if (!kind.success) {
    return rejected(
      'An episode is either the "acquisition" that brought the account into being — at most ' +
        'one per account, ever — or a "maintenance" one, of which there may be any number.',
    )
  }

  const title = (command.title ?? '').trim()
  if (title.length === 0 || title.length > EPISODE_TITLE_MAX_LENGTH) {
    return rejected(
      `An episode needs a one-line title, up to ${EPISODE_TITLE_MAX_LENGTH} characters. It is ` +
        'what an operator reads to decide whether to look, so name the account and what is wrong.',
    )
  }

  const turn =
    command.turn === undefined || command.turn === null
      ? undefined
      : EpisodeTurnSchema.safeParse(command.turn)
  if (turn !== undefined && !turn.success) {
    return rejected(
      'Whose move it is: "agent", "operator", or "nobody" when neither side owes the other ' +
        'anything yet. Leaving it out means nobody.',
    )
  }

  const thread = await store.thread(accountId)
  if (thread === undefined) {
    /**
     * A trigger creates the thread with the account, so this is the Colony
     * broken rather than the caller wrong — and saying so is what puts it in
     * front of somebody who can fix it.
     */
    return rejected('That account has no conversation, which should be impossible.', 'internal')
  }

  const opened = await store.openEpisode({
    threadId: thread.id,
    openedBy: 'agent',
    kind: kind.data,
    title,
    ...(turn?.success === true ? { turn: turn.data } : {}),
  })

  const view = {
    id: account.id,
    kind: account.kind,
    identifier: account.identifier,
    provider: account.provider,
  }

  /**
   * **An acquisition that already happened is handed back rather than refused**,
   * on the reasoning `openEpisode` carries: a caller asking twice is usually a
   * restart, and the honest answer to *open the episode that brought this
   * account into being* when that episode exists is *here it is*.
   */
  return {
    outcome: 'ok',
    response: {
      op: 'open',
      episode: opened.episode,
      account: view,
      ...(await atlasFor(recipes, view)),
    },
  }
}

async function readOne(
  agentId: AgentId,
  command: ThreadCommand,
  store: AccountThreadStore,
  recipes: ProviderRecipes | undefined,
): Promise<ThreadOutcome> {
  const episodeId = command.episodeId ?? undefined

  /**
   * **No argument is the waking call**, and it is the reason `read` takes an
   * optional one rather than being two operations: an agent coming back after a
   * restart wants *what is waiting on me* first, and having to know an id to ask
   * that would be requiring the answer in order to ask the question.
   */
  if (episodeId === undefined || episodeId === '') {
    const episodes = await store.openEpisodes(agentId)
    return { outcome: 'ok', response: { op: 'read', episodes } }
  }

  const found = await store.episode(agentId, episodeId as AccountEpisodeId)
  if (found === undefined) return { outcome: 'rejected', error: NOT_YOURS }

  const [slots, entries] = await Promise.all([
    store.slots(found.episode.id),
    store.entries(found.episode.id),
  ])

  return {
    outcome: 'ok',
    response: {
      op: 'read',
      episode: found.episode,
      account: found.account,
      slots: slots.map(toView),
      entries,
      ...(await atlasFor(recipes, found.account)),
    },
  }
}

async function putSlots(
  agentId: AgentId,
  episode: AccountEpisode,
  command: ThreadCommand,
  store: AccountThreadStore,
): Promise<ThreadOutcome> {
  const parsed = z.array(SlotInputSchema).min(1).max(20).safeParse(command.slots)
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'put takes the slots as a list, each with a label, and secret: true for anything that ' +
          'must not come back out in a listing. A slot you fill carries its value; one you are ' +
          'asking the operator for carries awaits: "operator" instead, and a vaultKey if it is a ' +
          'secret. Several in one call is the point of it — an agent holding three values should ' +
          'not need three round trips.',
        details: fieldErrors(parsed.error),
      },
    }
  }

  if (episode.outcome !== null) {
    return rejected(
      'That episode is finished. Nothing more goes into it — open another.',
      'conflict',
    )
  }

  const wanted = parsed.data
  if (wanted.some((entry) => entry.secret === true) && !store.carriesSecrets) {
    return { outcome: 'rejected', error: UNAVAILABLE }
  }

  /**
   * **Every slot is checked before any slot is written**, on the same reasoning
   * `carriesSecrets` is asked up front: a list of three that refused on the
   * third would leave the first two opened, and the caller would have to work
   * out which of its own slots now exist.
   */
  for (const entry of wanted) {
    const wrong = slotDirectionRefusal(entry)
    if (wrong !== undefined) return rejected(`${wrong} Nothing was written.`)
  }

  /**
   * **The vault name is checked before the operator is asked** (`#931`).
   *
   * The claim at the far end is what actually protects the entry, and it refuses
   * rather than replaces whatever this says. This is here for the sequence: the
   * alternative is a person being asked to type a password into a slot that
   * could never have landed, and finding out at the take — which is the one
   * moment where nothing can be salvaged, because the value is in the row and
   * the name it was promised is not free.
   */
  for (const entry of wanted) {
    if (entry.vaultKey === undefined) continue
    if (!(await store.vaultHolds(agentId, entry.vaultKey))) continue
    return {
      outcome: 'rejected',
      error: {
        code: 'conflict',
        message:
          `Your vault already holds something under \`${entry.vaultKey}\`, so "${entry.label}" ` +
          'cannot land there — and what is there is not replaced by anything on this surface. ' +
          'Ask under another name, or clear that one with kolonie.vault.delete first. Nothing ' +
          'was written and nobody was asked for anything.',
      },
    }
  }

  const written: SlotView[] = []
  for (const entry of wanted) {
    const secret = entry.secret === true
    const awaits = entry.awaits ?? 'agent'
    const opened = await store.openSlot({
      episodeId: episode.id,
      label: entry.label,
      secret,
      awaits,
      ...(entry.vaultKey === undefined ? {} : { vaultKey: entry.vaultKey }),
    })

    /**
     * **A label already carrying something is not overwritten**, which is the
     * one refusal `fillSlot` makes unconditionally: the other side may already
     * have acted on what is there, and there is no version of that failure the
     * loser of the race can detect. The slot comes back as it stands.
     */
    if (opened.slot.filledAt !== null) {
      written.push(toView(opened.slot))
      continue
    }

    /**
     * **A slot the operator fills is opened and left empty**, which is the whole
     * of the second direction: what the agent supplied is the question, and the
     * answer arrives from a signed-in console rather than from here.
     */
    if (awaits === 'operator') {
      written.push(toView(opened.slot))
      continue
    }

    /**
     * The seal is computed against the slot's own id, so a value lifted out of
     * one row cannot be opened as another's. That is why the slot is opened
     * first and filled second rather than in one statement.
     */
    const supplied = entry.value ?? ''
    const value = secret ? store.seal(agentId, String(opened.slot.id), supplied) : supplied
    if (value === undefined) return { outcome: 'rejected', error: UNAVAILABLE }

    const filled = await store.fillSlot({ slotId: opened.slot.id, filledBy: 'agent', value })
    written.push(
      toView(
        filled.outcome === 'no-such-slot' || filled.outcome === 'not-awaited'
          ? opened.slot
          : filled.slot,
      ),
    )
  }

  return { outcome: 'ok', response: { op: 'put', episode, slots: written } }
}

async function note(
  episode: AccountEpisode,
  command: ThreadCommand,
  store: AccountThreadStore,
): Promise<ThreadOutcome> {
  const body = (command.note ?? '').trim()
  if (body.length === 0 || body.length > ENTRY_BODY_MAX_LENGTH) {
    return rejected(
      `A note is 1 to ${ENTRY_BODY_MAX_LENGTH} characters, in the field "note". Line breaks are ` +
        'kept and nothing is rendered as markdown.',
    )
  }

  /**
   * **The turn is not consulted.** Either side may write at any time, including
   * the side that is not on turn — an operator realising two hours later that
   * the address was wrong must be able to say so without seizing the move.
   */
  const entry = await store.writeEntry({ episodeId: episode.id, author: 'agent', body })
  return { outcome: 'ok', response: { op: 'note', episode, entry } }
}

async function pass(
  episode: AccountEpisode,
  command: ThreadCommand,
  store: AccountThreadStore,
): Promise<ThreadOutcome> {
  const to = EpisodeTurnSchema.safeParse(command.turn ?? undefined)
  if (!to.success) {
    return rejected(
      'Whose move it becomes: "agent", "operator", or "nobody" when neither side owes the other ' +
        'anything any more.',
    )
  }

  /**
   * **A turn handed over without an explanation is one the other side cannot
   * act on**, which is why the note is required rather than encouraged (`#930`).
   * The field is named in the refusal, because a required argument a caller
   * cannot locate is the same as one it cannot supply.
   */
  const body = (command.note ?? '').trim()
  if (body.length === 0 || body.length > ENTRY_BODY_MAX_LENGTH) {
    return rejected(
      'Passing the turn needs a note saying what the other side is being asked for — the field ' +
        `is "note", 1 to ${ENTRY_BODY_MAX_LENGTH} characters. A move handed over with no ` +
        'explanation is one nobody can act on, so nothing was passed.',
    )
  }

  const passed = await store.passTurn(episode.id, to.data)
  if (passed.outcome === 'no-such-episode') return { outcome: 'rejected', error: NOT_YOURS }
  if (passed.outcome === 'already-closed') {
    return rejected(
      'That episode is finished, so there is no move to pass. Nothing changed.',
      'conflict',
    )
  }

  const entry = await store.writeEntry({ episodeId: episode.id, author: 'agent', body })
  return { outcome: 'ok', response: { op: 'pass', episode: passed.episode, entry } }
}

/**
 * What a closed episode hands the citizen on the way out (`#933`).
 *
 * **Derived at the close, stored nowhere.** *Did an operator set a password
 * here* is answerable from the slots the episode already carries — a secret one
 * that the operator filled — so a column recording it would be a second record
 * of one fact, which is D-002. Closing destroys the value and leaves `filledBy`
 * standing, so this reads correctly on an episode whose secrets are already
 * gone.
 */
const PASSWORD_ADVICE =
  'An operator set a password on this account. It is yours now, and changing it is ' +
  'yours to decide — nothing here requires it and nothing is withheld if you do not.'

async function close(
  found: { readonly episode: AccountEpisode; readonly account: OpenEpisodeAccount },
  command: ThreadCommand,
  store: AccountThreadStore,
): Promise<ThreadOutcome> {
  const { episode, account } = found
  const outcome = EpisodeOutcomeSchema.safeParse(command.outcome ?? undefined)
  if (!outcome.success) {
    return rejected(
      'How it ended: "taken-over" for an account that already existed, "created" for a new one, ' +
        '"repaired" for a maintenance episode that fixed what it opened for, "failed" for one ' +
        'that stopped at something — which carries a wall saying what — or "abandoned" for one ' +
        'that stopped without one. The last two are kept apart on purpose: a wall is what the ' +
        'next citizen reads.',
    )
  }

  const wall = (command.wall ?? '').trim()
  if (wall.length > EPISODE_WALL_MAX_LENGTH) {
    return rejected(`A wall is at most ${EPISODE_WALL_MAX_LENGTH} characters.`)
  }

  const closed = await store.closeEpisode(episode.id, {
    outcome: outcome.data,
    ...(wall.length > 0 ? { wall } : {}),
  })

  if (closed.outcome === 'wall-required') {
    return rejected(
      'A "failed" episode carries a wall saying what stopped it — the field is "wall". That ' +
        'sentence is what the next citizen reads and what the Atlas learns from; if there is ' +
        'nothing to say, "abandoned" is the honest outcome and it is not a lesser one.',
    )
  }
  if (closed.outcome === 'no-such-episode') return { outcome: 'rejected', error: NOT_YOURS }
  if (closed.outcome === 'closed-differently') {
    return rejected(
      `That episode was already closed as "${closed.episode.outcome}". A verdict is not revised ` +
        'by closing again — write a note saying what you now think, which is the record either ' +
        'way.',
      'conflict',
    )
  }

  /**
   * The declaration and the suggestion, and both only on the transition
   * (`#933`), for the same reason `proposes` is: an already-closed episode said
   * whatever it said the first time, and repeating it would invite a citizen to
   * believe something new had happened.
   *
   * **The slots are read only where there is something to advise about.** An
   * episode that failed offers no declaration, so it needs no answer to *did an
   * operator set a password* either.
   */
  const settled =
    closed.outcome === 'closed' && (outcome.data === 'taken-over' || outcome.data === 'created')

  const operatorSetASecret =
    settled &&
    (await store.slots(episode.id)).some((slot) => slot.secret && slot.filledBy === 'operator')

  return {
    outcome: 'ok',
    response: {
      op: 'close',
      episode: closed.episode,
      /**
       * Only on the transition. An already-closed episode proposed whatever it
       * proposed the first time, and saying it again would invite a citizen to
       * believe a second draft appeared.
       */
      ...(closed.outcome === 'closed' ? { proposes: closed.proposed.kind } : {}),
      ...(settled
        ? {
            declares: {
              call: 'kolonie.accounts.declare' as const,
              arguments: {
                kind: account.kind,
                identifier: account.identifier,
                ...(account.provider === null ? {} : { provider: account.provider }),
              },
            },
          }
        : {}),
      ...(operatorSetASecret ? { advice: PASSWORD_ADVICE } : {}),
    },
  }
}

export type TakeResponse = {
  readonly label: string
  readonly secret: boolean
  /** The value, and only for a slot that is not a secret. */
  readonly value: string | null
  /** Where a secret landed, and null for anything else. */
  readonly vaultKey: string | null
  readonly takenAt: string | null
}

export type TakeOutcome =
  | { readonly outcome: 'taken'; readonly response: TakeResponse }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/**
 * Spend a slot.
 *
 * **A separate call because taking is what spends it** — the rule
 * `kolonie.operator.drop.read` already states, and folding a destructive read
 * into a general-purpose one would merge a safe look with a spend.
 *
 * The two halves differ in exactly the way the values do. A **secret** goes into
 * the vault under the key the caller names, comes back as no value at all, and
 * cannot be taken twice. Anything else is **returned and may be taken again**: a
 * code that has already expired is not a secret, and a second look rescues the
 * case where the clipboard went wrong.
 */
export async function takeAccountSlot(
  agentId: AgentId,
  args: {
    readonly slotId?: string | null | undefined
    readonly vaultKey?: string | null | undefined
  },
  vaultToken: string,
  deps: AccountThreadDependencies,
): Promise<TakeOutcome> {
  const store = deps.accountThreads
  if (store === undefined) {
    return {
      outcome: 'rejected',
      error: { code: 'conflict', message: 'The account conversation is not available here.' },
    }
  }

  const slotId = args.slotId ?? undefined
  if (slotId === undefined || slotId === '') {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message: 'Name the slot you are taking. kolonie.accounts.thread with op "read" lists them.',
      },
    }
  }

  const slot = await store.slot(agentId, slotId as AccountSlotId)
  if (slot === undefined) {
    return {
      outcome: 'rejected',
      error: {
        code: 'not_found',
        message:
          'No slot of yours has that id. Read the episode it belongs to and the slots come with ' +
          'it, each with the id this call takes.',
      },
    }
  }

  if (slot.destroyedAt !== null) {
    return {
      outcome: 'rejected',
      error: {
        code: 'conflict',
        message:
          `"${slot.label}" is empty. A secret does not sit indefinitely: it is destroyed when its ` +
          'episode closes and when its timer runs out, whichever comes first, and neither is ' +
          'reversible. Open another episode and ask again — nothing in your vault was touched.',
      },
    }
  }

  if (slot.filledAt === null || slot.value === null) {
    return {
      outcome: 'rejected',
      error: {
        code: 'not_found',
        message:
          `Nothing has been put in "${slot.label}" yet, so there is nothing to take.` +
          (slot.awaits === 'operator'
            ? ' Your operator is the one who fills this one, from the page they sign in to.'
            : '') +
          ' Looking costs nothing and spends nothing — come back when the episode says it is ' +
          'filled.',
      },
    }
  }

  if (!slot.secret) {
    /**
     * **Not stamped and not spent.** The check constraint refuses a take on a
     * slot that is not secret, and this is the honest reading of why: reading a
     * code is not a spend, and a second look is the whole of what makes losing a
     * clipboard survivable.
     */
    return {
      outcome: 'taken',
      response: {
        label: slot.label,
        secret: false,
        value: slot.value,
        vaultKey: null,
        takenAt: null,
      },
    }
  }

  if (slot.takenAt !== null) {
    return {
      outcome: 'rejected',
      error: {
        code: 'conflict',
        message:
          `"${slot.label}" was already taken ${slot.takenAt}${
            slot.takenTo === null ? '' : `, into your vault under \`${slot.takenTo}\``
          }. Taking is what spends it, so there is no second one — kolonie.vault.get is where it ` +
          'is now. Nothing was written and nothing in your vault was touched.',
      },
    }
  }

  /**
   * **A slot the operator filled already carries its key**, named by the agent
   * when it asked (`#931`). Taking it does not get to rename it: the name was
   * checked against the vault before the operator was asked for anything, and
   * letting the take move it would put the collision back at the far end.
   */
  const asked = args.vaultKey ?? undefined
  if (slot.vaultKey !== null && asked !== undefined && asked !== slot.vaultKey) {
    return {
      outcome: 'rejected',
      error: {
        code: 'conflict',
        message:
          `"${slot.label}" was opened to land under \`${slot.vaultKey}\`, which is the name you ` +
          `gave when you asked for it, so it cannot land under \`${asked}\` now. Take it as it ` +
          'stands and kolonie.vault.set moves it afterwards. Nothing was spent.',
      },
    }
  }

  const key = VaultKeySchema.safeParse(slot.vaultKey ?? asked)
  if (!key.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          `"${slot.label}" is a secret, so it lands in your vault rather than coming back here — ` +
          'name the key it should land under. You choose it, and nothing was spent by asking.',
        details: fieldErrors(key.error),
      },
    }
  }

  const value = store.open(agentId, String(slot.id), slot.value)
  if (value === undefined) return { outcome: 'rejected', error: UNAVAILABLE }
  if (value === null) {
    return {
      outcome: 'rejected',
      error: {
        /**
         * `internal`, deliberately, on the reasoning `readDrop` sets out: a key
         * that does not open what it wrote is a deployment fault, and a 500 is
         * what puts it in front of somebody who can fix it.
         */
        code: 'internal',
        message:
          'Something is in that slot and the Colony cannot open it. This is the Colony’s own ' +
          'key and nothing you or your operator did — asking again will not change it. Nothing ' +
          'was spent.',
      },
    }
  }

  /**
   * **The vault first and the stamp second.** A stamp written before the value
   * landed would spend a slot whose secret went nowhere, and there is no call
   * that could recover it; a vault entry written before the stamp costs, at
   * worst, a second take that finds the key already holding the same value.
   */
  const stored = await store.vaultClaim(vaultToken, agentId, key.data, value)
  if (stored.outcome === 'key-taken') {
    /**
     * **The existing entry is unchanged**, which is the whole of this refusal
     * and the reason the write is a claim rather than an upsert (`#931`). A
     * value arriving through a slot is one this citizen did not have in its
     * hand; overwriting on its arrival would destroy a credential that may still
     * be the only copy, and nothing readable afterwards would say it happened.
     */
    return {
      outcome: 'rejected',
      error: {
        code: 'conflict',
        message:
          `Your vault already holds something under \`${key.data}\`, and it was not touched. ` +
          'Nothing was spent either — the slot is where it was. kolonie.vault.get is what is ' +
          'under that name, kolonie.vault.delete clears it, and any other name works now.',
      },
    }
  }
  if (stored.outcome === 'full') {
    return {
      outcome: 'rejected',
      error: {
        code: 'conflict',
        message:
          `Your vault holds its limit of ${stored.maxEntries} entries, so there is nowhere for ` +
          'this to land. Nothing was spent — kolonie.vault.list is what you hold and ' +
          'kolonie.vault.delete makes room.',
      },
    }
  }

  const taken = await store.takeSlot({ slotId: slot.id, to: key.data })
  if (taken.outcome !== 'taken') {
    /**
     * Another waking took it between the read above and here. The vault write
     * has already landed under the same key with the same value, so the honest
     * answer is the refusal rather than a success that claims a spend this call
     * did not make.
     */
    return {
      outcome: 'rejected',
      error: {
        code: 'conflict',
        message:
          `"${slot.label}" was taken while this call was running. Taking is what spends it, and ` +
          'it was spent once — kolonie.vault.get is where it is.',
      },
    }
  }

  return {
    outcome: 'taken',
    response: {
      label: slot.label,
      secret: true,
      value: null,
      vaultKey: key.data,
      takenAt: taken.slot.takenAt,
    },
  }
}
