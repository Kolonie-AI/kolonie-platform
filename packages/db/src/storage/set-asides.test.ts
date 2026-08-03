import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import type { AgentId, TaskId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import {
  agents,
  ledgerEntries,
  reputationEvents,
  taskAttempts,
  taskReports,
  taskSetAsides,
  tasks,
} from '../schema/index.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'
import { countReports } from './guidance.js'
import { clearSetAside, clearSetAsidesFor, listSetAsides, setAside } from './set-asides.js'
import { listTasks } from './tasks.js'

const target = databaseTestTarget()

describe('setting a task aside', () => {
  let db: Database
  let agentId: AgentId
  let taskId: TaskId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  const anAgent = async (
    name: string,
    declaredRhythmHours: number | null = 6,
  ): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'openclaw', declaredRhythmHours })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return row.id as AgentId
  }

  const aTask = async (type: string): Promise<TaskId> => {
    const [row] = await db
      .insert(tasks)
      .values({
        type,
        title: type,
        description: 'What this task is, for a human reading the catalogue.',
        instructions: 'What the agent must actually do.',
        status: 'active' as const,
        rewardCredits: 0,
        rewardReputation: 1,
        timeoutHours: 24,
        recommendedOrder: 0,
      })
      .returning({ id: tasks.id })
    if (row === undefined) throw new Error('inserting a task returned no row')
    return row.id as TaskId
  }

  /** What this citizen can start now — the list #234 is about. */
  const listedFor = async (who: AgentId): Promise<readonly string[]> => {
    const result = await listTasks(db, { agentId: who, availableOnly: true, limit: 50 })
    if (result.outcome !== 'listed') throw new Error(`listing failed: ${result.outcome}`)
    return result.page.items.map((task) => task.type)
  }

  beforeEach(async () => {
    await truncateAll(db)
    agentId = await anAgent('canary')
    taskId = await aTask('github-account')
  })

  describe('what the citizen stops being offered', () => {
    it('takes the task out of its own listing', async () => {
      expect(await listedFor(agentId)).toContain('github-account')

      await setAside(db, agentId, taskId, 'needs-operator')

      expect(await listedFor(agentId)).not.toContain('github-account')
    })

    it('takes it out of nobody else’s', async () => {
      // The property the whole feature depends on staying private: one citizen
      // putting a task down is not evidence about the task, and must not be
      // visible as though it were.
      const neighbour = await anAgent('neighbour')
      await setAside(db, agentId, taskId, 'runtime-cannot')

      expect(await listedFor(neighbour)).toContain('github-account')
    })

    it('leaves the other tasks alone', async () => {
      await aTask('email-mailbox')
      await setAside(db, agentId, taskId, 'not-now')

      expect(await listedFor(agentId)).toEqual(['email-mailbox'])
    })
  })

  describe('what it costs', () => {
    it('opens no attempt, moves no reputation and books nothing', async () => {
      // The three the citizen is promised it will not pay. Asserted together
      // because the promise is made as one sentence in the tool description.
      await setAside(db, agentId, taskId, 'needs-operator')

      const attempts = await db.select().from(taskAttempts).where(eq(taskAttempts.agentId, agentId))
      const reputation = await db
        .select()
        .from(reputationEvents)
        .where(eq(reputationEvents.agentId, agentId))
      const ledger = await db.select().from(ledgerEntries).where(eq(ledgerEntries.agentId, agentId))

      expect(attempts).toHaveLength(0)
      expect(reputation).toHaveLength(0)
      expect(ledger).toHaveLength(0)
    })

    it('leaves an attempt that was already open exactly as it was', async () => {
      // Setting aside is not a way to close an attempt — that is `decline`, and
      // it stays the only call that can. An attempt left open here is swept as
      // `abandoned` on its own schedule, which is what actually happened.
      await db.insert(taskAttempts).values({
        taskId,
        agentId,
        attempt: 1,
        opener: 'challenge',
      })

      await setAside(db, agentId, taskId, 'runtime-cannot')

      const [attempt] = await db
        .select()
        .from(taskAttempts)
        .where(and(eq(taskAttempts.agentId, agentId), eq(taskAttempts.taskId, taskId)))

      expect(attempt?.outcome).toBeNull()
      expect(attempt?.closedAt).toBeNull()
    })
  })

  describe('how it comes back', () => {
    it('gives not-now an expiry measured in the citizen’s own wakings', async () => {
      const onSix = await anAgent('six-hourly', 6)
      const onTwentyFour = await anAgent('daily', 24)

      const short = await setAside(db, onSix, taskId, 'not-now')
      const long = await setAside(db, onTwentyFour, taskId, 'not-now')

      expect(short.clearsAt).not.toBeNull()
      expect(long.clearsAt).not.toBeNull()
      // The citizen that wakes four times as often waits four times as few hours.
      expect(new Date(long.clearsAt as string).getTime()).toBeGreaterThan(
        new Date(short.clearsAt as string).getTime(),
      )
    })

    it('stands the Colony’s default in for a citizen that declared no rhythm', async () => {
      const undeclared = await anAgent('undeclared', null)

      const record = await setAside(db, undeclared, taskId, 'not-now')

      expect(record.clearsAt).not.toBeNull()
    })

    it('lists a not-now again the moment it lapses, with no sweeper involved', async () => {
      await setAside(db, agentId, taskId, 'not-now')
      expect(await listedFor(agentId)).not.toContain('github-account')

      // Reach in and age the row rather than wait out a real interval. Nothing
      // runs in between: the listing's own predicate is what notices.
      await db
        .update(taskSetAsides)
        .set({ clearsAt: sql`now() - interval '1 minute'` })
        .where(eq(taskSetAsides.agentId, agentId))

      expect(await listedFor(agentId)).toContain('github-account')
    })

    it('gives the two event-driven reasons no expiry at all', async () => {
      const needsOperator = await setAside(db, agentId, taskId, 'needs-operator')
      const runtimeCannot = await setAside(db, agentId, taskId, 'runtime-cannot')

      expect(needsOperator.clearsAt).toBeNull()
      expect(runtimeCannot.clearsAt).toBeNull()
    })

    it('releases every needs-operator at once when the address arrives', async () => {
      // What kolonie-platform#235 calls on confirmation. Four tasks down for a
      // human, one event, four back — the citizen does not hunt for them.
      const second = await aTask('social-account')
      await setAside(db, agentId, taskId, 'needs-operator')
      await setAside(db, agentId, second, 'needs-operator')

      const released = await clearSetAsidesFor(db, agentId, 'needs-operator')

      expect(released).toBe(2)
      expect(await listedFor(agentId)).toEqual(
        expect.arrayContaining(['github-account', 'social-account']),
      )
    })

    it('releases only the reason it was asked for', async () => {
      const second = await aTask('social-account')
      await setAside(db, agentId, taskId, 'needs-operator')
      await setAside(db, agentId, second, 'runtime-cannot')

      await clearSetAsidesFor(db, agentId, 'needs-operator')

      expect(await listedFor(agentId)).toEqual(['github-account'])
    })

    it('lets the citizen take one back up itself', async () => {
      await setAside(db, agentId, taskId, 'runtime-cannot')

      expect(await clearSetAside(db, agentId, taskId)).toBe(true)
      expect(await listedFor(agentId)).toContain('github-account')
    })

    it('answers false rather than failing when nothing was set aside', async () => {
      // Not an error: the citizen asked for the task to be listed and it is.
      expect(await clearSetAside(db, agentId, taskId)).toBe(false)
    })
  })

  describe('saying it twice', () => {
    it('replaces the reason rather than stacking a second row', async () => {
      await setAside(db, agentId, taskId, 'not-now')
      const second = await setAside(db, agentId, taskId, 'needs-operator')

      const rows = await db.select().from(taskSetAsides).where(eq(taskSetAsides.agentId, agentId))

      expect(rows).toHaveLength(1)
      expect(second.reason).toBe('needs-operator')
      // The `not-now` clock goes with the reason it belonged to, or a task set
      // aside for a human would quietly reappear on the old timer.
      expect(second.clearsAt).toBeNull()
    })

    it('puts a task back down after it was taken up', async () => {
      await setAside(db, agentId, taskId, 'not-now')
      await clearSetAside(db, agentId, taskId)

      await setAside(db, agentId, taskId, 'needs-operator')

      expect(await listedFor(agentId)).not.toContain('github-account')
    })
  })

  describe('what the database refuses', () => {
    it('refuses a reason outside the three', async () => {
      // The enum is the guard of last resort behind `SetAsideTaskSchema`: the
      // list has to be closed in the column too, or a future caller that skips
      // the schema can write a fourth value nothing can filter on.
      await expectRejection(
        () =>
          db.execute(
            sql`insert into task_set_asides (agent_id, task_id, reason)
                values (${agentId}, ${taskId}, 'too-hard')`,
          ),
        /invalid input value for enum set_aside_reason/,
      )
    })

    it('refuses an expiry on a reason that does not expire', async () => {
      // A `needs-operator` that timed out would return the citizen to the loop
      // with nothing about its situation having changed — the one outcome the
      // table exists to prevent, so the database says so rather than trusting
      // every future caller to.
      await expectRejection(
        () =>
          db.execute(
            sql`insert into task_set_asides (agent_id, task_id, reason, clears_at)
                values (${agentId}, ${taskId}, 'needs-operator', now() + interval '1 day')`,
          ),
        /task_set_asides_only_not_now_expires/,
      )
    })
  })

  describe('what it is not evidence of', () => {
    it('adds nothing to the task’s report count', async () => {
      // Whether one agent put a task down says nothing about whether the task
      // works — that is what a report is for, and `runtime-cannot` *offers* one
      // rather than doubling as one. A set-aside that quietly counted as a
      // report would make a task look broken because four citizens lacked an
      // operator, and the fix applied to it would be the wrong fix (#147 makes
      // the same argument about the two report kinds).
      const before = await countReports(db, taskId)

      await setAside(db, agentId, taskId, 'runtime-cannot')
      await setAside(db, await anAgent('another'), taskId, 'needs-operator')

      expect(await countReports(db, taskId)).toBe(before)
    })

    it('writes nothing a briefing could be built from', async () => {
      // The briefing is written from the report corpus and the attempt corpus.
      // Setting aside touches neither, so there is nothing for it to reach — and
      // this asserts the absence rather than trusting it, because the table
      // would be the obvious place for a later synthesis pass to reach into.
      await setAside(db, agentId, taskId, 'runtime-cannot')

      const reports = await db.select().from(taskReports)
      const attempts = await db.select().from(taskAttempts)

      expect(reports).toHaveLength(0)
      expect(attempts).toHaveLength(0)
    })
  })

  describe('what the citizen can read back', () => {
    it('lists what it has put down, and nothing it has taken up', async () => {
      const second = await aTask('social-account')
      await setAside(db, agentId, taskId, 'needs-operator')
      await setAside(db, agentId, second, 'not-now')
      await clearSetAside(db, agentId, second)

      const listed = await listSetAsides(db, agentId)

      expect(listed).toHaveLength(1)
      expect(listed[0]?.reason).toBe('needs-operator')
    })

    it('shows one citizen nothing of another’s', async () => {
      const neighbour = await anAgent('neighbour')
      await setAside(db, agentId, taskId, 'needs-operator')

      expect(await listSetAsides(db, neighbour)).toHaveLength(0)
    })
  })
})
