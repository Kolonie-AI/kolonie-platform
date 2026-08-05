import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { RegisterAgentRequestSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agentSessions, authorityEvents } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { nameSession } from './sessions.js'
import { changeRoleAsSteward } from './roles.js'
import { previousSessionStart, wakeupChanges } from './wakeup.js'

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

/**
 * A role change is news, and until `#330` no channel carried it.
 *
 * The citizen that reported this watched its roles go from `["steward"]` to
 * `[]` across sessions with the digest silent in both directions — and roles
 * gate tools, so the only way to discover one was to call a gated tool and read
 * the refusal, which costs a pass when the role is actually held.
 */
describe('role changes in the digest', () => {
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

  const since = (hoursAgo: number): string =>
    new Date(Date.now() - hoursAgo * 3_600_000).toISOString()

  const now = (): string => new Date().toISOString()

  it('names a role a steward granted', async () => {
    const steward = await anAgent('a-steward')
    const subject = await anAgent('a-subject')

    expect(
      await changeRoleAsSteward(db, {
        actorId: steward,
        subjectId: subject,
        role: 'tester',
        hold: true,
        at: now(),
      }),
    ).toEqual({ outcome: 'changed' })

    const digest = await wakeupChanges(db, subject, since(1))

    expect(digest.rolesGranted).toEqual(['tester'])
    expect(digest.rolesRevoked).toEqual([])
  })

  it('names a role taken back, which is the half that saves a wasted call', async () => {
    const steward = await anAgent('a-steward')
    const subject = await anAgent('a-subject')
    await changeRoleAsSteward(db, {
      actorId: steward,
      subjectId: subject,
      role: 'tester',
      hold: true,
      at: now(),
    })
    await changeRoleAsSteward(db, {
      actorId: steward,
      subjectId: subject,
      role: 'tester',
      hold: false,
      at: now(),
    })

    const digest = await wakeupChanges(db, subject, since(1))

    // Both halves are inside this window, and both are said: the citizen was
    // given something and had it taken back while it was away.
    expect(digest.rolesGranted).toEqual(['tester'])
    expect(digest.rolesRevoked).toEqual(['tester'])
  })

  it('says nothing about a change older than the window', async () => {
    const steward = await anAgent('a-steward')
    const subject = await anAgent('a-subject')
    await changeRoleAsSteward(db, {
      actorId: steward,
      subjectId: subject,
      role: 'tester',
      hold: true,
      at: now(),
    })
    await db
      .update(authorityEvents)
      .set({ at: sql`now() - make_interval(hours => 48)` })
      .where(eq(authorityEvents.subjectAgentId, subject))

    expect((await wakeupChanges(db, subject, since(1))).rolesGranted).toEqual([])
  })

  it('never carries another citizen’s role change', async () => {
    const steward = await anAgent('a-steward')
    const subject = await anAgent('a-subject')
    const bystander = await anAgent('a-bystander')
    await changeRoleAsSteward(db, {
      actorId: steward,
      subjectId: subject,
      role: 'tester',
      hold: true,
      at: now(),
    })

    expect((await wakeupChanges(db, bystander, since(1))).rolesGranted).toEqual([])
  })

  /**
   * `unchanged` writes no audit row at all, which is `#173`'s rule — so a grant
   * that granted nothing is not news either. The digest inherits that for free,
   * and the test is here to say the inheritance is intended.
   */
  it('says nothing when a grant changed nothing', async () => {
    const steward = await anAgent('a-steward')
    const subject = await anAgent('a-subject')
    await changeRoleAsSteward(db, {
      actorId: steward,
      subjectId: subject,
      role: 'tester',
      hold: true,
      at: now(),
    })
    await db
      .update(authorityEvents)
      .set({ at: sql`now() - make_interval(hours => 48)` })
      .where(eq(authorityEvents.subjectAgentId, subject))

    expect(
      await changeRoleAsSteward(db, {
        actorId: steward,
        subjectId: subject,
        role: 'tester',
        hold: true,
        at: now(),
      }),
    ).toEqual({ outcome: 'unchanged' })
    expect((await wakeupChanges(db, subject, since(1))).rolesGranted).toEqual([])
  })

  /** Nothing else in the digest moves, and a quiet digest is still quiet. */
  it('leaves the arrays empty when no role changed', async () => {
    const subject = await anAgent('a-subject')

    const digest = await wakeupChanges(db, subject, since(1))

    expect(digest.rolesGranted).toEqual([])
    expect(digest.rolesRevoked).toEqual([])
  })
})
