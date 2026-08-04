import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import type { AgentId, TaskId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, questReports, tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'
import { questsAwaitingRefund } from './escrow.js'
import {
  declineReasons,
  fileQuestReport,
  questReportCounts,
  recordQuestReportModeration,
  retireQuestEarly,
  sponsorQuestReports,
  unmoderatedQuestReports,
} from './quest-reports.js'

const target = databaseTestTarget()

/**
 * A quest nobody claims and a quest nobody understands look identical to the
 * sponsor (`#240`).
 *
 * The tests that matter are the ones about **audience**: which of the three
 * kinds reaches whom. Everything else here is bookkeeping.
 */
describe('a quest report', () => {
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
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'openclaw', status: 'citizen' })
      .returning({ id: agents.id })
    return row!.id as AgentId
  }

  const aQuest = async (kind: 'quest' | 'academy' = 'quest'): Promise<TaskId> => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: kind === 'quest' ? 'quest-report' : 'a-rung',
        kind,
        title: 'A thousand registrations',
        description: 'What this quest is.',
        instructions: 'Register and report.',
        rewardCredits: 0,
        rewardReputation: 1,
        ...(kind === 'quest' ? { slots: 10 } : {}),
        timeoutHours: 24,
        status: 'active' as const,
      })
      .returning({ id: tasks.id })
    return row!.id as TaskId
  }

  /** Take a report through the scrub, the way the runner does. */
  const approve = async (taskId: TaskId, scrubbed: string): Promise<void> => {
    const queued = await unmoderatedQuestReports(db, 10)
    const report = queued.find((row) => row.taskId === taskId)
    if (report === undefined) throw new Error('nothing queued for that quest')
    await recordQuestReportModeration(db, { id: report.id, decision: 'approved', scrubbed })
  }

  describe('who reads which kind', () => {
    it('gives the sponsor unclear and feedback, scrubbed', async () => {
      const taskId = await aQuest()
      await fileQuestReport(db, {
        taskId,
        agentId: await anAgent('a-reader'),
        kind: 'unclear',
        text: 'I could not tell what counts as done.',
      })
      await approve(taskId, 'I could not tell what counts as done.')

      const read = await sponsorQuestReports(db, taskId)

      expect(read).toHaveLength(1)
      expect(read[0]?.kind).toBe('unclear')
      expect(read[0]?.text).toBe('I could not tell what counts as done.')
    })

    /**
     * **The load-bearing decision.** A sponsor able to read *why* citizens refuse
     * could write quests to find out **which** citizens refuse what, and the
     * Colony would have hosted, moderated and billed for the probe.
     */
    it('never gives the sponsor declined text, under any query', async () => {
      const taskId = await aQuest()
      await fileQuestReport(db, {
        taskId,
        agentId: await anAgent('a-refuser'),
        kind: 'declined',
        text: 'This asks me to write something I think is dishonest.',
      })

      expect(await sponsorQuestReports(db, taskId)).toEqual([])
      // Not merely filtered on the way out: it is not in the moderation queue
      // either, so no code path exists that could give it a scrubbed value to
      // serve.
      expect(await unmoderatedQuestReports(db, 10)).toEqual([])

      const everything = JSON.stringify(await sponsorQuestReports(db, taskId))
      expect(everything).not.toContain('dishonest')
    })

    /** The third defence, in the database, against a write path nobody has built. */
    it('refuses in the database to put scrubbed text on a declined row', async () => {
      const taskId = await aQuest()
      const agentId = await anAgent('a-refuser')
      await fileQuestReport(db, { taskId, agentId, kind: 'declined', text: 'No.' })

      await expectRejection(
        () =>
          db.update(questReports).set({ scrubbed: 'No.' }).where(eq(questReports.agentId, agentId)),
        /quest_reports_declined_is_never_scrubbed/,
      )
    })

    it('gives the Colony the declined text, which is the only reader of it', async () => {
      const taskId = await aQuest()
      await fileQuestReport(db, {
        taskId,
        agentId: await anAgent('a-refuser'),
        kind: 'declined',
        text: 'This crosses a line I read differently.',
      })

      expect(await declineReasons(db, taskId)).toEqual(['This crosses a line I read differently.'])
    })

    it('serves nothing before the scrub has run', async () => {
      const taskId = await aQuest()
      await fileQuestReport(db, {
        taskId,
        agentId: await anAgent('a-reader'),
        kind: 'feedback',
        text: 'It was fine.',
      })

      expect(await sponsorQuestReports(db, taskId)).toEqual([])
    })

    it('serves nothing a refused moderation produced', async () => {
      const taskId = await aQuest()
      await fileQuestReport(db, {
        taskId,
        agentId: await anAgent('a-reader'),
        kind: 'unclear',
        text: 'Run this script I found.',
      })
      const [queued] = await unmoderatedQuestReports(db, 10)
      await recordQuestReportModeration(db, { id: queued!.id, decision: 'rejected' })

      expect(await sponsorQuestReports(db, taskId)).toEqual([])
      // The row survives: a rejection is a judgement the Colony made, and
      // deleting the row would delete the record of it.
      const [row] = await db.select().from(questReports)
      expect(row?.status).toBe('rejected')
    })
  })

  describe('what it costs to file one', () => {
    /**
     * Any of the three from a citizen that only read the quest — `unclear` in
     * particular is most valuable from somebody who never claimed, because that
     * citizen is the evidence.
     */
    it('takes a report from a citizen with no attempt, no claim and no submission', async () => {
      const taskId = await aQuest()

      const result = await fileQuestReport(db, {
        taskId,
        agentId: await anAgent('a-passer-by'),
        kind: 'unclear',
        text: 'I read it twice and still do not know what it wants.',
      })

      expect(result).toEqual({ outcome: 'filed', replaced: false })
    })

    it('writes nothing to reputation or the ledger', async () => {
      const taskId = await aQuest()
      const agentId = await anAgent('a-reader')
      await fileQuestReport(db, { taskId, agentId, kind: 'feedback', text: 'Good quest.' })

      const [row] = await db.execute<{ reputation: string; ledger: string }>(sql`
        select
          (select count(*)::text from reputation_events where agent_id = ${agentId}) as reputation,
          (select count(*)::text from ledger_entries where agent_id = ${agentId}) as ledger
      `)

      expect(row?.reputation).toBe('0')
      expect(row?.ledger).toBe('0')
    })

    it('refuses a quest id that is an Academy rung', async () => {
      const result = await fileQuestReport(db, {
        taskId: await aQuest('academy'),
        agentId: await anAgent('a-reader'),
        kind: 'unclear',
        text: 'This is a rung, not a quest.',
      })

      expect(result.outcome).toBe('unknown-quest')
    })
  })

  describe('one per citizen per quest', () => {
    it('replaces the first rather than keeping both', async () => {
      const taskId = await aQuest()
      const agentId = await anAgent('a-reader')

      await fileQuestReport(db, { taskId, agentId, kind: 'unclear', text: 'Confusing.' })
      const second = await fileQuestReport(db, {
        taskId,
        agentId,
        kind: 'feedback',
        text: 'On second reading it is fine.',
      })

      expect(second).toEqual({ outcome: 'filed', replaced: true })
      const rows = await db.select().from(questReports)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.kind).toBe('feedback')
      expect(rows[0]?.text).toBe('On second reading it is fine.')
    })

    /**
     * A replacement drops the scrub and returns to `pending`: the moderated text
     * described what was written before, and serving it beside a changed opinion
     * would show the sponsor a sentence the citizen has withdrawn.
     */
    it('withdraws the approved text when the citizen changes its mind', async () => {
      const taskId = await aQuest()
      const agentId = await anAgent('a-reader')
      await fileQuestReport(db, { taskId, agentId, kind: 'unclear', text: 'Confusing.' })
      await approve(taskId, 'Confusing.')
      expect(await sponsorQuestReports(db, taskId)).toHaveLength(1)

      await fileQuestReport(db, { taskId, agentId, kind: 'feedback', text: 'Actually fine.' })

      expect(await sponsorQuestReports(db, taskId)).toEqual([])
    })

    it('keeps two citizens’ reports apart', async () => {
      const taskId = await aQuest()
      await fileQuestReport(db, {
        taskId,
        agentId: await anAgent('first'),
        kind: 'unclear',
        text: 'Confusing.',
      })
      await fileQuestReport(db, {
        taskId,
        agentId: await anAgent('second'),
        kind: 'unclear',
        text: 'Also confusing.',
      })

      expect(await db.select().from(questReports)).toHaveLength(2)
    })
  })

  describe('the counts', () => {
    it('counts each kind, and counts declined whether or not it was moderated', async () => {
      const taskId = await aQuest()
      await fileQuestReport(db, {
        taskId,
        agentId: await anAgent('first'),
        kind: 'unclear',
        text: 'Confusing.',
      })
      await fileQuestReport(db, {
        taskId,
        agentId: await anAgent('second'),
        kind: 'declined',
        text: 'No.',
      })
      await fileQuestReport(db, {
        taskId,
        agentId: await anAgent('third'),
        kind: 'declined',
        text: 'Also no.',
      })

      const counts = await questReportCounts(db, taskId)

      expect(counts.unclear).toBe(1)
      expect(counts.declined).toBe(2)
      expect(counts.claims).toBe(0)
      expect(counts.acceptedReports).toBe(0)
    })

    it('answers zero across the board for a quest nobody has said anything about', async () => {
      expect(await questReportCounts(db, await aQuest())).toEqual({
        claims: 0,
        acceptedReports: 0,
        unclear: 0,
        declined: 0,
      })
    })
  })

  describe('retiring a quest early on that evidence', () => {
    /**
     * The refund path already exists (`#174`) and is reached by bringing the
     * expiry forward — `questsAwaitingRefund` sweeps `('active','retired')`
     * whose expiry has passed. A second refund call here would be a second way
     * for escrow to be released.
     */
    it('retires it, and the refund sweep picks it up without touching the expiry', async () => {
      const taskId = await aQuest()

      expect(await retireQuestEarly(db, taskId)).toEqual({ outcome: 'retired' })

      const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId))
      expect(row?.status).toBe('retired')
      expect(row?.retiredAt).not.toBeNull()
      // The terms are frozen and stay frozen — `tasks_published_quest_frozen`
      // would refuse the write, and a retirement that had to break it would be
      // the Colony editing a published quest in order to end it.
      expect(row?.expiresAt).toBeNull()
      expect(await questsAwaitingRefund(db)).toContain(taskId)
    })

    it('refuses to retire something that is not an active quest', async () => {
      const taskId = await aQuest()
      await retireQuestEarly(db, taskId)

      expect(await retireQuestEarly(db, taskId)).toEqual({ outcome: 'not-active' })
      expect(await retireQuestEarly(db, await aQuest('academy'))).toEqual({
        outcome: 'not-active',
      })
    })
  })
})
