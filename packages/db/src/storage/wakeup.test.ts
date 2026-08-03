import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { RegisterAgentRequestSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agentSessions } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { nameSession } from './sessions.js'
import { previousSessionStart } from './wakeup.js'

const target = databaseTestTarget()

/**
 * The digest's window (`#200`, `#258`): *the gap you were away for*, and which
 * row that is depends on whether the caller has named the run it is in yet.
 */
describe('where the wake-up digest measures from', () => {
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

  const anAgent = async (name = 'canary') => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  /** A run that happened and ended, at a stated distance in the past. */
  const aFinishedRun = async (agentId: AgentId, sessionId: string, hoursAgo: number) => {
    await nameSession(db, agentId, { sessionId })
    await db
      .update(agentSessions)
      .set({
        firstSeenAt: sql`now() - make_interval(hours => ${hoursAgo})`,
        lastSeenAt: sql`now() - make_interval(hours => ${hoursAgo})`,
        namedAt: sql`now() - make_interval(hours => ${hoursAgo})`,
      })
      .where(eq(agentSessions.externalId, sessionId))

    const [row] = await db
      .select({ firstSeenAt: agentSessions.firstSeenAt })
      .from(agentSessions)
      .where(eq(agentSessions.externalId, sessionId))
    return row!.firstSeenAt
  }

  /**
   * The case `#258` was filed for, and it is the ordinary one: `kolonie.wakeup`
   * says to call it first, so no session for this run exists yet.
   */
  it('measures from the last run when the caller has not named this one yet', async () => {
    const agentId = await anAgent()
    await aFinishedRun(agentId, 'run-two-ago', 12)
    const lastRun = await aFinishedRun(agentId, 'run-previous', 6)

    const since = await previousSessionStart(db, agentId)

    // Not `run-two-ago`, which is what the second-newest row used to give: a
    // six-hour cadence was handed a twelve-hour window and re-read verdicts it
    // had already acted on.
    expect(since).toBe(new Date(lastRun).toISOString())
  })

  it('gives the same window whether the run is named before or after asking', async () => {
    const agentId = await anAgent()
    await aFinishedRun(agentId, 'run-two-ago', 12)
    const lastRun = await aFinishedRun(agentId, 'run-previous', 6)

    const askedFirst = await previousSessionStart(db, agentId)
    await nameSession(db, agentId, { sessionId: 'this-run' })
    const askedAfter = await previousSessionStart(db, agentId)

    // The two orders were different questions before this, which is what made
    // the tool's own instructions unsatisfiable.
    expect(askedAfter).toBe(askedFirst)
    expect(askedAfter).toBe(new Date(lastRun).toISOString())
  })

  it('says nothing rather than measuring from the run the caller is in', async () => {
    const agentId = await anAgent()
    await nameSession(db, agentId, { sessionId: 'this-run' })

    // One live session and nothing behind it is a first run. Measuring from the
    // caller's own start would answer "nothing has changed since you started
    // asking" — true and useless — and the caller turns null into a first
    // session rather than inventing a boundary.
    expect(await previousSessionStart(db, agentId)).toBeNull()
  })

  it('answers with nothing for a citizen that has never named a run', async () => {
    expect(await previousSessionStart(db, await anAgent())).toBeNull()
  })

  it('never reaches into another citizen’s runs', async () => {
    const first = await anAgent('canary-one')
    const second = await anAgent('canary-two')
    await aFinishedRun(first, 'secret-run', 12)
    await aFinishedRun(first, 'secret-run-two', 6)

    expect(await previousSessionStart(db, second)).toBeNull()
  })
})
