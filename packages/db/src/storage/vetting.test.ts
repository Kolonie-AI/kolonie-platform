import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { RegisterAgentRequestSchema, gradeVetting, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import {
  lastVettingChallengeExpiry,
  latestVettingChallenge,
  mintVettingChallenge,
} from './vetting.js'

const target = databaseTestTarget()

describe('the vetting rung’s manifests', () => {
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
      RegisterAgentRequestSchema.parse({ name: `reviewer-${++seeded}`, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  it('mints a manifest and reads the same one back', async () => {
    const agentId = await anAgent()
    const minted = await mintVettingChallenge(db, agentId)

    expect(await latestVettingChallenge(db, agentId)).toEqual(minted)
  })

  it('stores the manifest with every planted anchor already in it', async () => {
    const minted = await mintVettingChallenge(db, await anAgent())

    expect(minted.planted.length).toBeGreaterThan(0)
    for (const planted of minted.planted) {
      expect(minted.manifest).toContain(planted.anchor)
      expect(planted.anchor).toContain(minted.token)
    }
  })

  it('draws a different token for every attempt', async () => {
    const first = await mintVettingChallenge(db, await anAgent())
    const second = await mintVettingChallenge(db, await anAgent())

    expect(first.token).not.toBe(second.token)
  })

  /**
   * The rung's fourth criterion, end to end: two citizens are graded against
   * their own rows, and the report that fits one does not fit the other.
   */
  it('does not let one citizen’s report pass another citizen’s attempt', async () => {
    const mine = await mintVettingChallenge(db, await anAgent())
    const theirs = await mintVettingChallenge(db, await anAgent())

    const theirReport = {
      findings: theirs.planted.map((plant) => ({ kind: plant.kind, evidence: plant.anchor })),
    }

    expect(gradeVetting(theirReport, theirs)).toEqual({ outcome: 'pass' })
    expect(gradeVetting(theirReport, mine)).not.toEqual({ outcome: 'pass' })
  })

  it('answers with nothing for an agent that has never drawn one', async () => {
    expect(await latestVettingChallenge(db, await anAgent())).toBeNull()
  })

  it('grades against the newest, because minting again is a fresh draw', async () => {
    const agentId = await anAgent()
    await mintVettingChallenge(db, agentId)
    const second = await mintVettingChallenge(db, agentId)

    expect(await latestVettingChallenge(db, agentId)).toEqual(second)
  })

  it('stops answering once the hour is up', async () => {
    const agentId = await anAgent()
    await mintVettingChallenge(db, agentId)
    await db.execute(sql`update vetting_challenges set created_at = now() - interval '2 hours',
                              expires_at = now() - interval '1 minute'`)

    expect(await latestVettingChallenge(db, agentId)).toBeNull()
  })

  it('says when the most recent one runs out, expired or not', async () => {
    const agentId = await anAgent()
    const minted = await mintVettingChallenge(db, agentId)

    expect(await lastVettingChallengeExpiry(db, agentId)).toBe(minted.expiresAt)
  })

  it('answers with no expiry for an agent that has never drawn one', async () => {
    expect(await lastVettingChallengeExpiry(db, await anAgent())).toBeNull()
  })

  /**
   * Drizzle wraps the driver error in its own "Failed query: …" and the
   * constraint lives on the `cause`, so matching the top-level message would
   * assert nothing about *which* constraint fired. The same helper `image.test.ts`
   * needed, for the same reason.
   */
  const cause = (error: unknown): unknown =>
    typeof error === 'object' && error !== null && 'cause' in error
      ? (error as { cause?: unknown }).cause
      : undefined

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

  /**
   * A row with nothing planted is one a citizen passes by reporting nothing,
   * and the verdict would say it found what was there. The draw cannot produce
   * it; the constraint is what stops a future draw doing so.
   */
  it('refuses a row that plants nothing at all', async () => {
    const agentId = await anAgent()

    expect(
      await constraintViolatedBy(
        db.execute(sql`
          insert into vetting_challenges (agent_id, sample, token, planted, manifest, expires_at)
          values (${agentId}, 'note-sync', 'abcd1234', '[]'::jsonb, 'a manifest',
                  now() + interval '1 hour')
        `),
      ),
    ).toBe('vetting_challenges_something_is_planted')
  })

  it('refuses a row that expires before it was created', async () => {
    const agentId = await anAgent()

    expect(
      await constraintViolatedBy(
        db.execute(sql`
          insert into vetting_challenges
            (agent_id, sample, token, planted, manifest, created_at, expires_at)
          values (${agentId}, 'note-sync', 'abcd1234',
                  '[{"kind":"remote-code","anchor":"x"}]'::jsonb, 'a manifest', now(),
                  now() - interval '1 minute')
        `),
      ),
    ).toBe('vetting_challenges_expiry_after_creation')
  })
})
