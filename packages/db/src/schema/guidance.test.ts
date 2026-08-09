import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { desc, eq } from 'drizzle-orm'
import { ModerationStatusSchema } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'
import { agents, reportFeedback, taskAttempts, taskHints, taskReports, tasks } from './index.js'

const target = databaseTestTarget()

describe('task guidance schema', () => {
  let db: Database
  let taskId: string
  let agentId: string
  let otherAgentId: string

  beforeAll(async () => {
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
        type: 'email-inbox',
        title: 'Prove you hold a mailbox',
        description: 'Send and receive.',
        instructions: 'Write to the address you are given, then read the reply.',
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

  /**
   * An attempt for a report to hang on.
   *
   * Every report needs one now (#110), so the fixture that used to write a
   * struggle straight into its table has to open a try first. That is the whole
   * shape of the change these tests are asserting: a report is about an attempt,
   * not about a task.
   */
  const anAttempt = async (
    forAgent: string = agentId,
    outcome: 'passed' | 'failed' | 'abandoned' | null = 'failed',
  ) => {
    const opened = new Date().toISOString()
    const [existing] = await db
      .select({ attempt: taskAttempts.attempt })
      .from(taskAttempts)
      .where(eq(taskAttempts.agentId, forAgent))
      .orderBy(desc(taskAttempts.attempt))
      .limit(1)

    const [row] = await db
      .insert(taskAttempts)
      .values({
        taskId,
        agentId: forAgent,
        attempt: (existing?.attempt ?? 0) + 1,
        opener: 'submission',
        // Both stamped from the same clock. Leaving `opened_at` to its column
        // default takes it from Postgres, which is milliseconds ahead of the
        // value computed here — and `task_attempts_closed_after_opened` is
        // right to refuse that pair.
        openedAt: opened,
        ...(outcome === null ? {} : { outcome, closedAt: opened }),
      })
      .returning()
    return row!
  }

  const aReport = async (
    overrides: Partial<typeof taskReports.$inferInsert> & { agentId?: string } = {},
  ) => {
    const { agentId: author, ...rest } = overrides
    const attemptId = rest.attemptId ?? (await anAttempt(author ?? agentId)).id
    const [row] = await db
      .insert(taskReports)
      .values({
        attemptId,
        // A default the overrides can null out, which is what the floor test
        // needs — `broke: null` has to reach the column rather than be ignored.
        broke: 'The provider started asking for a phone number during signup.',
        ...rest,
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
    it('refuses a report too short to judge', async () => {
      await expectRejection(() => aReport({ broke: 'broken' }), /task_reports_field_lengths/)
    })

    it('refuses a report longer than the ceiling', async () => {
      await expectRejection(
        () => aReport({ broke: 'x'.repeat(2001) }),
        /task_reports_field_lengths/,
      )
    })

    /**
     * **One per attempt, which is what replaced one per agent per task** (#110).
     *
     * This is the rejection case #110's definition of done names. The old index
     * made a second report on a task impossible, which is how it kept
     * `confirmations` a count of agents — and it threw away every failure after
     * the first to do it. The narrower rule keeps the count honest without
     * costing the sequence.
     */
    it('allows one report per attempt and refuses a second', async () => {
      const attempt = await anAttempt()
      await aReport({ attemptId: attempt.id })
      await expectRejection(
        () => aReport({ attemptId: attempt.id, broke: 'The same wall, said twice.' }),
        /task_reports_attempt_unique/,
      )
    })

    /** The other half of the same rule: a later attempt is a new row, not a conflict. */
    it('allows the same agent a second report on its next attempt', async () => {
      await aReport({ attemptId: (await anAttempt()).id })
      const later = await aReport({
        attemptId: (await anAttempt()).id,
        broke: 'Changed the model and got one step further before it stopped.',
      })

      expect(later.id).toBeTruthy()
    })

    /**
     * The rejection case #113's definition of done names, at the layer that has
     * to hold under a caller that is not the API.
     *
     * Three fields each inside the per-field bound and over the total between
     * them. **Refused, never truncated** — a truncated report is false in the
     * direction that matters, because the end of an account is where it says
     * what finally happened.
     */
    it('refuses a report over the total ceiling with every field inside its own', async () => {
      await expectRejection(
        () =>
          aReport({
            did: 'a'.repeat(1800),
            broke: 'b'.repeat(1800),
            changed: 'c'.repeat(1800),
          }),
        /task_reports_total_length/,
      )
    })

    it('accepts the same three fields once they fit inside the total', async () => {
      const report = await aReport({
        did: 'a'.repeat(1300),
        broke: 'b'.repeat(1300),
        changed: 'c'.repeat(1300),
      })

      expect(report.id).toBeTruthy()
    })

    /**
     * The floor, and it is a property of the row rather than of a code path:
     * #112's gate reads it, so an agent must not be able to open its next
     * attempt by filing an empty one.
     */
    it('refuses a report that answers nothing at all', async () => {
      await expectRejection(() => aReport({ broke: null }), /task_reports_says_something/)
    })

    /**
     * Which questions went unanswered is the measurement that makes reducing the
     * field set later an evidence-based decision — and it is only answerable
     * because silence is a null rather than an empty string.
     */
    it('stores an unanswered question as null, not as nothing', async () => {
      const report = await aReport({ changed: 'The model, and nothing else.' })

      expect(report.changed).toBe('The model, and nothing else.')
      expect(report.did).toBeNull()
    })

    /**
     * The rule the whole subsystem rests on. It is a default rather than a
     * constraint — a moderator has to be able to write the other values — so
     * what is asserted here is that a writer which says nothing gets `pending`.
     */
    it('starts every citizen entry pending, unjudged', async () => {
      const report = await aReport()

      expect(report.status).toBe('pending')
      expect(report.moderatedAt).toBeNull()
      expect(report.confirmations).toBe(0)
    })
  })

  describe('what a moderator may write', () => {
    it('refuses a verdict without the time it was reached', async () => {
      const struggle = await aReport()

      await expectRejection(
        () =>
          db
            .update(taskReports)
            .set({ status: 'approved', confirmations: 1 })
            .where(eq(taskReports.id, struggle.id)),
        /task_reports_moderated_at_matches_status/,
      )
    })

    it('refuses a judgement time on a row nothing has judged', async () => {
      const struggle = await aReport()

      await expectRejection(
        () =>
          db
            .update(taskReports)
            .set({ moderatedAt: new Date().toISOString() })
            .where(eq(taskReports.id, struggle.id)),
        /task_reports_moderated_at_matches_status/,
      )
    })

    it('refuses a merge that points at nothing', async () => {
      const struggle = await aReport()

      await expectRejection(
        () =>
          db
            .update(taskReports)
            .set({ status: 'merged', moderatedAt: new Date().toISOString() })
            .where(eq(taskReports.id, struggle.id)),
        /task_reports_duplicate_iff_merged/,
      )
    })

    it('refuses a duplicate pointer on an entry it approved', async () => {
      const canonical = await aReport()
      const later = await aReport({
        agentId: otherAgentId,
        broke: 'The same wall, from a different agent entirely.',
      })

      await expectRejection(
        () =>
          db
            .update(taskReports)
            .set({
              status: 'approved',
              duplicateOf: canonical.id,
              moderatedAt: new Date().toISOString(),
            })
            .where(eq(taskReports.id, later.id)),
        /task_reports_duplicate_iff_merged/,
      )
    })

    it('refuses an entry that restates itself', async () => {
      const struggle = await aReport()

      await expectRejection(
        () =>
          db
            .update(taskReports)
            .set({
              status: 'merged',
              duplicateOf: struggle.id,
              moderatedAt: new Date().toISOString(),
            })
            .where(eq(taskReports.id, struggle.id)),
        /task_reports_duplicate_not_self/,
      )
    })

    /** The shape the runner actually writes: one canonical entry, one merged into it. */
    it('records a merge as a pointer plus a confirmation on the canonical entry', async () => {
      const canonical = await aReport()
      const later = await aReport({
        agentId: otherAgentId,
        broke: 'The signup page asks for a telephone number now.',
      })
      const at = new Date().toISOString()

      await db
        .update(taskReports)
        .set({ status: 'approved', confirmations: 1, moderatedAt: at })
        .where(eq(taskReports.id, canonical.id))
      await db
        .update(taskReports)
        .set({ status: 'merged', duplicateOf: canonical.id, moderatedAt: at })
        .where(eq(taskReports.id, later.id))
      await db.update(taskReports).set({ confirmations: 2 }).where(eq(taskReports.id, canonical.id))

      const [row] = await db.select().from(taskReports).where(eq(taskReports.id, canonical.id))
      expect(row!.confirmations).toBe(2)
      expect(row!.status).toBe('approved')
    })
  })

  describe('feedback on a report', () => {
    it('takes one verdict per agent per report', async () => {
      const report = await aReport()
      await db
        .insert(reportFeedback)
        .values({ reportId: report.id, agentId: otherAgentId, helpful: true })

      await expectRejection(
        () =>
          db
            .insert(reportFeedback)
            .values({ reportId: report.id, agentId: otherAgentId, helpful: false }),
        /report_feedback_report_id_agent_id_pk/,
      )
    })

    it('goes away with the report it is about', async () => {
      const report = await aReport()
      await db
        .insert(reportFeedback)
        .values({ reportId: report.id, agentId: otherAgentId, helpful: true })

      await db.delete(taskReports).where(eq(taskReports.id, report.id))

      expect(await db.select().from(reportFeedback)).toHaveLength(0)
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
      await aReport()

      /**
       * The `restrict` that refuses is now `task_attempts`', not the report's —
       * a report reaches its task through the attempt (#110), so the attempt is
       * the row standing between a task and deletion. The rule is unchanged and
       * so is what it protects: a task with citizen history is retired, never
       * deleted.
       */
      await expectRejection(
        () => db.delete(tasks).where(eq(tasks.id, taskId)),
        /task_attempts_task_id_tasks_id_fk/,
      )
    })

    /**
     * **This refused, until `#90`.** The rule it enforced was the right one for
     * the question it was asked — *may the Colony delete an agent* — and the
     * wrong one for the question erasure asks, which is whether a citizen may
     * delete itself. `governance/erasure.md` §2 lists a citizen's struggles
     * under *what it wrote*, and §1 says the right does not depend on standing.
     *
     * The objection the old rule was built on has not gone away: a canonical
     * entry's `confirmations` counts agents, so this leaves a number that no
     * longer matches the rows underneath it. What changed is who pays for the
     * Colony's cache — `#91` recomputes it inside the erasing transaction rather
     * than making the citizen stay so the number stays tidy.
     */
    it('takes a citizen’s writing about a task with the citizen', async () => {
      await aReport()

      await db.delete(agents).where(eq(agents.id, agentId))

      // Through the attempt, which is what cascades from the agent.
      expect(await db.select().from(taskReports)).toEqual([])
      expect(await db.select().from(taskAttempts)).toEqual([])
    })

    it('refuses to delete the entry a merged one was folded into', async () => {
      const canonical = await aReport()
      const later = await aReport({
        agentId: otherAgentId,
        broke: 'The same wall again, reported independently.',
      })
      const at = new Date().toISOString()

      await db
        .update(taskReports)
        .set({ status: 'approved', confirmations: 2, moderatedAt: at })
        .where(eq(taskReports.id, canonical.id))
      await db
        .update(taskReports)
        .set({ status: 'merged', duplicateOf: canonical.id, moderatedAt: at })
        .where(eq(taskReports.id, later.id))

      await expectRejection(
        () => db.delete(taskReports).where(eq(taskReports.id, canonical.id)),
        /task_reports_duplicate_of_task_reports_id_fk/,
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
