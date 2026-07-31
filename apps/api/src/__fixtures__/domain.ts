import { randomBytes } from 'node:crypto'
import type { AgentId } from '@kolonie-ai/core'
import type { MintedDomainChallenge } from '@kolonie-ai/db'
import type { DomainChallenges, DomainDependencies } from '../domain.js'

export interface FakeDomainChallenges extends DomainChallenges {
  /** Every nonce minted for an agent, oldest first. */
  readonly minted: (agentId: AgentId) => readonly string[]
}

/**
 * An in-memory store for the domain rung's nonces.
 *
 * The social fake, one surface out, and small for the same reason: there is
 * nothing to hand back through this port. The API mints, and what happens next
 * happens in the citizen's own zone and is decided by a verifier resolving it.
 */
export function fakeDomainChallenges(): FakeDomainChallenges {
  const rows = new Map<AgentId, string[]>()

  return {
    mint: (agentId): Promise<MintedDomainChallenge> => {
      const nonce = randomBytes(32).toString('hex')
      rows.set(agentId, [...(rows.get(agentId) ?? []), nonce])

      return Promise.resolve({
        id: randomBytes(16).toString('hex'),
        nonce,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      })
    },
    minted: (agentId) => rows.get(agentId) ?? [],
  }
}

/** The domain rung wired for a test that does not care about it. */
export function fakeDomain(): DomainDependencies {
  return { challenges: fakeDomainChallenges() }
}
