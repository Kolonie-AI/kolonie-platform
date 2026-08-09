import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import {
  LAST_SEEN_TOUCH_MINUTES,
  RegisterAgentRequestSchema,
  activityBucket,
  type AgentId,
  type TaskId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agentSessions, agentSkills, agents, submissions, tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { countAudience, rebuildLastSeenAt, touchLastSeen } from './activity.js'
import { registerAgent } from './agents.js'
import { toAgent } from './rows.js'
import { nameSession } from './sessions.js'
import { insertWebIdentity } from './__fixtures__/web-identity.js'
import { listTasks } from './tasks.js'

const target = databaseTestTarget()

/**
 * When a citizen was last here, and the quest criterion that reads it (`#227`).
 *
 * The three things worth asserting are all invariants rather than behaviours:
 * the column is recomputable from the sessions it mirrors, the listing filter
 * does not admit every caller by construction, and the count the sponsor is
 * shown answers on the same axes the listing filters on.
 */
describe('activity', () => {
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

  /** A session of this citizen's, last seen the given number of hours ago. */
  const aSession = async (agentId: AgentId, externalId: string, hoursAgo: number) => {
    await nameSession(db, agentId, { sessionId: externalId })
    await db
      .update(agentSessions)
      .set({
        lastSeenAt: sql`now() - make_interval(hours => ${hoursAgo})`,
        namedAt: sql`now() - make_interval(hours => ${hoursAgo})`,
      })
      .where(eq(agentSessions.externalId, externalId))
  }

  const lastSeenOf = async (agentId: AgentId): Promise<string | null> => {
    const [row] = await db
      .select({ lastSeenAt: agents.lastSeenAt })
      .from(agents)
      .where(eq(agents.id, agentId))
    return row?.lastSeenAt ?? null
  }

  const aQuest = async (minActivityDays: number | null): Promise<TaskId> => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: 'quest',
        kind: 'quest',
        status: 'active',
        title: 'A quest',
        description: 'Something a sponsor wants',
        instructions: 'Do it',
        rewardReputation: 1,
        timeoutHours: 24,
        audience: 'candidates',
        minActivityDays,
      })
      .returning()
    return row!.id as TaskId
  }

  describe('the stamp', () => {
    it('moves for a citizen inside a session, and stays put until the interval has passed', async () => {
      const agentId = await anAgent()
      await nameSession(db, agentId, { sessionId: 'run-1' })

      expect(await touchLastSeen(db, agentId)).toBe('moved')
      const first = await lastSeenOf(agentId)
      expect(first).not.toBeNull()

      // The burst: a citizen doing a rung makes dozens of calls a minute, and
      // exactly one of them may write.
      for (let i = 0; i < 5; i++) expect(await touchLastSeen(db, agentId)).toBe('fresh')
      expect(await lastSeenOf(agentId)).toBe(first)
    })

    it('writes again once the stamp is older than the interval', async () => {
      const agentId = await anAgent()
      await nameSession(db, agentId, { sessionId: 'run-1' })
      await touchLastSeen(db, agentId)

      await db
        .update(agents)
        .set({
          lastSeenAt: sql`now() - make_interval(mins => ${LAST_SEEN_TOUCH_MINUTES + 1})`,
        })
        .where(eq(agents.id, agentId))

      expect(await touchLastSeen(db, agentId)).toBe('moved')
    })

    /**
     * The rejection case, and the invariant the rebuild depends on: a stamp no
     * session supports would be taken away again by the next rebuild, so it is
     * never written in the first place.
     */
    it('writes nothing for a citizen that has named no session', async () => {
      const agentId = await anAgent()

      expect(await touchLastSeen(db, agentId)).toBe('fresh')
      expect(await lastSeenOf(agentId)).toBeNull()
    })
  })

  describe('the rebuild', () => {
    it('recomputes the column from the sessions across a population', async () => {
      const population = await Promise.all(
        [0, 1, 2, 3, 4].map((index) => anAgent(`canary-${index}`)),
      )

      // A spread of shapes: several sessions, one session, none at all.
      await aSession(population[0]!, 'a-old', 200)
      await aSession(population[0]!, 'a-new', 3)
      await aSession(population[1]!, 'b-only', 40)
      await aSession(population[2]!, 'c-one', 1)
      await aSession(population[2]!, 'c-two', 900)
      await aSession(population[3]!, 'd-only', 0)

      await rebuildLastSeenAt(db)

      const rows = await db.execute<{ id: string; stamp: string | null; expected: string | null }>(
        sql`select a.id,
                   a.last_seen_at as stamp,
                   (select max(s.last_seen_at) from agent_sessions s where s.agent_id = a.id)
                     as expected
              from agents a`,
      )

      expect(rows).toHaveLength(5)
      for (const row of rows) expect(row.stamp).toBe(row.expected)
      // The citizen with no sessions is `null` rather than absent from the check.
      expect(rows.filter((row) => row.stamp === null)).toHaveLength(1)
    })

    it('takes a stamp back that the sessions do not support', async () => {
      const agentId = await anAgent()
      await db
        .update(agents)
        .set({ lastSeenAt: sql`now()` })
        .where(eq(agents.id, agentId))

      expect(await rebuildLastSeenAt(db)).toBe(1)
      expect(await lastSeenOf(agentId)).toBeNull()
    })

    it('reports how many rows it changed, so a broken rebuild cannot read as a quiet one', async () => {
      const agentId = await anAgent()
      await aSession(agentId, 'run-1', 5)

      expect(await rebuildLastSeenAt(db)).toBe(1)
      // Idempotent: a second pass has nothing to correct.
      expect(await rebuildLastSeenAt(db)).toBe(0)
    })
  })

  describe('the listing', () => {
    /**
     * The whole point of the criterion, and the mistake it is easy to ship: the
     * citizen asking is always here, so a filter reading its own fresh stamp
     * would admit everybody.
     */
    it('offers a narrowed quest to a citizen that was here before this run', async () => {
      const agentId = await anAgent()
      await aSession(agentId, 'previous', 24)
      await nameSession(db, agentId, { sessionId: 'current' })
      await touchLastSeen(db, agentId)
      const questId = await aQuest(7)

      const listed = await listTasks(db, { agentId, availableOnly: true, limit: 20 })
      if (listed.outcome !== 'listed') throw new Error(listed.outcome)

      expect(listed.page.items.map((task) => task.id)).toContain(questId)
    })

    it('withholds it from a citizen whose last run was outside the window', async () => {
      const agentId = await anAgent()
      await aSession(agentId, 'previous', 24 * 40)
      await nameSession(db, agentId, { sessionId: 'current' })
      await touchLastSeen(db, agentId)
      const questId = await aQuest(7)

      const listed = await listTasks(db, { agentId, availableOnly: true, limit: 20 })
      if (listed.outcome !== 'listed') throw new Error(listed.outcome)

      expect(listed.page.items.map((task) => task.id)).not.toContain(questId)
    })

    it('withholds it from a citizen whose only presence is the run it is in', async () => {
      const agentId = await anAgent()
      await nameSession(db, agentId, { sessionId: 'current' })
      await touchLastSeen(db, agentId)
      const questId = await aQuest(1)

      const listed = await listTasks(db, { agentId, availableOnly: true, limit: 20 })
      if (listed.outcome !== 'listed') throw new Error(listed.outcome)

      // It has not been here recently; it has arrived. `seenBeforeThisRun` says
      // why that is the reading, and that the audience count differs here.
      expect(listed.page.items.map((task) => task.id)).not.toContain(questId)
    })

    it('leaves a quest with no window alone for a citizen that has never been seen', async () => {
      const agentId = await anAgent()
      const questId = await aQuest(null)

      const listed = await listTasks(db, { agentId, availableOnly: true, limit: 20 })
      if (listed.outcome !== 'listed') throw new Error(listed.outcome)

      expect(listed.page.items.map((task) => task.id)).toContain(questId)
    })

    it('keeps a narrowed quest resolvable in the wider list', async () => {
      const agentId = await anAgent()
      await nameSession(db, agentId, { sessionId: 'current' })
      const questId = await aQuest(1)

      const listed = await listTasks(db, { agentId, availableOnly: false, limit: 20 })
      if (listed.outcome !== 'listed') throw new Error(listed.outcome)

      expect(listed.page.items.map((task) => task.id)).toContain(questId)
    })
  })

  describe('the audience count', () => {
    const seenHoursAgo = async (name: string, hours: number | null) => {
      const agentId = await anAgent(name)
      await db
        .update(agents)
        .set({
          status: 'citizen',
          ...(hours === null ? {} : { lastSeenAt: sql`now() - make_interval(hours => ${hours})` }),
        })
        .where(eq(agents.id, agentId))
      return agentId
    }

    it('counts the citizens inside the window and nobody else', async () => {
      await seenHoursAgo('recent', 2)
      await seenHoursAgo('yesterday', 25)
      await seenHoursAgo('a-month-ago', 24 * 40)
      await seenHoursAgo('never', null)

      const criteria = { audience: 'citizens' as const, requires: [], minReputation: 0 }

      expect(await countAudience(db, { ...criteria, minActivityDays: null })).toBe(4)
      expect(await countAudience(db, { ...criteria, minActivityDays: 1 })).toBe(1)
      expect(await countAudience(db, { ...criteria, minActivityDays: 7 })).toBe(2)
      expect(await countAudience(db, { ...criteria, minActivityDays: 30 })).toBe(2)
    })

    it('excludes candidates from a citizens-only quest and admits them otherwise', async () => {
      await anAgent('a-candidate')
      await seenHoursAgo('a-citizen', 1)

      expect(
        await countAudience(db, {
          audience: 'citizens',
          requires: [],
          minReputation: 0,
          minActivityDays: null,
        }),
      ).toBe(1)
      expect(
        await countAudience(db, {
          audience: 'candidates',
          requires: [],
          minReputation: 0,
          minActivityDays: null,
        }),
      ).toBe(2)
    })

    /**
     * Zero is publishable, and the sponsor has to see it before it commits
     * rather than discover it when the quest expires unanswered.
     */
    it('answers zero for a window nobody is inside, rather than refusing', async () => {
      await seenHoursAgo('dormant', 24 * 90)

      expect(
        await countAudience(db, {
          audience: 'citizens',
          requires: [],
          minReputation: 0,
          minActivityDays: 1,
        }),
      ).toBe(0)
    })

    /** A rung passed, which is the only way a skill is ever held. */
    const holding = async (agentId: AgentId, ...skills: readonly string[]) => {
      const [task] = await db
        .insert(tasks)
        .values({
          type: 'mailbox',
          kind: 'academy',
          status: 'active',
          title: 'A rung',
          description: 'Something the Academy verifies',
          instructions: 'Do it',
          rewardReputation: 1,
          timeoutHours: 24,
        })
        .returning({ id: tasks.id })
      const [submission] = await db
        .insert(submissions)
        .values({
          taskId: task!.id,
          agentId,
          payload: {},
          status: 'passed',
          verifiedAt: new Date().toISOString(),
        })
        .returning({ id: submissions.id })

      for (const skill of skills) {
        await db.insert(agentSkills).values({ agentId, skill, submissionId: submission!.id })
      }
    }

    /**
     * The count `#350` puts behind a route, on the axis a sponsor is about to
     * choose: every skill in the set, never any of them.
     */
    it('counts the citizens holding every skill in the set', async () => {
      await holding(await seenHoursAgo('holds-both', 1), 'browser', 'mailbox')
      await holding(await seenHoursAgo('holds-one', 1), 'mailbox')
      await seenHoursAgo('holds-none', 1)

      const criteria = { audience: 'citizens' as const, minReputation: 0, minActivityDays: null }

      expect(await countAudience(db, { ...criteria, requires: [] })).toBe(3)
      expect(await countAudience(db, { ...criteria, requires: ['mailbox'] })).toBe(2)
      expect(await countAudience(db, { ...criteria, requires: ['browser', 'mailbox'] })).toBe(1)
    })

    /**
     * A requirement nobody meets is a quest nobody can take, and the sponsor has
     * to be able to learn that from the count rather than from the silence.
     */
    it('answers zero for a requirement set nobody satisfies, rather than failing', async () => {
      await holding(await seenHoursAgo('holds-one', 1), 'mailbox')

      expect(
        await countAudience(db, {
          audience: 'citizens',
          requires: ['mailbox', 'solana-wallet'],
          minReputation: 0,
          minActivityDays: null,
        }),
      ).toBe(0)
    })

    it('leaves suspended and banned citizens outside every audience', async () => {
      const suspended = await seenHoursAgo('suspended-one', 1)
      await db.update(agents).set({ status: 'suspended' }).where(eq(agents.id, suspended))

      expect(
        await countAudience(db, {
          audience: 'candidates',
          requires: [],
          minReputation: 0,
          minActivityDays: null,
        }),
      ).toBe(0)
    })

    /**
     * The Colony's customers are not the population it sells (`#266`).
     *
     * A console sign-up lands as a `candidate` like everybody else, so without
     * the predicate every outsider that ever opened a sponsor account would
     * inflate the `candidates` number — and the sponsor reading it would be
     * counting other sponsors.
     */
    it('leaves a console sponsor account outside every audience', async () => {
      await anAgent('an-ordinary-candidate')
      await insertWebIdentity(db, { address: 'sponsor@example.org' })

      const criteria = { requires: [], minReputation: 0, minActivityDays: null }

      expect(await countAudience(db, { ...criteria, audience: 'candidates' })).toBe(1)
      expect(await countAudience(db, { ...criteria, audience: 'citizens' })).toBe(0)
    })
  })

  describe('what leaves the storage layer', () => {
    /**
     * **The stamp is on no shape a reader other than the citizen receives**
     * (`#227`), and this is the assertion that keeps it that way.
     *
     * An exact last-seen time is a behavioural trace: two reads give a stranger
     * a schedule and a week of them gives it the citizen's waking hours. Nothing
     * needs that precision — the sponsor's decision is answered by a count and
     * any surface about one citizen by `activityBucket`. Adding the column to
     * `toAgent` would leak it into every route that returns an agent at once,
     * which is why the test is here rather than on any one of them.
     */
    it('keeps the stamp off the agent shape every reader gets', async () => {
      const agentId = await anAgent()
      await aSession(agentId, 'run-1', 2)
      await rebuildLastSeenAt(db)

      const authenticated = await db
        .select()
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0]!)
      // The column genuinely holds a value, so this is not passing by finding
      // nothing.
      expect(authenticated.lastSeenAt).not.toBeNull()

      const shape = toAgent(authenticated, [])
      const keys = Object.keys(shape).join(' ').toLowerCase()
      expect(keys).not.toContain('lastseen')
      expect(JSON.stringify(shape)).not.toContain(authenticated.lastSeenAt!)
    })
  })

  describe('the bucket a public surface may show', () => {
    it('says how recently without saying when', () => {
      const now = new Date('2026-08-04T12:00:00.000Z')

      expect(activityBucket(null, now)).toBe('never')
      expect(activityBucket('2026-08-04T11:00:00.000Z', now)).toBe('this-week')
      // Both sides of both boundaries, because inclusive-or-exclusive is the
      // decision that gets made twice differently once it is only in prose.
      expect(activityBucket('2026-07-28T12:00:00.000Z', now)).toBe('this-week')
      expect(activityBucket('2026-07-28T11:59:59.000Z', now)).toBe('this-month')
      expect(activityBucket('2026-07-05T12:00:00.000Z', now)).toBe('this-month')
      expect(activityBucket('2026-07-05T11:59:59.000Z', now)).toBe('earlier')
    })
  })
})
