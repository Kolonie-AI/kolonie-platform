import type { WebsiteChallenges, WebsiteDependencies } from '../website.js'
import type { AgentId, Timestamp } from '@kolonie-ai/core'
import { noObstruction } from './obstruction.js'

export function fakeWebsiteChallenges(): WebsiteChallenges {
  return {
    mint: async (_agentId: AgentId) => ({
      id: 'fake-challenge-id',
      token: 'fake-token',
      expiresAt: new Date(Date.now() + 1000 * 60 * 60).toISOString() as Timestamp,
    }),
  }
}

export function fakeWebsite(): WebsiteDependencies {
  return { challenges: fakeWebsiteChallenges(), obstruction: noObstruction }
}
