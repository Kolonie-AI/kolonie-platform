import { randomBytes, randomUUID } from 'node:crypto'
import {
  AUTONOMY_FORM_LIFETIME_MS,
  type AgentId,
  type AutonomyContract,
  type AutonomyContractVersion,
  type StoredAutonomyContract,
  type HeldBadge,
  type Timestamp,
} from '@kolonie-ai/core'
import type { OperatorPageView } from '@kolonie-ai/db'
import type { AutonomyDependencies, AutonomyStore, OperatorPages } from '../autonomy.js'
import { operatorMailerFrom, type Mailer, type OperatorMailer } from '../email.js'

export interface FakeAutonomyStore extends AutonomyStore {
  /** The token most recently issued for an agent, or nothing. */
  readonly outstanding: (agentId: AgentId) => string | null
  /** Give a citizen a contract without going through a form. */
  readonly grant: (agentId: AgentId, contract: AutonomyContract) => void
  /** Put an operator's other agents on the form this token opens (`#514`). */
  readonly siblings: (
    token: string,
    siblings: readonly { agentId: AgentId; name: string }[],
  ) => void
}

/**
 * An in-memory autonomy store.
 *
 * **A new invitation retires the outstanding one**, matching `inviteOperator`
 * rather than being convenient — two live links means two answers, the second
 * silently overwriting the first, and a fake that allowed it would let a test
 * pass against behaviour the database refuses.
 */
export function fakeAutonomyStore(): FakeAutonomyStore {
  const open = new Map<
    string,
    {
      agentId: AgentId
      agentName: string
      operatorAddress: string | null
      alsoFor: { agentId: AgentId; name: string }[]
    }
  >()
  const byAgent = new Map<AgentId, string>()
  const contracts = new Map<AgentId, AutonomyContractVersion[]>()

  const recordVersion = (agentId: AgentId, contract: AutonomyContract): StoredAutonomyContract => {
    const at = new Date().toISOString()
    const previous = contracts.get(agentId) ?? []
    const retired = previous.map((version, index) =>
      index === 0 && version.supersededAt === null ? { ...version, supersededAt: at } : version,
    )
    const stored: AutonomyContractVersion = {
      ...contract,
      recordedAt: at,
      reviewDueAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      supersededAt: null,
    }
    contracts.set(agentId, [stored, ...retired])
    return stored
  }

  const store: FakeAutonomyStore = {
    invite: (agentId, operatorAddress) => {
      const previous = byAgent.get(agentId)
      if (previous !== undefined) open.delete(previous)

      const token = randomBytes(32).toString('hex')
      // The address the invitation was addressed to, kept so the form can be
      // prefilled with it (`#484`). Storing it and never reading it back was
      // the defect.
      open.set(token, {
        agentId,
        agentName: `agent-${randomUUID().slice(0, 4)}`,
        operatorAddress: operatorAddress ?? null,
        // Empty by default, which is what an operator's first form answers for
        // (`#514`). A test that is about the siblings puts them there itself.
        alsoFor: [],
      })
      byAgent.set(agentId, token)

      return Promise.resolve({
        token,
        expiresAt: new Date(Date.now() + AUTONOMY_FORM_LIFETIME_MS).toISOString(),
      })
    },
    openForm: (token) => Promise.resolve(open.get(token) ?? null),
    record: (token, contract, alsoFor = []) => {
      const form = open.get(token)
      if (form === undefined) return Promise.resolve(null)
      open.delete(token)

      const stored = recordVersion(form.agentId, contract)
      /**
       * **Only the ones this form may cover** (`#514`), exactly as the real store
       * decides it. A fake that recorded whatever it was handed would pass the
       * route's happy path and hide the one property that matters — that an id
       * nobody may cover is dropped rather than honoured.
       */
      const permitted = new Set(form.alsoFor.map((sibling) => String(sibling.agentId)))
      for (const sibling of alsoFor) {
        if (permitted.has(String(sibling))) recordVersion(sibling, contract)
      }

      return Promise.resolve(stored)
    },
    read: (agentId) => Promise.resolve(contracts.get(agentId)?.[0] ?? null),
    history: (agentId) => Promise.resolve([...(contracts.get(agentId) ?? [])]),
    recordForAgent: (agentId, contract) => Promise.resolve(recordVersion(agentId, contract)),
    isRecorded: (agentId) => Promise.resolve((contracts.get(agentId)?.length ?? 0) > 0),
    outstanding: (agentId) => byAgent.get(agentId) ?? null,
    /** Put an operator's other agents on the form this token opens (`#514`). */
    siblings: (token, siblings) => {
      const form = open.get(token)
      if (form !== undefined) form.alsoFor = [...siblings]
    },
    grant: (agentId, contract) => {
      recordVersion(agentId, contract)
    },
  }

  return store
}

