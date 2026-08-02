import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { RegisterAgentRequestSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { imageChallenges } from '../schema/image.js'
import { registerAgent } from './agents.js'
import { lastImageChallengeExpiry, latestImageChallenge, mintImageChallenge } from './image.js'

const target = databaseTestTarget()

describe('the image rung’s challenges', () => {
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
      RegisterAgentRequestSchema.parse({ name: `painter-${++seeded}`, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  it('mints a specification and reads the same one back', async () => {
    const agentId = await anAgent()
    const minted = await mintImageChallenge(db, agentId)

    expect(await latestImageChallenge(db, agentId)).toEqual(minted)
  })

  it('renders the prompt from the constraints it stored', async () => {
    const agentId = await anAgent()
    const minted = await mintImageChallenge(db, agentId)

    expect(minted.prompt).toContain(minted.constraints.shape)
    expect(minted.prompt).toContain(minted.constraints.background)
  })

  it('answers with nothing for an agent that never minted one', async () => {
    expect(await latestImageChallenge(db, await anAgent())).toBeNull()
  })

  /**
   * Minting again does not revoke the first — the newest open one is what the
   * verifier grades against, which is what the challenge response tells the
   * agent.
   */
  it('reads the newest specification when an agent minted twice', async () => {
    const agentId = await anAgent()
    await mintImageChallenge(db, agentId, () => 0)
    const second = await mintImageChallenge(db, agentId, () => 0.99)

    expect(await latestImageChallenge(db, agentId)).toEqual(second)
  })

  /** Postgres decides expiry, not the caller — two clocks would disagree. */
  it('does not answer with an expired specification', async () => {
    const agentId = await anAgent()
    await mintImageChallenge(db, agentId)
    await db.execute(sql`update image_challenges set created_at = now() - interval '2 hours',
                              expires_at = now() - interval '1 minute'`)

    expect(await latestImageChallenge(db, agentId)).toBeNull()
  })

  /**
   * A row carrying a colour the palette no longer has must not become a question
   * put to a vision model. The columns are `text`, so nothing but this parse
   * stands between an edited palette and a verdict about `chartreuse`.
   */
  it('refuses to serve constraints the palette does not contain', async () => {
    const agentId = await anAgent()
    await mintImageChallenge(db, agentId)
    await db.execute(sql`update image_challenges set background = 'chartreuse'`)

    expect(await latestImageChallenge(db, agentId)).toBeNull()
  })

  /**
   * `rejects.toThrow(/name/)` does not work: Drizzle wraps the driver's error in
   * its own "Failed query: …" and the constraint lives on the `cause`. Matching
   * the top-level message would assert nothing about *which* constraint fired.
   * The same helper `email.test.ts` needed, for the same reason.
   */
  const constraintViolatedBy = async (run: Promise<unknown>): Promise<string> => {
    try {
      await run
      return 'nothing was refused'
    } catch (error) {
      for (let current: unknown = error; current != null; current = cause(current)) {
        const named = current as { constraint_name?: unknown; constraint?: unknown }
        if (typeof named.constraint_name === 'string') return named.constraint_name
        if (typeof named.constraint === 'string') return named.constraint
      }
      return `no constraint named in: ${String(error)}`
    }
  }

  const cause = (error: unknown): unknown =>
    typeof error === 'object' && error !== null && 'cause' in error
      ? (error as { cause?: unknown }).cause
      : undefined

  /**
   * An unsatisfiable specification is the one failure an honest agent cannot
   * work around, so the database refuses it as well as the generator avoiding it.
   */
  it('refuses a row whose shape is the colour of its background', async () => {
    const agentId = await anAgent()

    expect(
      await constraintViolatedBy(
        db.insert(imageChallenges).values({
          agentId,
          background: 'red',
          shape: 'cube',
          shapeColor: 'red',
          position: 'center',
          secondary: 'none',
          prompt: 'impossible',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      ),
    ).toBe('image_challenges_shape_differs_from_background')
  })

  it('reports the last expiry even once it has passed', async () => {
    const agentId = await anAgent()
    await mintImageChallenge(db, agentId)
    await db.execute(sql`update image_challenges set created_at = now() - interval '2 hours',
                              expires_at = now() - interval '1 minute'`)

    expect(await lastImageChallengeExpiry(db, agentId)).not.toBeNull()
    expect(await latestImageChallenge(db, agentId)).toBeNull()
  })
})
