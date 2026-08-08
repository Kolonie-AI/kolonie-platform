import { randomBytes, randomUUID } from 'node:crypto'
import {
  WAKE_CHALLENGE_LIFETIME_MS,
  WAKE_DEFAULT_MAX_PER_HOUR,
  MAX_OPEN_WAKE_CHALLENGES,
  type AgentId,
  type WakeChallenge,
  type WakeDeliveryOutcome,
  type WakeEvent,
} from '@kolonie-ai/core'
import type { WakeDesk } from '@kolonie-ai/verifiers'
import type { WakeChallengeStore, WakeDependencies } from '../wake.js'
import { noObstruction } from './obstruction.js'

/** One delivery the fake recorded, in the order they were attempted. */
export interface RecordedWake {
  readonly agentId: AgentId
  readonly event: WakeEvent
  readonly outcome: WakeDeliveryOutcome
  readonly status?: number | undefined
}

export interface FakeWakeDesk extends WakeDesk {
  /** Give this citizen a proved address, as a passing verdict would. */
  readonly proves: (agentId: AgentId, url: string, secret?: string) => void
  /** Every delivery the sender attempted, in order. */
  readonly recorded: () => readonly RecordedWake[]
  /** Lower the ceiling, so a test does not have to send twelve. */
  readonly ceiling: (perHour: number) => void
}

/**
 * The wake channel's storage, in memory (`#518`).
 *
 * **`no-address` is the default for every agent**, which is the shape of the
 * guarantee the rung makes: a citizen that has not cleared it is served exactly
 * as it was before the channel existed, and a test that never calls `proves`
 * exercises that path without saying so.
 */
export function fakeWakeDesk(): FakeWakeDesk {
  const addresses = new Map<AgentId, { url: string; secret: string }>()
  const deliveries: RecordedWake[] = []
  const at = new Map<number, number>()
  let perHour = WAKE_DEFAULT_MAX_PER_HOUR

  return {
    proves: (agentId, url, secret) => {
      addresses.set(agentId, { url, secret: secret ?? randomBytes(32).toString('hex') })
    },
    recorded: () => deliveries,
    ceiling: (value) => {
      perHour = value
    },

    addressFor: async (agentId) => addresses.get(agentId),
    deliveriesSince: async (agentId, since) =>
      deliveries.filter(
        (row, index) => row.agentId === agentId && (at.get(index) ?? Date.now()) > since.getTime(),
      ).length,
    record: async (input) => {
      at.set(deliveries.length, Date.now())
      deliveries.push(input)
    },
    maxPerHour: async () => perHour,
  }
}

export interface FakeWakeChallenges extends WakeChallengeStore {
  /** The secret issued to this citizen, so a test can knock the way the Colony would. */
  readonly secretFor: (agentId: AgentId) => string | undefined
}

/** The rung's mint, in memory. */
export function fakeWakeChallenges(): FakeWakeChallenges {
  const rows = new Map<AgentId, WakeChallenge[]>()

  return {
    secretFor: (agentId) => rows.get(agentId)?.at(-1)?.secret,
    mint: async ({ agentId, url }) => {
      const held = rows.get(agentId) ?? []
      if (held.length >= MAX_OPEN_WAKE_CHALLENGES) return { outcome: 'too-many' }

      const challenge: WakeChallenge = {
        challengeId: randomUUID(),
        url,
        secret: randomBytes(32).toString('hex'),
        expiresAt: new Date(Date.now() + WAKE_CHALLENGE_LIFETIME_MS).toISOString(),
      }

      rows.set(agentId, [...held, challenge])
      return { outcome: 'minted', challenge }
    },
  }
}

export function fakeWake(): WakeDependencies & { readonly challenges: FakeWakeChallenges } {
  return { challenges: fakeWakeChallenges(), obstruction: noObstruction }
}