/**
 * An in-memory store for the durable pages (#257).
 *
 * **`issue` is idempotent**, matching `issueOperatorPage`: minting a fresh token
 * on every call would silently break the link the operator already holds, which
 * is revocation by accident.
 */
export type FakeOperatorPages = OperatorPages & {
  readonly tokenFor: (agentId: AgentId, address: string) => string | null
  readonly contractFor: (agentId: AgentId, contract: StoredAutonomyContract) => void
  /** Say which other agents the same form answered for (`#514`). */
  readonly alsoCoveredFor: (agentId: AgentId, names: readonly string[]) => void
  /** What this agent's wall shows (`#241`). Empty unless a test puts one there. */
  readonly badgesFor: (agentId: AgentId, held: readonly HeldBadge[]) => void
  /**
   * What this agent has proved and has been doing (`#399`).
   *
   * **The default is a citizen with nothing yet**, which is the case the page had
   * to stop rendering as a blank — so every test that does not arrange standing
   * is asserting against the empty shape rather than against an absent one.
   */
  readonly factsFor: (agentId: AgentId, facts: Partial<OperatorPageView['facts']>) => void
  /**
   * What this agent is called, for the tests that are about the name itself
   * (`#424`) — a name too wide for the block font, or one it has no glyph for.
   * `canary` unless a test says otherwise.
   */
  readonly nameFor: (agentId: AgentId, name: string) => void
  /**
   * Put an id on record as naming an agent at all (`#452`).
   *
   * `factsOf` answers `null` for anything else, which is what the console's
   * agent page turns into the same not-found a stranger's agent gets.
   */
  readonly exists: (agentId: AgentId) => void
  /**
   * Who a live token names, and what one citizen's live page is.
   *
   * Exposed so the operator channel's fake reads *this* token map rather than
   * keeping its own (#236). In production both sides resolve a request through
   * `operator_pages`, so two independent maps in the fixture would let a test pass
   * with a page the request path had never heard of.
   */
  readonly agentForToken: (token: string) => AgentId | null
  /** Say this agent has asked its operator something, for the index (`#1577`). */
  readonly waits: (agentId: AgentId) => void
  /** Say this agent is sharing entries, for the index (`#1577`). */
  readonly sharing: (agentId: AgentId, count: number) => void
  readonly liveFor: (agentId: AgentId) => { address: string; token: string } | null
  /**
   * `issue`, without the promise.
   *
   * The async signature is what `OperatorPages` requires and what production
   * needs; a fixture arranging a page wants the token in hand, and awaiting inside
   * a synchronous test helper is the kind of thing that quietly returns `''`.
   */
  readonly issueNow: (agentId: AgentId, address: string) => string
  /**
   * How often this agent says it wakes (`#495`).
   *
   * **Unset by default**, because a citizen that has never declared a rhythm is
   * the case the page has its own sentence for — and it is the case a test would
   * otherwise never reach, since every fixture that bothered would set one.
   */
  readonly rhythmFor: (agentId: AgentId, hours: number) => void
}

