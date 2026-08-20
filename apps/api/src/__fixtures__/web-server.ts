import { randomUUID } from 'node:crypto'
import {
  WEB_SERVER_CHALLENGE_LIFETIME_MS,
  WEB_SERVER_PATH_PREFIX,
  WEB_SERVER_PROBE_WINDOW_MS,
  WEB_SERVER_SEPARATION_MS,
  type AgentId,
  type AutonomyCapability,
  type AutonomyContract,
  type TaskId,
  type WebServerChallenge,
} from '@kolonie-ai/core'
import {
  WEB_SERVER_CAPABILITY,
  type WebServerChallengeStore,
  type WebServerDependencies,
} from '../web-server.js'
import { noObstruction } from './obstruction.js'

export interface FakeWebServerChallenges extends WebServerChallengeStore {
  /** Say an operator has come back about this rung, without running the channel. */
  readonly operatorAnswers: (agentId: AgentId) => void
  /**
   * Say a request about this rung really was opened (`#567`).
   *
   * **Shelving used to do this, and that was the fake asserting something
   * production does not do.** `operatorAsked` is `operatorAskedAbout` — an open
   * request row for this task — and the task is shelved whether or not the ask
   * succeeded. So a failed ask left the real Colony with `operatorAsked` false
   * and this fixture with it true, which is precisely the divergence that let
   * `#567` ship: every test agreed the citizen was waiting on a question nobody
   * had been sent.
   */
  readonly operatorAsks: (agentId: AgentId) => void
  /**
   * Record the contract the rung reads (`#660`).
   *
   * Takes the two fields `capabilityDecision` consults and nothing else, so a
   * test states the case it is about — *granted*, *silent and asks*, *silent and
   * refrains* — rather than assembling a whole contract around it.
   */
  readonly contractRecorded: (
    agentId: AgentId,
    contract: Pick<AutonomyContract, 'capabilities' | 'defaultRule'> | null,
  ) => void
  /** What the contract now grants, so a test can see the answer was written back. */
  readonly capabilitiesOf: (agentId: AgentId) => readonly AutonomyCapability[] | undefined
  /** Answer the probe the citizen currently holds, as a passing verdict would. */
  readonly serveCurrentProbe: (agentId: AgentId) => void
  /** Move the clock past the separation, so the second probe is disclosed. */
  readonly separationElapses: (agentId: AgentId) => void
  readonly shelved: (agentId: AgentId) => boolean
  readonly asks: () => number
}

interface Row {
  readonly id: string
  readonly origin: string
  readonly firstPath: string
  readonly firstNonce: string
  firstServedAt: number | null
  readonly secondPath: string
  readonly secondNonce: string
  secondServedAt: number | null
  readonly expiresAt: number
}

/**
 * The `web-server` rung's storage, in memory (#244).
 *
 * **The disclosure rule is reimplemented here, and that is the one thing this
 * fixture must get exactly right** — a fake that handed out the second path early
 * would let every test pass against the behaviour the rung exists to prevent. It
 * is a short function in both places for that reason.
 */
