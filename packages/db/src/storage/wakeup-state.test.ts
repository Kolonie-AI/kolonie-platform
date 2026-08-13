import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { RegisterAgentRequestSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { recordWakeupAnswer } from './wakeup-state.js'

const target = databaseTestTarget()

/**
 * *A citizen that sees the same five options on every waking is not idle — the
 * Colony is repeating itself* (`#879`, mechanism in `#880`).
 *
 * A citizen cannot detect its own repetition: it does not remember the last two
 * wakings, and each one looks perfectly reasonable on its own. What is asserted
 * here is the only thing that makes the pattern visible to anybody — the counter
 * goes up when, and only when, the answer is the same one **and** nothing moved
 * in between.
 */
describe('noticing that an answer is the same one as last time', () => {
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

  const anAgent = async (name: string): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  const same = 'a'.repeat(64)
  const other = 'b'.repeat(64)

  it('starts at zero, because a first answer cannot be a repeat', async () => {
    const agentId = await anAgent('canary')

    expect(await recordWakeupAnswer(db, agentId, same, true)).toEqual({ repeats: 0 })
  })

  it('counts up while the answer and the world both stay put', async () => {
    const agentId = await anAgent('canary')

    await recordWakeupAnswer(db, agentId, same, true)
    expect(await recordWakeupAnswer(db, agentId, same, true)).toEqual({ repeats: 1 })
    expect(await recordWakeupAnswer(db, agentId, same, true)).toEqual({ repeats: 2 })
    expect(await recordWakeupAnswer(db, agentId, same, true)).toEqual({ repeats: 3 })
  })

  /**
   * The first of the two resets. A different list is the Colony having something
   * new to say, whatever else was quiet.
   */
  it('starts again when the answer changes', async () => {
    const agentId = await anAgent('canary')

    await recordWakeupAnswer(db, agentId, same, true)
    await recordWakeupAnswer(db, agentId, same, true)
    expect(await recordWakeupAnswer(db, agentId, other, true)).toEqual({ repeats: 0 })
  })

  /**
   * The second, and the one that matters more: a citizen whose verdict landed
   * has been told something, even if the list it is handed next looks identical.
   * Counting that as a repeat would escalate at a citizen that is making progress.
   */
  it('starts again when something moved while the citizen was away', async () => {
    const agentId = await anAgent('canary')

    await recordWakeupAnswer(db, agentId, same, true)
    await recordWakeupAnswer(db, agentId, same, true)
    expect(await recordWakeupAnswer(db, agentId, same, false)).toEqual({ repeats: 0 })
    // And the run begins again from there rather than resuming where it stopped.
    expect(await recordWakeupAnswer(db, agentId, same, true)).toEqual({ repeats: 1 })
  })

  /** One row per citizen, updated in place: this is a counter, not a history. */
  it('keeps one row per citizen however many wakings there are', async () => {
    const agentId = await anAgent('canary')

    for (let index = 0; index < 5; index += 1) await recordWakeupAnswer(db, agentId, same, true)

    const rows = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from agent_wakeup_state`,
    )

    expect(rows[0]?.count).toBe('1')
  })

  it('counts each citizen separately', async () => {
    const one = await anAgent('one')
    const two = await anAgent('two')

    await recordWakeupAnswer(db, one, same, true)
    await recordWakeupAnswer(db, one, same, true)

    expect(await recordWakeupAnswer(db, two, same, true)).toEqual({ repeats: 0 })
    expect(await recordWakeupAnswer(db, one, same, true)).toEqual({ repeats: 2 })
  })

  /**
   * **A failed write answers zero**, which is the state that changes nothing.
   * Observation on the first call of a wake-up must not be able to stand between
   * a citizen and its digest, so the failure mode is *the Colony does not notice
   * it is repeating itself* and never *a citizen is told something false*.
   */
  it('answers zero rather than throwing when the row cannot be written', async () => {
    const missing = '00000000-0000-4000-8000-000000000001' as AgentId

    expect(await recordWakeupAnswer(db, missing, same, true)).toEqual({ repeats: 0 })
  })
})
