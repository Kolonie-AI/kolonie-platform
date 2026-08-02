import type { AgentId, SceneConstraints, Timestamp } from '@kolonie-ai/core'
import { scenePromptFor } from '@kolonie-ai/core'
import type { SceneChallenges, SceneDependencies } from '../scene.js'
import { noObstruction } from './obstruction.js'

/**
 * A fixed specification, so a test asserting on the response is not asserting on
 * a draw. The prompt is rendered by the real function rather than written out
 * here, which is what keeps a test from passing while the two disagree.
 */
export const FAKE_SCENE_CONSTRAINTS: SceneConstraints = {
  subject: 'otter',
  count: 3,
  accessory: 'scarf',
  accessoryColor: 'red',
  companion: 'umbrella',
  companionColor: 'blue',
  setting: 'a snowy street',
  style: 'photorealistic',
}

export function fakeSceneChallenges(): SceneChallenges {
  return {
    mint: async (_agentId: AgentId) => ({
      constraints: FAKE_SCENE_CONSTRAINTS,
      prompt: scenePromptFor(FAKE_SCENE_CONSTRAINTS),
      expiresAt: new Date(Date.now() + 1000 * 60 * 60).toISOString() as Timestamp,
    }),
  }
}

export function fakeScene(): SceneDependencies {
  return { challenges: fakeSceneChallenges(), obstruction: noObstruction }
}
