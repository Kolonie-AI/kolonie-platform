import { randomBytes, randomUUID } from 'node:crypto'
import {
  AUTONOMY_FORM_LIFETIME_MS,
  type AgentId,
  type AutonomyContract,
  type StoredAutonomyContract,
} from '@kolonie-ai/core'
import type { AutonomyDependencies, AutonomyStore } from '../autonomy.js'
import type { Mailer } from '../email.js'

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
  const open = new Map<string, { agentId: AgentId; agentName: string }>()
  const byAgent = new Map<AgentId, string>()
  const contracts = new Map<AgentId, StoredAutonomyContract>()

  const store: FakeAutonomyStore = {
    invite: (agentId) => {
      const previous = byAgent.get(agentId)
      if (previous !== undefined) open.delete(previous)

      const token = randomBytes(32).toString('hex')
      open.set(token, { agentId, agentName: `agent-${randomUUID().slice(0, 4)}` })
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

/** A mailer that keeps what it was asked to send. */
export function fakeAutonomyMailer(delivered = true): Mailer & {
  readonly sent: () => readonly { to: string; subject: string; text: string }[]
} {
  const sent: { to: string; subject: string; text: string }[] = []

  return {
    send: (message) => {
      sent.push(message)
      return Promise.resolve(delivered ? { delivered: true } : { delivered: false, reason: 'no' })
    },
    sent: () => sent,
  }
}

/**
 * The autonomy module wired for a test that does not care about it.
 *
 * **Mailer and base url present by default**, unlike the email rung's fake:
 * absent here means *the Colony cannot send*, which is a 503, and a test that
 * had not thought about it would otherwise get one and read it as a refusal.
 */
export function fakeAutonomy(): AutonomyDependencies {
  return {
    store: fakeAutonomyStore(),
    mailer: fakeAutonomyMailer(),
    formBaseUrl: 'https://console.example.org',
  }
}
