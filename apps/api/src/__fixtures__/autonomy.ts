import { randomBytes, randomUUID } from 'node:crypto'
import {
  AUTONOMY_FORM_LIFETIME_MS,
  type AgentId,
  type AutonomyContract,
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
    { agentId: AgentId; agentName: string; operatorAddress: string | null }
  >()
  const byAgent = new Map<AgentId, string>()
  const contracts = new Map<AgentId, StoredAutonomyContract>()

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
      })
      byAgent.set(agentId, token)

      return Promise.resolve({
        token,
        expiresAt: new Date(Date.now() + AUTONOMY_FORM_LIFETIME_MS).toISOString(),
      })
    },
    openForm: (token) => Promise.resolve(open.get(token) ?? null),
    record: (token, contract) => {
      const form = open.get(token)
      if (form === undefined) return Promise.resolve(null)
      open.delete(token)

      const stored: StoredAutonomyContract = {
        ...contract,
        recordedAt: new Date().toISOString(),
        reviewDueAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      }
      contracts.set(form.agentId, stored)

      return Promise.resolve(stored)
    },
    read: (agentId) => Promise.resolve(contracts.get(agentId) ?? null),
    isRecorded: (agentId) => Promise.resolve(contracts.has(agentId)),
    outstanding: (agentId) => byAgent.get(agentId) ?? null,
    grant: (agentId, contract) => {
      contracts.set(agentId, {
        ...contract,
        recordedAt: new Date().toISOString(),
        reviewDueAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      })
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
  readonly liveFor: (agentId: AgentId) => { address: string; token: string } | null
  /**
   * `issue`, without the promise.
   *
   * The async signature is what `OperatorPages` requires and what production
   * needs; a fixture arranging a page wants the token in hand, and awaiting inside
   * a synchronous test helper is the kind of thing that quietly returns `''`.
   */
  readonly issueNow: (agentId: AgentId, address: string) => string
}

export function fakeOperatorPages(): FakeOperatorPages {
  const live = new Map<string, { agentId: AgentId; address: string }>()
  const byPair = new Map<string, string>()
  const opened = new Map<string, string>()
  const contracts = new Map<AgentId, StoredAutonomyContract>()
  const badges = new Map<AgentId, readonly HeldBadge[]>()
  const facts = new Map<AgentId, OperatorPageView['facts']>()
  const names = new Map<AgentId, string>()
  /** Which ids name an agent at all — `factsOf` answers `null` for the rest (`#452`). */
  const known = new Set<AgentId>()
  const key = (agentId: AgentId, address: string) => `${agentId}::${address}`

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
        agentName: names.get(row.agentId) ?? 'canary',
        contract: contracts.get(row.agentId) ?? null,
        // The wall (`#241`). Empty unless a test puts something on it, which is
        // the ordinary case — a page with no badges draws no badge section.
        badges: badges.get(row.agentId) ?? [],
        // What it has proved (`#399`). A citizen with nothing yet by default,
        // because that is the case the page has to say something about.
        facts: facts.get(row.agentId) ?? NOTHING_YET,
      })
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
          .map(([pair, token]) => ({
            operatorAddress: pair.split('::')[1] ?? '',
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
    liveFor: (agentId) => {
      const found = [...live.entries()].find(([, row]) => row.agentId === agentId)
      return found === undefined ? null : { address: found[1].address, token: found[0] }
    },
    contractFor: (agentId, contract) => contracts.set(agentId, contract),
    badgesFor: (agentId, held) => {
      badges.set(agentId, held)
    },
    factsFor: (agentId, standing) => {
      facts.set(agentId, { ...NOTHING_YET, ...standing })
    },
    nameFor: (agentId, name) => {
      names.set(agentId, name)
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