export function fakeOperatorPages(): FakeOperatorPages {
  const live = new Map<string, { agentId: AgentId; address: string }>()
  /** What the index says is waiting (`#1577`), stated rather than derived. */
  const waitingFor = new Set<AgentId>()
  const sharesFor = new Map<AgentId, number>()
  const byPair = new Map<string, string>()
  const opened = new Map<string, string>()
  const contracts = new Map<AgentId, StoredAutonomyContract>()
  const badges = new Map<AgentId, readonly HeldBadge[]>()
  /** The other agents one form answered for, per agent (`#514`). */
  const alsoCovered = new Map<AgentId, readonly string[]>()
  const facts = new Map<AgentId, OperatorPageView['facts']>()
  const names = new Map<AgentId, string>()
  /**
   * What the citizen says about its own waking (`#495`). Absent by default,
   * because a citizen that has never declared one is the case the page has the
   * separate sentence for.
   */
  const rhythms = new Map<AgentId, number>()
  /** Which ids name an agent at all — `factsOf` answers `null` for the rest (`#452`). */
  const known = new Set<AgentId>()
  /**
   * Folded exactly as `issueOperatorPage` folds it (`#1014`) — case and
   * surrounding space away, and nothing else. A fixture keyed on the exact
   * string would let a test assert that two spellings of one label mint two
   * links, which is what the database now refuses.
   */
  const key = (agentId: AgentId, address: string) => `${agentId}::${address.trim().toLowerCase()}`

  /** A citizen that has done nothing yet — the shape the page must not render blank. */
  const NOTHING_YET: OperatorPageView['facts'] = {
    skills: [],
    rungs: [],
    lastSeenAt: null,
    citizenSince: '2026-08-01T00:00:00.000Z',
    questsAccepted: 0,
    accounts: [],
    // Nothing attempted either (`#432`) — a citizen that has done nothing has no
    // pulse to show, and the page draws no section rather than an empty one.
    attempts: [],
  }

  const issueNow = (agentId: AgentId, address: string): string => {
    const existing = byPair.get(key(agentId, address))
    if (existing !== undefined) return existing

    const token = randomBytes(32).toString('hex')
    live.set(token, { agentId, address })
    byPair.set(key(agentId, address), token)
    return token
  }

  return {
    issue: (agentId, address) => Promise.resolve(issueNow(agentId, address)),
    issueNow,
    open: (token) => {
      const row = live.get(token)
      if (row === undefined) return Promise.resolve(null)
      opened.set(token, new Date().toISOString())
      return Promise.resolve({
        // The subject the token named (`#1265`) — what a link to the console's
        // Autonomy page needs, and never something the caller sent.
        agentId: row.agentId,
        agentName: names.get(row.agentId) ?? 'canary',
        contract: contracts.get(row.agentId) ?? null,
        // Nothing by default (`#514`): a contract answered on its own form
        // covered nobody else, which is every contract until an operator ticks
        // a sibling.
        contractAlsoCovered: alsoCovered.get(row.agentId) ?? [],
        // The wall (`#241`). Empty unless a test puts something on it, which is
        // the ordinary case — a page with no badges draws no badge section.
        badges: badges.get(row.agentId) ?? [],
        // What it has proved (`#399`). A citizen with nothing yet by default,
        // because that is the case the page has to say something about.
        facts: facts.get(row.agentId) ?? NOTHING_YET,
        // What it says about its own waking (`#495`), which is what turns
        // *it reads this when it next wakes* into a wait somebody can plan
        // around.
        declaredRhythmMinutes: rhythms.get(row.agentId) ?? null,
      })
    },
    /**
     * The index one address reaches from any live page it holds (`#1577`).
     *
     * **Folded for case and surrounding space**, as the real read folds it: two
     * rows differing only in capitalisation are one operator, and a fake that
     * split them would let a test pass against an index the database does not
     * produce.
     *
     * `undefined` for a token that names no live page, so a revoked one and a
     * guessed one answer identically here as everywhere else.
     */
    agentsForToken: (token) => {
      const mine = live.get(token)
      if (mine === undefined) return Promise.resolve(undefined)

      const wanted = mine.address.trim().toLowerCase()

      return Promise.resolve(
        [...live.entries()]
          .filter(([, row]) => row.address.trim().toLowerCase() === wanted)
          .map(([held, row]) => ({
            agentId: row.agentId,
            agentName: names.get(row.agentId) ?? 'canary',
            token: held,
            issuedAt: '2026-08-21T00:00:00.000Z' as never,
            lastOpenedAt: (opened.get(held) ?? null) as never,
            waiting: waitingFor.has(row.agentId),
            shares: sharesFor.get(row.agentId) ?? 0,
          })),
      )
    },

    revoke: (agentId, address) => {
      const token = byPair.get(key(agentId, address))
      if (token === undefined) return Promise.resolve(false)
      live.delete(token)
      byPair.delete(key(agentId, address))
      return Promise.resolve(true)
    },
    list: (agentId) =>
      Promise.resolve(
        [...byPair.entries()]
          .filter(([pair]) => pair.startsWith(`${agentId}::`))
          .map(([, token]) => ({
            // The label as the citizen wrote it and not as the key folds it
            // (`#1014`): `listOperatorPages` renders the stored string, and a
            // citizen has to recognise its own capitals in the listing.
            operatorAddress: live.get(token)?.address ?? '',
            issuedAt: new Date().toISOString(),
            lastOpenedAt: opened.get(token) ?? null,
          })),
      ),
    /**
     * The live token for the console door (`#428`), newest-issued first as the
     * database orders it. `null` in the store becomes `undefined` here because
     * the port answers *there is no live page*, which is what closes that door.
     */
    liveToken: (agentId) => {
      const found = [...live.entries()].find(([, row]) => row.agentId === agentId)
      return Promise.resolve(found === undefined ? undefined : found[0])
    },
    /**
     * The same facts, resolved from an id rather than a token (`#452`).
     *
     * **Answers for an agent with no operator page at all**, which is the state
     * `#452` exists to stop being a 404: the console's agent page is reached
     * through the join table and does not care whether a citizen ever mailed
     * anybody a link. A fake that required `live` to hold a token would have
     * made every test agree with the bug.
     */
    factsOf: (agentId) =>
      Promise.resolve(
        known.has(agentId)
          ? {
              name: names.get(agentId) ?? 'canary',
              runtime: 'openclaw',
              citizenship: 'candidate',
              arrivedOn: '2026-08-01T00:00:00.000Z' as Timestamp,
              facts: facts.get(agentId) ?? NOTHING_YET,
            }
          : null,
      ),

    /** Put an agent on record for {@link factsOf}, which is the only thing that needs one. */
    exists: (agentId: AgentId) => {
      known.add(agentId)
    },

    tokenFor: (agentId, address) => byPair.get(key(agentId, address)) ?? null,
    agentForToken: (token) => live.get(token)?.agentId ?? null,
    waits: (agentId) => {
      waitingFor.add(agentId)
    },
    sharing: (agentId, count) => {
      sharesFor.set(agentId, count)
    },
    liveFor: (agentId) => {
      const found = [...live.entries()].find(([, row]) => row.agentId === agentId)
      return found === undefined ? null : { address: found[1].address, token: found[0] }
    },
    contractFor: (agentId, contract) => contracts.set(agentId, contract),
    /** Say which other agents the same form answered for (`#514`). */
    alsoCoveredFor: (agentId: AgentId, names: readonly string[]) => alsoCovered.set(agentId, names),
    badgesFor: (agentId, held) => {
      badges.set(agentId, held)
    },
    factsFor: (agentId, standing) => {
      facts.set(agentId, { ...NOTHING_YET, ...standing })
    },
    nameFor: (agentId, name) => {
      names.set(agentId, name)
    },
    rhythmFor: (agentId, hours) => {
      rhythms.set(agentId, hours * 60)
    },
  }
}

