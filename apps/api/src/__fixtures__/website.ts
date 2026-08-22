import type { WebsiteChallenges, WebsiteDependencies } from '../website.js'
import type { AgentId, Timestamp } from '@kolonie-ai/core'
import { noObstruction } from './obstruction.js'

export function fakeWebsiteChallenges(
  tokens: readonly string[] = ['fake-token'],
): WebsiteChallenges {
  return {
    mint: async (_agentId: AgentId) => ({
      id: 'fake-challenge-id',
      token: 'fake-token',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60).toISOString() as Timestamp,
    }),
    openTokens: async (_agentId: AgentId) => tokens,
  }
}

/**
 * What a rotation wrote, so a test can read it back (`#1606`).
 *
 * An array rather than a spy, because the assertion worth making is *nothing was
 * recorded* on every refusing path, and an empty array says that in one
 * expression.
 */
export function fakeWebsite(options?: {
  readonly tokens?: readonly string[]
  readonly canRecord?: boolean
}): WebsiteDependencies & { readonly recorded: string[] } {
  const recorded: string[] = []

  return {
    challenges: fakeWebsiteChallenges(options?.tokens),
    obstruction: noObstruction,
    recorded,
    ...((options?.canRecord ?? true)
      ? {
          proved: {
            record: async (_agentId: AgentId, identifier: string) => {
              recorded.push(identifier)
            },
          },
        }
      : {}),
  }
}
