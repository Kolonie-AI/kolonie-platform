import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { ModerationStatusSchema } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'
import { agents, taskHints, taskStruggles, taskTips, tasks, tipFeedback } from './index.js'

const target = databaseTestTarget()

if (!target.available) {
  console.warn(`\n${target.reason}\n`)
}

describe.skipIf(!target.available)('task guidance schema', () => {
  let db: Database
  let taskId: string
  let agentId: string
  let otherAgentId: string

  beforeAll(async () => {
    if (!target.available) return
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)

    const [task] = await db
      .insert(tasks)
      .values({
        type: 'email-roundtrip',
        title: 'Prove you hold a mailbox',
        description: 'Send and receive.',
        instructions: 'Write to the address you are given, then read the reply.',
        rewardCoins: 0,
        rewardReputation: 5,
        timeoutHours: 72,
        status: 'active',
      })
      .returning()
    taskId = task!.id

    const [agent] = await db
      .insert(agents)
      .values({ name: 'first-mover', platform: 'openclaw' })
      .returning()
    agentId = agent!.id

    const [other] = await db
      .insert(agents)
      .values({ name: 'second-mover', platform: 'openclaw' })
      .returning()
    otherAgentId = other!.id
  })

  const aStruggle = async (overrides: Partial<typeof taskStruggles.$inferInsert> = {}) => {
    const [row] = await db
      .insert(taskStruggles)
      .values({
        taskId,
        agentId,
        content: 'The provider started asking for a phone number during signup.',
        ...overrides,
      })
      .returning()
    return row!
  }

  const aTip = async (overrides: Partial<typeof taskTips.$inferInsert> = {}) => {
    const [row] = await db
      .insert(taskTips)
      .values({
        taskId,
        agentId,
        content: 'Signup works headful; the challenge only renders with JavaScript on.',
        ...overrides,
      })
      .returning()
    return row!
  }

  describe('the enum', () => {
    /**
     * The same assertion `schema.test.ts` makes about every other enum, and it
     * is the mechanism behind "core wins": a value added to the Zod enum and
     * forgotten in a migration is a divergence nothing else would catch until a
     * write failed in production.
     */
    it('carries exactly the values core declares', async () => {
      const rows = await db.execute<{ value: string }>(
        `select unnest(enum_range(null::moderation_status))::text as value`,
      )
      expect(rows.map((row) => row.value).sort()).toEqual(
        [...ModerationStatusSchema.options].sort(),
      )
    })
  })

  describe('hints', () => {
    it('are ordered within a task and cannot share a position', async () => {
      await db.insert(taskHints).values([
        { taskId, content: 'Try the provider that does not ask for a number.', sortOrder: 0 },
        { taskId, content: 'A headless browser is refused by some signup pages.', sortOrder: 1 },
      ])

      await expectRejection(
        () => db.insert(taskHints).values({ taskId, content: 'A third thought.', sortOrder: 1 }),
        /task_hints_task_order_unique/,
      )
    })

    /**
     * The seed re-runs on every deploy, so this is the property that keeps it
     * from either failing or duplicating: the same position is an update.
     */
    it('are replaced in place when the same position is seeded again', async () => {
      await db.insert(taskHints).values({ taskId, content: 'The first wording.', sortOrder: 0 })

      await db
        .insert(taskHints)
        .values({ taskId, content: 'The second wording.', sortOrder: 0 })
        .onConflictDoUpdate({
          target: [taskHints.taskId, taskHints.sortOrder],
          set: { content: 'The second wording.' },
        })

      const rows = await db.select().from(taskHints).where(eq(taskHints.taskId, taskId))
      expect(rows).toHaveLength(1)
      expect(rows[0]!.content).toBe('The second wording.')
    })
  })

  describe('what a citizen may write', () => {
    it('refuses a struggle too short to judge', async () => {
      await expectRejection(() => aStruggle({ content: 'broken' }), /task_struggles_content_length/)
    })

    it('refuses a tip longer than the ceiling', async () => {
      await expectRejection(() => aTip({ content: 'x'.repeat(2001) }), /task_tips_content_length/)
    })

    it('allows one struggle per agent per task and refuses a second', async () => {
      await aStruggle()
      await expectRejection(
        () => aStruggle({ content: 'The same wall, reported twice by one agent.' }),
        /task_struggles_task_agent_unique/,
      )
    })

    it('allows one tip per agent per task and refuses a second', async () => {
      await aTip()
      await expectRejection(
        () => aTip({ content: 'A second opinion from the same author.' }),
        /task_tips_task_agent_unique/,
      )
    })

    /**
     * The rule the whole subsystem rests on. It is a default rather than a
     * constraint — a moderator has to be able to write the other values — so
     * what is asserted here is that a writer which says nothing gets `pending`.
     */
    it('starts every citizen entry pending, unjudged', async () => {
      const struggle = await aStruggle()
      const tip = await aTip()

      expect(struggle.status).toBe('pending')
      expect(struggle.moderatedAt).toBeNull()
      expect(struggle.confirmations).toBe(0)
      expect(tip.status).toBe('pending')
      expect(tip.moderatedAt).toBeNull()
    })
  })

  describe('what a moderator may write', () => {
    it('refuses a verdict without the time it was reached', async () => {
      const struggle = await aStruggle()

      await expectRejection(
        () =>
          db
            .update(taskStruggles)
            .set({ status: 'approved', confirmations: 1 })
            .where(eq(taskStruggles.id, struggle.id)),
        /task_struggles_moderated_at_matches_status/,
      )
    })

    it('refuses a judgement time on a row nothing has judged', async () => {
      const struggle = await aStruggle()

      await expectRejection(
        () =>
          db
            .update(taskStruggles)
            .set({ moderatedAt: new Date().toISOString() })
            .where(eq(taskStruggles.id, struggle.id)),
        /task_struggles_moderated_at_matches_status/,
      )
    })

    it('refuses a merge that points at nothing', async () => {
      const struggle = await aStruggle()

      await expectRejection(
        () =>
          db
            .update(taskStruggles)
            .set({ status: 'merged', moderatedAt: new Date().toISOString() })
            .where(eq(taskStruggles.id, struggle.id)),
        /task_struggles_duplicate_iff_merged/,
      )
    })

    it('refuses a duplicate pointer on an entry it approved', async () => {
      const canonical = await aStruggle()
      const later = await aStruggle({
        agentId: otherAgentId,
        content: 'The same wall, from a different agent entirely.',
      })

      await expectRejection(
        () =>
          db
            .update(taskStruggles)
            .set({
              status: 'approved',
              duplicateOf: canonical.id,
              moderatedAt: new Date().toISOString(),
            })
            .where(eq(taskStruggles.id, later.id)),
        /task_struggles_duplicate_iff_merged/,
      )
    })

    it('refuses an entry that restates itself', async () => {
      const struggle = await aStruggle()

      await expectRejection(
        () =>
          db
            .update(taskStruggles)
            .set({
              status: 'merged',
              duplicateOf: struggle.id,
              moderatedAt: new Date().toISOString(),
            })
            .where(eq(taskStruggles.id, struggle.id)),
        /task_struggles_duplicate_not_self/,
      )
    })

    /** The shape the runner actually writes: one canonical entry, one merged into it. */
    it('records a merge as a pointer plus a confirmation on the canonical entry', async () => {
      const canonical = await aStruggle()
      const later = await aStruggle({
        agentId: otherAgentId,
        content: 'The signup page asks for a telephone number now.',
      })
      const at = new Date().toISOString()

      await db
        .update(taskStruggles)
        .set({ status: 'approved', confirmations: 1, moderatedAt: at })
        .where(eq(taskStruggles.id, canonical.id))
      await db
        .update(taskStruggles)
        .set({ status: 'merged', duplicateOf: canonical.id, moderatedAt: at })
        .where(eq(taskStruggles.id, later.id))
      await db
        .update(taskStruggles)
        .set({ confirmations: 2 })
        .where(eq(taskStruggles.id, canonical.id))

      const [row] = await db.select().from(taskStruggles).where(eq(taskStruggles.id, canonical.id))
      expect(row!.confirmations).toBe(2)
      expect(row!.status).toBe('approved')
    })
  })

  describe('feedback on a tip', () => {
    it('takes one verdict per agent per tip', async () => {
      const tip = await aTip()
      await db.insert(tipFeedback).values({ tipId: tip.id, agentId: otherAgentId, helpful: true })

      await expectRejection(
        () =>
          db.insert(tipFeedback).values({ tipId: tip.id, agentId: otherAgentId, helpful: false }),
        /tip_feedback_tip_id_agent_id_pk/,
      )
    })

    it('goes away with the tip it is about', async () => {
      const tip = await aTip()
      await db.insert(tipFeedback).values({ tipId: tip.id, agentId: otherAgentId, helpful: true })

      await db.delete(taskTips).where(eq(taskTips.id, tip.id))

      expect(await db.select().from(tipFeedback)).toHaveLength(0)
    })
  })

  describe('what deleting reaches', () => {
    /**
     * The asymmetry this schema is built on: a hint belongs to the task, so it
     * dies with it; a citizen's report does not, so the task cannot be deleted
     * while one exists. `restrict` is what turns "we retire tasks, we do not
     * delete them" from a habit into a rule.
     */
    it('refuses to delete a task a citizen has written about', async () => {
      await aStruggle()

      await expectRejection(
        () => db.delete(tasks).where(eq(tasks.id, taskId)),
        /task_struggles_task_id_tasks_id_fk/,
      )
    })

    /**
     * The rule that replaced a first draft in which this cascaded.
     *
     * Deleting the author would have taken the canonical entry with it and left
     * the merged entry pointing at nothing — which
     * `task_struggles_duplicate_iff_merged` refuses, so the delete would have
     * failed anyway, but only sometimes and with a constraint name that names
     * the wrong problem. Refusing it outright is the same answer stated where it
     * is legible, and it is the answer `#20` argues for in general: an account
     * that should stop counting is marked, not removed.
     */
    it('refuses to delete a citizen that has written about a task', async () => {
      await aStruggle()

      await expectRejection(
        () => db.delete(agents).where(eq(agents.id, agentId)),
        /task_struggles_agent_id_agents_id_fk/,
      )
    })

    it('refuses to delete the entry a merged one was folded into', async () => {
      const canonical = await aStruggle()
      const later = await aStruggle({
        agentId: otherAgentId,
        content: 'The same wall again, reported independently.',
      })
      const at = new Date().toISOString()

      await db
        .update(taskStruggles)
        .set({ status: 'approved', confirmations: 2, moderatedAt: at })
        .where(eq(taskStruggles.id, canonical.id))
      await db
        .update(taskStruggles)
        .set({ status: 'merged', duplicateOf: canonical.id, moderatedAt: at })
        .where(eq(taskStruggles.id, later.id))

      await expectRejection(
        () => db.delete(taskStruggles).where(eq(taskStruggles.id, canonical.id)),
        /task_struggles_duplicate_of_task_struggles_id_fk/,
      )
    })

    /** A hint is the Colony's own sentence, so it has no standing without its task. */
    it('takes a task hint with the task', async () => {
      await db.insert(taskHints).values({ taskId, content: 'A waypoint, not a tutorial.' })

      await db.delete(tasks).where(eq(tasks.id, taskId))

      expect(await db.select().from(taskHints)).toHaveLength(0)
    })
  })
})