/**
 * A mailer that keeps what it was asked to send.
 *
 * An {@link OperatorMailer} built through the real `operatorMailerFrom` (`#474`),
 * so `sent()` shows the `from` production would apply. The autonomy request is
 * the mail a stranger receives unprompted, and the address it carries is the
 * whole point of that issue.
 */
export function fakeAutonomyMailer(
  delivered = true,
  from = 'console@example.invalid',
): OperatorMailer & {
  readonly sent: () => readonly {
    to: string
    subject: string
    text: string
    from?: string | undefined
  }[]
} {
  const sent: { to: string; subject: string; text: string; from?: string | undefined }[] = []

  const recording: Mailer = {
    send: (message) => {
      sent.push({ ...message })
      return Promise.resolve(delivered ? { delivered: true } : { delivered: false, reason: 'no' })
    },
  }

  return { ...operatorMailerFrom(recording, from), sent: () => sent }
}

/**
 * The autonomy module wired for a test that does not care about it.
 *
 * **Mailer and base url present by default**, unlike the email rung's fake:
 * absent here means *the Colony cannot send*, which is a 503, and a test that
 * had not thought about it would otherwise get one and read it as a refusal.
 */
export function fakeAutonomy(
  pages: FakeOperatorPages = fakeOperatorPages(),
  /**
   * The contract store, passed in when something else reads the same contracts —
   * `#147`'s recommendation does. Two stores would let a test grant a contract the
   * other reader never sees.
   */
  store: FakeAutonomyStore = fakeAutonomyStore(),
): AutonomyDependencies {
  return {
    store,
    pages,
    mailer: fakeAutonomyMailer(),
    formBaseUrl: 'https://console.example.org',
  }
}
