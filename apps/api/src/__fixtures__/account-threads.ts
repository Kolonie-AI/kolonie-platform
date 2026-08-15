import { randomUUID } from 'node:crypto'
import {
  AccountEntryIdSchema,
  AccountEpisodeIdSchema,
  AccountSlotIdSchema,
  AccountThreadIdSchema,
  SLOT_LIFETIME_DAYS,
  SLOT_MAX_READS,
  VAULT_MAX_ENTRIES,
  episodeVerdict,
  now as currentTime,
  outcomeNeedsWall,
  type AccountEntry,
  type AccountEpisode,
  type AccountKind,
  type AccountSlot,
  type AccountThread,
  type AgentId,
  type EpisodeVerdict,
} from '@kolonie-ai/core'
import type { AccountThreadStore } from '../account-threads.js'

/**
 * The account conversation, in memory (`#930`).
 *
 * **It reproduces the rules the surface leans on and none of the cryptography.**
 * Whether a sealed slot actually opens is asserted in `packages/db` against the
 * real primitive; sealing here is a prefix, so a test that asserts *the value
 * never comes out in a listing* is asserting the surface rather than agreeing
 * with a second implementation of AES.
 *
 * What `apps/api` is on the hook for is what this exercises: which operations
 * exist, what each refusal says, that a secret is absent from every read, and
 * that a second take is refused **without disturbing the vault entry the first
 * one wrote** — which is why {@link FakeAccountThreads.vaultContents} exists.
 */
export interface FakeAccountThreads extends AccountThreadStore {
  /** Put an account on a citizen's record, with the thread its trigger would make. */
  readonly addAccount: (account: {
    readonly agentId: AgentId
    readonly kind?: string
    readonly identifier?: string
    readonly provider?: string | null
  }) => { readonly id: string }
  /** Everything the vault holds, as `(agentId, key)` → value. For assertions only. */
  readonly vaultContents: () => ReadonlyMap<string, string>
  /** Say who operates a citizen, which is what `human_agents` answers in production. */
  readonly addOperator: (agentId: AgentId, humanId: string) => void
  /** Move a slot's timer into the past, so the expiry branch is reachable in a test. */
  readonly expire: (slotId: string) => void
}

/** What a fake seal looks like, so a test can tell a sealed value from a bare one. */
const SEALED = 'sealed:'

