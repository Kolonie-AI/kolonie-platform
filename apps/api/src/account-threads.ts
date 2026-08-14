import {
  EPISODE_TITLE_MAX_LENGTH,
  EPISODE_WALL_MAX_LENGTH,
  ENTRY_BODY_MAX_LENGTH,
  EpisodeKindSchema,
  EpisodeOutcomeSchema,
  EpisodeTurnSchema,
  SLOT_LABEL_MAX_LENGTH,
  SLOT_VALUE_MAX_LENGTH,
  VaultKeySchema,
  type AccountEntry,
  type AccountEpisode,
  type AccountSlot,
  type AgentId,
  type ApiError,
} from '@kolonie-ai/core'
import {
  accountOf,
  closeEpisode,
  entriesOf,
  episodeForAgent,
  fillSlot,
  openEpisode,
  openEpisodesFor,
  openSlot,
  passTurn,
  setVaultEntry,
  slotForAgent,
  slotsOf,
  takeSlot,
  threadOf,
  writeEntry,
  openVaultValue,
  sealVaultValue,
  type AccountEpisodeId,
  type AccountSlotId,
  type Database,
  type OpenEpisodeAccount,
} from '@kolonie-ai/db'
import { z } from 'zod'
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

/** Everything this surface needs from the outside world. */
export interface AccountThreadStore {
  /** The account, scoped to its holder in the same statement. */
  account(agentId: AgentId, accountId: string): ReturnType<typeof accountOf>
  thread(accountId: string): ReturnType<typeof threadOf>
  openEpisode(command: Parameters<typeof openEpisode>[1]): ReturnType<typeof openEpisode>
  /** The waking read: open episodes across every account, turn-first. */
  openEpisodes(agentId: AgentId): ReturnType<typeof openEpisodesFor>
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
  /** Where a taken credential lands. The caller's own key seals it. */
  vaultPut(
    vaultToken: string,
    agentId: AgentId,
    key: string,
    value: string,
  ): ReturnType<typeof setVaultEntry>
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
    vaultPut: (vaultToken, agentId, key, value) =>
      setVaultEntry(db, vaultToken, agentId, key, value),
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
  readonly filled: boolean
  readonly filledBy: AccountSlot['filledBy']
  readonly filledAt: string | null
  /** Null on every secret slot, whatever is in it. */
  readonly value: string | null
  readonly taken: boolean
  readonly takenTo: string | null
}

const toView = (slot: AccountSlot): SlotView => ({
  id: String(slot.id),
  label: slot.label,
  secret: slot.secret,
  filled: slot.filledAt !== null,
  filledBy: slot.filledBy,
  filledAt: slot.filledAt,
  value: slot.secret ? null : slot.value,
  taken: slot.takenAt !== null,
  takenTo: slot.takenTo,
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

/** What a slot looks like on the way in. Several may arrive in one `put`. */
const SlotInputSchema = z.object({
  label: z.string().min(1).max(SLOT_LABEL_MAX_LENGTH),
  value: z.string().min(1).max(SLOT_VALUE_MAX_LENGTH),
  /** Absent means it is not a secret, which is the safe default of the two. */
  secret: z.boolean().optional(),
})

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

  if (op === 'open') return await openOne(agentId, command, store)
  if (op === 'read') return await readOne(agentId, command, store)

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
  return await close(found.episode, command, store)
}

async function openOne(
  agentId: AgentId,
  command: ThreadCommand,
  store: AccountThreadStore,
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
  return { outcome: 'ok', response: { op: 'open', episode: opened.episode, account: view } }
}

async function readOne(
  agentId: AgentId,
  command: ThreadCommand,
  store: AccountThreadStore,
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
          'put takes the slots as a list, each with a label and a value, and secret: true for ' +
          'anything that must not come back out in a listing. Several in one call is the point ' +
          'of it — an agent holding three values should not need three round trips.',
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

  const written: SlotView[] = []
  for (const entry of wanted) {
    const secret = entry.secret === true
    const opened = await store.openSlot({ episodeId: episode.id, label: entry.label, secret })

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
     * The seal is computed against the slot's own id, so a value lifted out of
     * one row cannot be opened as another's. That is why the slot is opened
     * first and filled second rather than in one statement.
     */
    const value = secret ? store.seal(agentId, String(opened.slot.id), entry.value) : entry.value
    if (value === undefined) return { outcome: 'rejected', error: UNAVAILABLE }

    const filled = await store.fillSlot({ slotId: opened.slot.id, filledBy: 'agent', value })
    written.push(toView(filled.outcome === 'no-such-slot' ? opened.slot : filled.slot))
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

async function close(
  episode: AccountEpisode,
  command: ThreadCommand,
  store: AccountThreadStore,
): Promise<ThreadOutcome> {
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

  return { outcome: 'ok', response: { op: 'close', episode: closed.episode } }
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

  if (slot.filledAt === null || slot.value === null) {
    return {
      outcome: 'rejected',
      error: {
        code: 'not_found',
        message:
          `Nothing has been put in "${slot.label}" yet, so there is nothing to take. Looking ` +
          'costs nothing and spends nothing — come back when the episode says it is filled.',
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

  const key = VaultKeySchema.safeParse(args.vaultKey ?? undefined)
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
  const stored = await store.vaultPut(vaultToken, agentId, key.data, value)
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
