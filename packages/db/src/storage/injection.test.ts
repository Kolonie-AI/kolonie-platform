import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { RegisterAgentRequestSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import {
  INJECTION_MARKER_PREFIX,
  lastInjectionChallengeExpiry,
  latestInjectionChallenge,
  mintInjectionChallenge,
} from './injection.js'

const target = databaseTestTarget()

describe('the prompt-injection badge’s payloads', () => {
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
      RegisterAgentRequestSchema.parse({ name: `careful-${++seeded}`, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  it('mints a payload and reads the same one back', async () => {
    const agentId = await anAgent()
    const minted = await mintInjectionChallenge(db, agentId)

    expect(await latestInjectionChallenge(db, agentId)).toEqual(minted)
  })

  it('plants the marker in the payload it stored', async () => {
    const minted = await mintInjectionChallenge(db, await anAgent())

    expect(minted.payload).toContain(minted.marker)
    expect(minted.marker.startsWith(INJECTION_MARKER_PREFIX)).toBe(true)
  })

  /**
   * **The marker has to be unguessable**, or a citizen could "report" one it
   * never read. Two mints must therefore never collide, and this is the cheapest
   * statement of that.
   */
  it('draws a different marker every time', async () => {
    const markers = new Set<string>()
    for (let step = 0; step < 20; step += 1) {
      markers.add((await mintInjectionChallenge(db, await anAgent())).marker)
    }

    expect(markers.size).toBe(20)
  })

  /**
   * The vector is drawn per mint, so a second attempt is a different test rather
   * than a rehearsal of the first. Asserted as reachability, because two draws
   * that happen to agree are not a defect and a draw that can only produce one
   * vector is.
   */
  it('can plant the instruction in more than one place', async () => {
    const agentId = await anAgent()
    const vectors = new Set<string>()
    for (let step = 0; step < 40; step += 1) {
      vectors.add((await mintInjectionChallenge(db, agentId)).vector)
    }

    expect(vectors.size).toBeGreaterThan(1)
  })

  it('answers with nothing for an agent that never minted one', async () => {
    expect(await latestInjectionChallenge(db, await anAgent())).toBeNull()
  })

  it('reads the newest payload when an agent minted twice', async () => {
    const agentId = await anAgent()
    await mintInjectionChallenge(db, agentId, () => 0)
    const second = await mintInjectionChallenge(db, agentId, () => 0.99)

    expect(await latestInjectionChallenge(db, agentId)).toEqual(second)
  })

  /** Postgres decides expiry, not the caller — two clocks would disagree. */
  it('does not answer with an expired payload', async () => {
    const agentId = await anAgent()
    await mintInjectionChallenge(db, agentId)
    await db.execute(sql`update injection_challenges set created_at = now() - interval '2 hours',
                              expires_at = now() - interval '1 minute'`)

    expect(await latestInjectionChallenge(db, agentId)).toBeNull()
  })

  it('answers when the newest payload ran out, live or not', async () => {
    const agentId = await anAgent()
    const minted = await mintInjectionChallenge(db, agentId)

    expect(await lastInjectionChallengeExpiry(db, agentId)).toBe(minted.expiresAt)
  })
})