export function fakeWebServerChallenges(
  /**
   * The rung's task id, when a test needs the operator-request store to know the
   * same one (`#567`). Random otherwise, as it was.
   */
  ownTaskId?: TaskId,
): FakeWebServerChallenges {
  const rows = new Map<AgentId, Row>()
  const answered = new Set<AgentId>()
  const asked = new Set<AgentId>()
  const shelvedFor = new Set<AgentId>()
  const contracts = new Map<AgentId, Pick<AutonomyContract, 'capabilities' | 'defaultRule'>>()
  const taskId = ownTaskId ?? (randomUUID() as TaskId)
  let askCount = 0

  const nonce = () => randomUUID().replace(/-/g, '')

  const render = (id: string, row: Row): WebServerChallenge => {
    const now = Date.now()
    const expired = row.expiresAt <= now

    const probe =
      expired || row.secondServedAt !== null
        ? null
        : row.firstServedAt === null
          ? {
              which: 'first' as const,
              path: row.firstPath,
              nonce: row.firstNonce,
              answerBy: new Date(now + WEB_SERVER_PROBE_WINDOW_MS).toISOString(),
            }
          : now < row.firstServedAt + WEB_SERVER_SEPARATION_MS
            ? null
            : {
                which: 'second' as const,
                path: row.secondPath,
                nonce: row.secondNonce,
                answerBy: new Date(now + WEB_SERVER_PROBE_WINDOW_MS).toISOString(),
              }

    return {
      challengeId: id,
      origin: row.origin,
      expiresAt: new Date(row.expiresAt).toISOString(),
      firstServed: row.firstServedAt !== null,
      probe,
      secondOpensAt:
        row.firstServedAt === null
          ? null
          : new Date(row.firstServedAt + WEB_SERVER_SEPARATION_MS).toISOString(),
    }
  }

  return {
    // @mirrors packages/db/src/storage/web-server.ts mintWebServerChallenge 5ecbef93
    mint: async (input) => {
      const existing = rows.get(input.agentId)
      // `replace` abandons it and starts over, clock and all (`#717`). Faked
      // with the rule it fakes rather than with a simpler one, because a fixture
      // that keeps the old behaviour goes on passing while production changes.
      if (existing !== undefined && existing.secondServedAt === null && input.replace !== true) {
        return { outcome: 'already-open', challenge: render(existing.id, existing) }
      }

      const row: Row = {
        id: randomUUID(),
        origin: input.origin,
        firstPath: `${WEB_SERVER_PATH_PREFIX}${nonce().slice(0, 32)}`,
        firstNonce: nonce(),
        firstServedAt: null,
        secondPath: `${WEB_SERVER_PATH_PREFIX}${nonce().slice(0, 32)}`,
        secondNonce: nonce(),
        secondServedAt: null,
        expiresAt: Date.now() + WEB_SERVER_CHALLENGE_LIFETIME_MS,
      }
      rows.set(input.agentId, row)

      return { outcome: 'minted', challenge: render(row.id, row) }
    },

    open: async (agentId) => {
      const row = rows.get(agentId)
      if (row === undefined || row.secondServedAt !== null) return undefined
      return render(row.id, row)
    },

    operatorAnswered: async (agentId) => answered.has(agentId),

    operatorAsked: async (agentId) => asked.has(agentId),

    contract: async (agentId) => contracts.get(agentId) ?? null,

    /**
     * Adds the capability to the contract, and says whether there was one
     * (`#660`) — the same two outcomes the storage has, because a rung that
     * proceeded on a grant nothing recorded is the case the fake has to be able
     * to show.
     */
    grantCapability: async (agentId) => {
      const held = contracts.get(agentId)
      if (held === undefined) return false
      const capabilities = held.capabilities ?? []
      if (!capabilities.includes(WEB_SERVER_CAPABILITY)) {
        contracts.set(agentId, { ...held, capabilities: [...capabilities, WEB_SERVER_CAPABILITY] })
      }
      return true
    },

    shelve: async (agentId) => {
      shelvedFor.add(agentId)
      askCount += 1
    },

    taskId: async () => taskId,

    operatorAnswers: (agentId) => {
      answered.add(agentId)
    },

    operatorAsks: (agentId) => {
      asked.add(agentId)
    },

    contractRecorded: (agentId, contract) => {
      if (contract === null) contracts.delete(agentId)
      else contracts.set(agentId, contract)
    },

    capabilitiesOf: (agentId) => contracts.get(agentId)?.capabilities,

    serveCurrentProbe: (agentId) => {
      const row = rows.get(agentId)
      if (row === undefined) return
      if (row.firstServedAt === null) row.firstServedAt = Date.now()
      else row.secondServedAt = Date.now()
    },

    separationElapses: (agentId) => {
      const row = rows.get(agentId)
      if (row?.firstServedAt != null) row.firstServedAt -= WEB_SERVER_SEPARATION_MS + 1000
    },

    shelved: (agentId) => shelvedFor.has(agentId),

    asks: () => askCount,
  }
}

export function fakeWebServer(options?: {
  readonly challenges?: FakeWebServerChallenges
  readonly askOperator?: WebServerDependencies['askOperator']
}): WebServerDependencies & { readonly challenges: FakeWebServerChallenges } {
  return {
    challenges: options?.challenges ?? fakeWebServerChallenges(),
    ...(options?.askOperator === undefined ? {} : { askOperator: options.askOperator }),
    obstruction: noObstruction,
  }
}

/**
 * An operator channel that always puts the question (`#1325`).
 *
 * **A recorder rather than a stub returning `true`.** The rung's whole contract
 * with this dependency is *was it asked* against *what would change that*, and a
 * test that could not see the body would be asserting the first half only —
 * which is how `#567` shipped, with four refusals answering *asked*.
 */
export function fakeAskOperator(): NonNullable<WebServerDependencies['askOperator']> & {
  readonly asked: () => readonly { readonly taskId: string; readonly body: string }[]
} {
  const asked: { taskId: string; body: string }[] = []
  const ask = (input: {
    readonly taskId: string
    readonly body: string
  }): Promise<{ readonly asked: true }> => {
    asked.push({ taskId: String(input.taskId), body: input.body })
    return Promise.resolve({ asked: true as const })
  }

  return Object.assign(ask, { asked: () => asked }) as NonNullable<
    WebServerDependencies['askOperator']
  > & { readonly asked: () => readonly { readonly taskId: string; readonly body: string }[] }
}
