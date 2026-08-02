import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { RegisterAgentRequestSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { sceneChallenges } from '../schema/scene.js'
import { registerAgent } from './agents.js'
import { lastSceneChallengeExpiry, latestSceneChallenge, mintSceneChallenge } from './scene.js'

const target = databaseTestTarget()

describe('the generator rung’s scene challenges', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  let seeded = 0

  const anAgent = async (): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name: `renderer-${++seeded}`, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  it('mints a specification and reads the same one back', async () => {
    const agentId = await anAgent()
    const minted = await mintSceneChallenge(db, agentId)

    expect(await latestSceneChallenge(db, agentId)).toEqual(minted)
  })

  it('renders the prompt from the constraints it stored', async () => {
    const agentId = await anAgent()
    const minted = await mintSceneChallenge(db, agentId)

    expect(minted.prompt).toContain(minted.constraints.subject)
    expect(minted.prompt).toContain(minted.constraints.setting)
    expect(minted.prompt).toContain(String(minted.constraints.count))
  })

  it('answers with nothing for an agent that never minted one', async () => {
    expect(await latestSceneChallenge(db, await anAgent())).toBeNull()
  })

  /**
   * Minting again does not revoke the first — the newest open one is what the
   * verifier grades against, which is what the challenge response tells the
   * agent.
   */
  it('reads the newest specification when an agent minted twice', async () => {
    const agentId = await anAgent()
    await mintSceneChallenge(db, agentId, () => 0)
    const second = await mintSceneChallenge(db, agentId, () => 0.99)

    expect(await latestSceneChallenge(db, agentId)).toEqual(second)
  })

  /** Postgres decides expiry, not the caller — two clocks would disagree. */
  it('does not answer with an expired specification', async () => {
    const agentId = await anAgent()
    await mintSceneChallenge(db, agentId)
    await db.execute(sql`update scene_challenges set created_at = now() - interval '2 hours',
                              expires_at = now() - interval '1 minute'`)

    expect(await latestSceneChallenge(db, agentId)).toBeNull()
  })

  it('answers when the newest specification ran out, live or not', async () => {
    const agentId = await anAgent()
    const minted = await mintSceneChallenge(db, agentId)

    expect(await lastSceneChallengeExpiry(db, agentId)).toBe(minted.expiresAt)
  })

  /**
   * **The database refuses a specification no image could satisfy.** The draw
   * already avoids binding one colour to both objects; this is the half that
   * makes a future draw unable to reintroduce it, and it is worth a test because
   * a check constraint nobody exercises is a check constraint nobody knows is
   * there.
   */
  it('refuses a row binding one colour to both objects', async () => {
    const agentId = await anAgent()

    await expect(
      db.insert(sceneChallenges).values({
        agentId,
        subject: 'otter',
        count: 3,
        accessory: 'scarf',
        accessoryColor: 'red',
        companion: 'umbrella',
        companionColor: 'red',
        setting: 'a snowy street',
        style: 'photorealistic',
        prompt: 'A specification no image can satisfy legibly.',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
    ).rejects.toThrow()
  })

  /** The ceiling is the judge's limit, not the generator's — see the schema. */
  it('refuses a count outside the range the judge can be trusted with', async () => {
    const agentId = await anAgent()

    await expect(
      db.insert(sceneChallenges).values({
        agentId,
        subject: 'otter',
        count: 9,
        accessory: 'scarf',
        accessoryColor: 'red',
        companion: 'umbrella',
        companionColor: 'blue',
        setting: 'a snowy street',
        style: 'photorealistic',
        prompt: 'Nine otters, which no judge should be asked to count.',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
    ).rejects.toThrow()
  })
})