export function fakeAccountThreads(
  options: { readonly carriesSecrets?: boolean } = {},
): FakeAccountThreads {
  const carriesSecrets = options.carriesSecrets ?? true

  const accounts = new Map<
    string,
    {
      readonly agentId: AgentId
      readonly kind: string
      readonly identifier: string
      readonly provider: string | null
    }
  >()
  const threads = new Map<string, AccountThread>()
  const episodes = new Map<string, AccountEpisode>()
  const slots = new Map<string, AccountSlot>()
  const entries: AccountEntry[] = []
  const vault = new Map<string, string>()
  /** `human_agents`, in one line: which person operates which citizen. */
  const operators = new Map<string, string>()

  const expired = (slot: AccountSlot): boolean =>
    slot.expiresAt !== null && Date.parse(slot.expiresAt) <= Date.now()

  const accountOfThread = (threadId: string) => {
    const thread = [...threads.values()].find((row) => String(row.id) === threadId)
    if (thread === undefined) return undefined
    const account = accounts.get(thread.accountId)
    return account === undefined ? undefined : { id: thread.accountId, ...account }
  }

  const view = (episode: AccountEpisode) => {
    const account = accountOfThread(String(episode.threadId))
    if (account === undefined) return undefined
    return {
      episode,
      account: {
        id: account.id,
        kind: account.kind,
        identifier: account.identifier,
        provider: account.provider,
      },
    }
  }

  const holderOfSlot = (slot: AccountSlot): AgentId | undefined => {
    const episode = episodes.get(String(slot.episodeId))
    if (episode === undefined) return undefined
    return accountOfThread(String(episode.threadId))?.agentId
  }

  const accountOfSlot = (slot: AccountSlot) => {
    const episode = episodes.get(String(slot.episodeId))
    if (episode === undefined) return undefined
    const account = accountOfThread(String(episode.threadId))
    if (account === undefined) return undefined
    return {
      id: account.id,
      kind: account.kind,
      identifier: account.identifier,
      provider: account.provider,
    }
  }

  /** The turn-first ordering the waking read promises, kept here so tests can assert it. */
  const byTurn = (turn: AccountEpisode['turn']) =>
    turn === 'agent' ? 0 : turn === 'operator' ? 1 : 2

  return {
    addAccount(account) {
      const id = randomUUID()
      accounts.set(id, {
        agentId: account.agentId,
        kind: account.kind ?? 'mailbox',
        identifier: account.identifier ?? 'held@example.test',
        provider: account.provider ?? null,
      })
      // A trigger makes the thread with the account in production, so there is
      // no way here either to have an account without one.
      const threadId = AccountThreadIdSchema.parse(randomUUID())
      threads.set(String(threadId), { id: threadId, accountId: id, createdAt: currentTime() })
      return { id }
    },

    vaultContents: () => new Map(vault),

    addOperator(agentId, humanId) {
      operators.set(String(agentId), humanId)
    },

    expire(slotId) {
      const held = slots.get(slotId)
      if (held === undefined) return
      slots.set(slotId, { ...held, expiresAt: new Date(Date.now() - 1000).toISOString() })
    },

    async account(agentId, accountId) {
      const held = accounts.get(accountId)
      if (held === undefined || held.agentId !== agentId) return undefined
      // Only the four fields the surface reads carry anything; the rest of an
      // `Account` is not what `#930` is about.
      return {
        id: accountId,
        kind: held.kind as AccountKind,
        identifier: held.identifier,
        provider: held.provider,
        proved: true,
        capabilities: [],
        status: 'in-use',
        preferred: false,
        forWork: true,
        attestable: false,
        shownOnProfile: false,
        note: null,
        vaultKey: null,
        provenance: 'self-acquired',
        obtainedThroughTaskId: null,
        provedBy: null,
        provedAt: null,
        confirmedAt: null,
        unconfirmedSince: null,
        createdAt: currentTime(),
      }
    },

    async thread(accountId) {
      return [...threads.values()].find((row) => row.accountId === accountId)
    },

    async openEpisode(command) {
      if (command.kind === 'acquisition') {
        const existing = [...episodes.values()].find(
          (row) => row.threadId === command.threadId && row.kind === 'acquisition',
        )
        if (existing !== undefined) {
          return { outcome: 'acquisition-already-happened', episode: existing }
        }
      }

      const episode: AccountEpisode = {
        id: AccountEpisodeIdSchema.parse(randomUUID()),
        threadId: command.threadId,
        openedBy: command.openedBy,
        kind: command.kind,
        turn: command.turn ?? 'nobody',
        title: command.title,
        outcome: null,
        wall: null,
        openedAt: currentTime(),
        closedAt: null,
        proposedAt: null,
      }
      episodes.set(String(episode.id), episode)
      return { outcome: 'opened', episode }
    },

    async openEpisodes(agentId) {
      return [...episodes.values()]
        .filter((episode) => episode.outcome === null)
        .map(view)
        .filter((row): row is NonNullable<typeof row> => row !== undefined)
        .filter((row) => accounts.get(row.account.id)?.agentId === agentId)
        .sort((left, right) => byTurn(left.episode.turn) - byTurn(right.episode.turn))
    },

    async episode(agentId, episodeId) {
      const episode = episodes.get(String(episodeId))
      if (episode === undefined) return undefined
      const found = view(episode)
      if (found === undefined) return undefined
      return accounts.get(found.account.id)?.agentId === agentId ? found : undefined
    },

    async slots(episodeId) {
      return (
        [...slots.values()]
          .filter((slot) => String(slot.episodeId) === String(episodeId))
          .sort((left, right) => left.label.localeCompare(right.label))
          // The storage read strips a secret's value, and so does this one: a
          // listing that carried it would make the fake weaker than the thing it
          // stands in for, which is the one way a fixture can hide a defect.
          .map((slot) => (slot.secret ? { ...slot, value: null } : slot))
      )
    },

    async slot(agentId, slotId) {
      const held = slots.get(String(slotId))
      if (held === undefined) return undefined
      return holderOfSlot(held) === agentId ? held : undefined
    },

    async openSlot(command) {
      const existing = [...slots.values()].find(
        (slot) =>
          String(slot.episodeId) === String(command.episodeId) && slot.label === command.label,
      )
      if (existing !== undefined) return { outcome: 'already-open', slot: existing }

      const slot: AccountSlot = {
        id: AccountSlotIdSchema.parse(randomUUID()),
        episodeId: command.episodeId,
        label: command.label,
        secret: command.secret,
        awaits: command.awaits ?? 'agent',
        vaultKey: command.vaultKey ?? null,
        filledBy: null,
        filledAt: null,
        value: null,
        takenAt: null,
        takenTo: null,
        // A biconditional in the schema: a secret has a timer and nothing else
        // does. The fake keeps it so a test cannot construct a row the database
        // would refuse.
        expiresAt: command.secret
          ? new Date(Date.now() + SLOT_LIFETIME_DAYS * 24 * 60 * 60 * 1000).toISOString()
          : null,
        reads: 0,
        destroyedAt: null,
      }
      slots.set(String(slot.id), slot)
      return { outcome: 'opened', slot }
    },

    async fillSlot(command) {
      const held = slots.get(String(command.slotId))
      if (held === undefined) return { outcome: 'no-such-slot' }
      if (held.filledBy !== null) return { outcome: 'already-filled', slot: held }
      // The predicate the real update carries: one side is owed this slot, and
      // it is not the one writing.
      if (held.awaits !== command.filledBy) return { outcome: 'not-awaited', slot: held }

      const filled: AccountSlot = {
        ...held,
        filledBy: command.filledBy,
        filledAt: currentTime(),
        value: command.value,
      }
      slots.set(String(filled.id), filled)
      return { outcome: 'filled', slot: filled }
    },

    async takeSlot(command) {
      const held = slots.get(String(command.slotId))
      if (held === undefined) return { outcome: 'no-such-slot' }
      if (held.takenAt !== null) return { outcome: 'already-taken', slot: held }
      if (held.destroyedAt !== null || expired(held)) return { outcome: 'closed', slot: held }
      if (held.filledAt === null || !held.secret) return { outcome: 'not-filled', slot: held }

      const taken: AccountSlot = { ...held, takenAt: currentTime(), takenTo: command.to }
      slots.set(String(taken.id), taken)
      return { outcome: 'taken', slot: taken }
    },

    async entries(episodeId) {
      return entries.filter((entry) => String(entry.episodeId) === String(episodeId))
    },

    async writeEntry(command) {
      const entry: AccountEntry = {
        id: AccountEntryIdSchema.parse(randomUUID()),
        episodeId: command.episodeId,
        author: command.author,
        body: command.body,
        createdAt: currentTime(),
      }
      entries.push(entry)
      return entry
    },

    async passTurn(episodeId, to) {
      const episode = episodes.get(String(episodeId))
      if (episode === undefined) return { outcome: 'no-such-episode' }
      if (episode.outcome !== null) return { outcome: 'already-closed', episode }

      const passed: AccountEpisode = { ...episode, turn: to }
      episodes.set(String(passed.id), passed)
      return { outcome: 'passed', episode: passed }
    },

    async closeEpisode(episodeId, command) {
      const wall = command.wall?.trim()
      if (outcomeNeedsWall(command.outcome) && (wall === undefined || wall.length === 0)) {
        return { outcome: 'wall-required' }
      }

      const episode = episodes.get(String(episodeId))
      if (episode === undefined) return { outcome: 'no-such-episode' }
      if (episode.outcome !== null) {
        return episode.outcome === command.outcome
          ? { outcome: 'already-closed', episode }
          : { outcome: 'closed-differently', episode }
      }

      const closed: AccountEpisode = {
        ...episode,
        outcome: command.outcome,
        wall: command.outcome === 'failed' ? (wall ?? null) : null,
        // The trigger writes both in production, so they cannot come apart here
        // either: a closed episode rests.
        turn: 'nobody',
        closedAt: currentTime(),
      }
      episodes.set(String(closed.id), closed)

      // Closing destroys what is still in the secret slots, in the same act, as
      // the storage does: a secret outliving the conversation it belonged to is
      // one nobody is watching any more.
      for (const slot of slots.values()) {
        if (String(slot.episodeId) !== String(closed.id)) continue
        if (!slot.secret || slot.destroyedAt !== null) continue
        slots.set(String(slot.id), { ...slot, value: null, destroyedAt: currentTime() })
      }

      /**
       * Closing an acquisition proposes the Atlas draft (`#935`), and the
       * surface renders which of the three it was. The fake holds no catalogue,
       * so nothing here can be published over — what it reproduces is the rule
       * the surface leans on either way: an account naming no provider proposes
       * nothing, because there is no shelf to put a draft on.
       */
      const account = accountOfThread(String(closed.threadId))
      const proposed: EpisodeVerdict =
        account === undefined || account.provider === null
          ? { kind: 'nothing', why: 'the account names no provider' }
          : episodeVerdict(
              closed,
              [...slots.values()].filter((slot) => String(slot.episodeId) === String(closed.id)),
              undefined,
            )

      return { outcome: 'closed', episode: closed, proposed }
    },

    async vaultClaim(_vaultToken, agentId, key, value) {
      const at = `${String(agentId)}\0${key}`
      const held = [...vault.keys()].filter((composite) =>
        composite.startsWith(`${String(agentId)}\0`),
      )
      if (held.length >= VAULT_MAX_ENTRIES) {
        return { outcome: 'full', maxEntries: VAULT_MAX_ENTRIES }
      }
      // Refused rather than replaced, exactly as the real claim is: it is the
      // rejection case `#931` names, and a fixture that overwrote here would let
      // the test pass while the surface destroyed a credential.
      if (vault.has(at)) return { outcome: 'key-taken' }

      vault.set(at, value)
      const stamp = currentTime()
      return {
        outcome: 'stored',
        entry: { key, description: null, createdAt: stamp, updatedAt: stamp },
      }
    },

    async vaultHolds(agentId, key) {
      return vault.has(`${String(agentId)}\0${key}`)
    },

    async fillAsOperator(command) {
      if (!carriesSecrets) return { outcome: 'closed' }

      const held = slots.get(String(command.slotId))
      if (held === undefined) return { outcome: 'closed' }
      const holder = holderOfSlot(held)
      if (holder === undefined || operators.get(String(holder)) !== command.humanId) {
        return { outcome: 'closed' }
      }
      if (held.awaits !== 'operator' || held.filledBy !== null) return { outcome: 'closed' }
      if (held.destroyedAt !== null || expired(held)) return { outcome: 'closed' }

      // Sealed here and not by the caller, because the port takes plaintext on
      // both sides: a fixture that stored what it was handed would let a route
      // that forgot to seal pass a test the real store would refuse.
      slots.set(String(held.id), {
        ...held,
        filledBy: 'operator',
        filledAt: currentTime(),
        value: `${SEALED}${String(holder)}:${String(held.id)}:${command.value}`,
      })
      return { outcome: 'filled' }
    },

    async readAsOperator(slotId, humanId) {
      if (!carriesSecrets) return { outcome: 'closed' }

      const held = slots.get(String(slotId))
      if (held === undefined) return { outcome: 'closed' }
      const holder = holderOfSlot(held)
      if (holder === undefined || operators.get(String(holder)) !== humanId) {
        return { outcome: 'closed' }
      }
      if (!held.secret || held.awaits !== 'agent' || held.value === null) {
        return { outcome: 'closed' }
      }
      if (held.destroyedAt !== null || expired(held) || held.reads >= SLOT_MAX_READS) {
        return { outcome: 'closed' }
      }

      const account = accountOfSlot(held)
      if (account === undefined) return { outcome: 'closed' }

      const prefix = `${SEALED}${String(holder)}:${String(held.id)}:`
      if (!held.value.startsWith(prefix)) return { outcome: 'closed' }

      // The count moves whether or not the envelope opened, which is the order
      // the storage documents: a read that failed late is still a read spent.
      const reads = held.reads + 1
      const last = reads >= SLOT_MAX_READS
      slots.set(String(held.id), {
        ...held,
        reads,
        ...(last ? { value: null, destroyedAt: currentTime() } : {}),
      })

      return {
        outcome: 'read',
        label: held.label,
        value: held.value.slice(prefix.length),
        readsLeft: Math.max(SLOT_MAX_READS - reads, 0),
        provider: account.provider,
      }
    },

    async waitingFor(humanId) {
      return [...slots.values()]
        .filter((slot) => operators.get(String(holderOfSlot(slot))) === humanId)
        .filter((slot) => slot.secret && slot.destroyedAt === null && !expired(slot))
        .filter((slot) => slot.reads < SLOT_MAX_READS)
        .filter((slot) => slot.awaits === 'operator' || slot.value !== null)
        .flatMap((slot) => {
          const episode = episodes.get(String(slot.episodeId))
          const account = accountOfSlot(slot)
          const holder = holderOfSlot(slot)
          if (episode === undefined || account === undefined || slot.expiresAt === null) return []
          if (holder === undefined) return []
          return [
            {
              id: String(slot.id),
              label: slot.label,
              awaits: slot.awaits,
              agentId: String(holder),
              filled: slot.value !== null,
              readsLeft: Math.max(SLOT_MAX_READS - slot.reads, 0),
              expiresAt: slot.expiresAt,
              episodeId: String(episode.id),
              episodeTitle: episode.title,
              account,
            },
          ]
        })
    },

    carriesSecrets,

    seal: (agentId, slotId, value) =>
      carriesSecrets ? `${SEALED}${String(agentId)}:${slotId}:${value}` : undefined,

    open: (agentId, slotId, sealed) => {
      if (!carriesSecrets) return undefined
      const prefix = `${SEALED}${String(agentId)}:${slotId}:`
      // Null for an envelope this scope cannot open, exactly as the real one
      // answers — which is what makes the `internal` refusal reachable.
      return sealed.startsWith(prefix) ? sealed.slice(prefix.length) : null
    },
  }
}
