import { randomBytes } from 'node:crypto'
import type { AgentId } from '@kolonie-ai/core'
import type { MintedSocialChallenge } from '@kolonie-ai/db'
import type { SocialChallenges, SocialDependencies } from '../social.js'
import { noObstruction } from './obstruction.js'

export interface FakeSocialChallenges extends SocialChallenges {
  /** Every nonce minted for an agent, oldest first. */
  readonly minted: (agentId: AgentId) => readonly string[]
}

/**
 * An in-memory store for the social rung's nonces.
 *
 * The GitHub fake, one network out, and small for the same reason: there is
 * nothing to hand back through this port. The API mints, and what happens next
 * happens on a public network and is decided by a verifier reading it.
 */
export function fakeSocialChallenges(): FakeSocialChallenges {
  const rows = new Map<AgentId, string[]>()

  return {
    mint: (agentId): Promise<MintedSocialChallenge> => {
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

/** The social rung wired for a test that does not care about it. */
export function fakeSocial(): SocialDependencies {
  return { challenges: fakeSocialChallenges(), obstruction: noObstruction }
}
