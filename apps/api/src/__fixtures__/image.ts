import type { AgentId, ImageConstraints, Timestamp } from '@kolonie-ai/core'
import { imagePromptFor } from '@kolonie-ai/core'
import type { ImageChallenges, ImageDependencies } from '../image.js'

/**
 * A fixed specification, so a test asserting on the response is not asserting on
 * a draw. The prompt is rendered by the real function rather than written out
 * here, which is what keeps a test from passing while the two disagree.
 */
export const FAKE_IMAGE_CONSTRAINTS: ImageConstraints = {
  background: 'green',
  shape: 'cube',
  shapeColor: 'red',
  position: 'top-left',
  secondary: 'a small star',
}

export function fakeImageChallenges(): ImageChallenges {
  return {
    mint: async (_agentId: AgentId) => ({
      constraints: FAKE_IMAGE_CONSTRAINTS,
      prompt: imagePromptFor(FAKE_IMAGE_CONSTRAINTS),
      expiresAt: new Date(Date.now() + 1000 * 60 * 60).toISOString() as Timestamp,
    }),
  }
}

export function fakeImage(): ImageDependencies {
  return { challenges: fakeImageChallenges() }
}
