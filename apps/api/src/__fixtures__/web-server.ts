import { randomUUID } from 'node:crypto'
import {
  WEB_SERVER_CHALLENGE_LIFETIME_MS,
  WEB_SERVER_PATH_PREFIX,
  WEB_SERVER_PROBE_WINDOW_MS,
  WEB_SERVER_SEPARATION_MS,
  type AgentId,
  type TaskId,
  type WebServerChallenge,
} from '@kolonie-ai/core'
import type { WebServerChallengeStore, WebServerDependencies } from '../web-server.js'
import { noObstruction } from './obstruction.js'

export interface FakeWebServerChallenges extends WebServerChallengeStore {
  /** Say an operator has come back about this rung, without running the channel. */
  readonly operatorAnswers: (agentId: AgentId) => void
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
export function fakeWebServerChallenges(): FakeWebServerChallenges {
  const rows = new Map<AgentId, Row>()
  const answered = new Set<AgentId>()
  const asked = new Set<AgentId>()
  const shelvedFor = new Set<AgentId>()
  const taskId = randomUUID() as TaskId
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
    mint: async (input) => {
      const existing = rows.get(input.agentId)
      if (existing !== undefined && existing.secondServedAt === null) {
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

    shelve: async (agentId) => {
      shelvedFor.add(agentId)
      asked.add(agentId)
      askCount += 1
    },

    taskId: async () => taskId,

    operatorAnswers: (agentId) => {
      answered.add(agentId)
    },

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
  readonly operatorRequests?: WebServerDependencies['operatorRequests']
}): WebServerDependencies & { readonly challenges: FakeWebServerChallenges } {
  return {
    challenges: options?.challenges ?? fakeWebServerChallenges(),
    ...(options?.operatorRequests === undefined
      ? {}
      : { operatorRequests: options.operatorRequests }),
    obstruction: noObstruction,
  }
}
