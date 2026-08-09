import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { QUEST_OBSTACLE_BONUS_DEFAULT_PERCENT, type AgentId, type TaskId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, payoutObligations, questReports, taskAttempts, tasks } from '../schema/index.js'
import {
  connectForTests,
  databaseTestTarget,
  expectRejection,
  truncateAll,
  ledgerCreditsOf,
} from '../testing.js'
import { oweForObstacleBonus } from './payouts.js'
import {
  declineReasons,
  fileQuestReport,
  questObstacleCorpus,
  questReportCounts,
  recordQuestReportModeration,
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

  const aQuest = async (
    kind: 'quest' | 'academy' = 'quest',
    options: { readonly publishObstacles?: boolean } = {},
  ): Promise<TaskId> => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: kind === 'quest' ? 'quest-report' : 'a-rung',
        kind,
        title: 'A thousand registrations',
        description: 'What this quest is.',
        instructions: 'Register and report.',
        rewardReputation: 1,
        ...(kind === 'quest' ? { slots: 10 } : {}),
        ...(options.publishObstacles === undefined
          ? {}
          : { publishObstacles: options.publishObstacles }),
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

  /**
   * **The obstacle travels; the method never does** (`#367`).
   *
   * The first citizen to answer any quest pays the whole cost of discovery and
   * reads nothing. What closes that is publishing where people got stuck — and
   * what makes publishing it safe is that where you stopped is a fact about the
   * world, while how you went about it is the method the sponsor is paying for
   * independence in.
   */
  describe('an obstacle report', () => {
    const anObstacle = async (
      taskId: TaskId,
      agentId: AgentId,
      answers: { did?: string; broke?: string; changed?: string },
    ) => fileQuestReport(db, { taskId, agentId, kind: 'obstacle', ...answers })

    it('takes the three questions and carries no paragraph', async () => {
      const taskId = await aQuest()
      const agentId = await anAgent('answerer')

      const filed = await anObstacle(taskId, agentId, {
        did: 'Worked through the sources in the order they were listed.',
        broke: 'The archive search returns nothing without an account.',
        changed: 'Nothing — this was my first attempt at it.',
      })

      expect(filed.outcome).toBe('filed')
      const [row] = await db
        .select({ text: questReports.text, broke: questReports.broke })
        .from(questReports)
        .where(eq(questReports.taskId, taskId))
      expect(row?.text).toBeNull()
      expect(row?.broke).toContain('archive search')
    })

    /**
     * The rejection case the definition of done asks for, and the two halves are
     * asserted together because separating them would let either pass alone: an
     * obstacle the stage refused is not served, **and** the report still stands
     * and still reaches the sponsor.
     */
    it('serves no obstacle the stage refused, and the report still reaches the sponsor', async () => {
      const taskId = await aQuest()
      const agentId = await anAgent('said-too-much')
      await anObstacle(taskId, agentId, {
        broke: 'Stopped once I had decided the answer is the second option.',
        did: 'Read both and compared them.',
      })

      const [queued] = await unmoderatedQuestReports(db, 10)
      // The sponsor's half clears; the published half does not. That is the
      // proportionate response — the citizen said a little too much about what
      // it concluded, and what it loses is publication rather than the report.
      await recordQuestReportModeration(db, {
        id: queued!.id,
        decision: 'approved',
        scrubbed: 'Read both and compared them.',
      })

      expect(await questObstacleCorpus(db, taskId)).toHaveLength(0)
      expect(await sponsorQuestReports(db, taskId)).toHaveLength(1)
    })

    it('serves the obstacle once the stage has published it', async () => {
      const taskId = await aQuest()
      const agentId = await anAgent('stopped-cleanly')
      await anObstacle(taskId, agentId, {
        broke: 'The archive search returns nothing without an account.',
      })

      const [queued] = await unmoderatedQuestReports(db, 10)
      await recordQuestReportModeration(db, {
        id: queued!.id,
        decision: 'approved',
        scrubbed: 'The archive search returns nothing without an account.',
        publishedObstacle: 'The archive search returns nothing without an account.',
      })

      const corpus = await questObstacleCorpus(db, taskId)
      expect(corpus).toHaveLength(1)
      // One row is one citizen — the unique index makes that true by
      // construction, so a claim's count needs nothing maintaining it.
      expect(corpus[0]?.reports).toBe(1)
      expect(corpus[0]?.kind).toBe('wall')
    })

    /**
     * **The method never travels**, which is the whole of what makes the
     * obstacle publishable. Asserted on the corpus rather than on the column,
     * because the corpus is what a citizen actually reaches.
     */
    it('never puts how it was answered in front of another citizen', async () => {
      const taskId = await aQuest()
      const agentId = await anAgent('method-holder')
      await anObstacle(taskId, agentId, {
        did: 'Read the three sources in the order given and cross-checked them.',
        broke: 'The archive search returns nothing without an account.',
        changed: 'A second model, after the first would not read the tables.',
      })

      const [queued] = await unmoderatedQuestReports(db, 10)
      await recordQuestReportModeration(db, {
        id: queued!.id,
        decision: 'approved',
        scrubbed: 'everything, as the sponsor reads it',
        publishedObstacle: 'The archive search returns nothing without an account.',
      })

      const [entry] = await questObstacleCorpus(db, taskId)
      expect(entry?.content).not.toContain('cross-checked')
      expect(entry?.content).not.toContain('second model')
    })

    /** A rewrite withdraws what was published, immediately. */
    it('stops serving an obstacle its author has replaced', async () => {
      const taskId = await aQuest()
      const agentId = await anAgent('changed-its-mind')
      await anObstacle(taskId, agentId, { broke: 'The archive search needs an account.' })
      const [queued] = await unmoderatedQuestReports(db, 10)
      await recordQuestReportModeration(db, {
        id: queued!.id,
        decision: 'approved',
        scrubbed: 'The archive search needs an account.',
        publishedObstacle: 'The archive search needs an account.',
      })
      expect(await questObstacleCorpus(db, taskId)).toHaveLength(1)

      await anObstacle(taskId, agentId, { broke: 'On reflection it was the login and not that.' })

      expect(await questObstacleCorpus(db, taskId)).toHaveLength(0)
    })

    /**
     * A sponsor may keep its obstacles to itself (`#370`), and this is the whole
     * of what that means: the briefing stops, and nothing else does.
     *
     * **Asserted against the same fixture as the published case**, one field
     * apart, because the interesting claim is not that a suppressed quest serves
     * nothing — it is that everything else is identical.
     */
    it('serves no briefing on a quest whose sponsor kept its obstacles', async () => {
      const taskId = await aQuest('quest', { publishObstacles: false })
      const agentId = await anAgent('stopped-on-a-private-quest')
      await anObstacle(taskId, agentId, {
        did: 'Read the brief and went at the archive.',
        broke: 'The archive search returns nothing without an account.',
        changed: 'Nothing; it was the first attempt.',
      })

      const [queued] = await unmoderatedQuestReports(db, 10)
      // The moderation stage runs unchanged: suppression is about publication,
      // not about whether the Colony looks at what it was sent.
      expect(queued).toBeDefined()
      await recordQuestReportModeration(db, {
        id: queued!.id,
        decision: 'approved',
        scrubbed: 'The archive search returns nothing without an account.',
        publishedObstacle: 'The archive search returns nothing without an account.',
      })

      // The rejection case the definition of done asks for.
      expect(await questObstacleCorpus(db, taskId)).toHaveLength(0)

      // And the sponsor is untouched — it paid for this and still reads it in full.
      const [forSponsor] = await sponsorQuestReports(db, taskId)
      expect(forSponsor?.text).toBe('The archive search returns nothing without an account.')
    })

    it('publishes on a quest that said nothing about it, because the default is published', async () => {
      const taskId = await aQuest()
      const agentId = await anAgent('stopped-on-an-ordinary-quest')
      await anObstacle(taskId, agentId, { broke: 'The archive search needs an account.' })
      const [queued] = await unmoderatedQuestReports(db, 10)
      await recordQuestReportModeration(db, {
        id: queued!.id,
        decision: 'approved',
        scrubbed: 'The archive search needs an account.',
        publishedObstacle: 'The archive search needs an account.',
      })

      expect(await questObstacleCorpus(db, taskId)).toHaveLength(1)
    })

    /**
     * **The front-runner problem is a payment problem** (`#371`). The first
     * citizen to answer pays the whole cost of discovery, reads nothing, and
     * hands the benefit to everybody after it. These are the tests that the
     * compensation lands and that it lands nowhere else.
     */
    describe('what a published obstacle pays', () => {
      const aPaidQuest = async (
        credits: number,
        options: { readonly publishObstacles?: boolean } = {},
      ): Promise<{ taskId: TaskId; sponsorId: AgentId }> => {
        const sponsorId = await anAgent(`sponsor-${credits}-${String(options.publishObstacles)}`)
        const [row] = await db
          .insert(tasks)
          .values({
            type: 'quest-report',
            kind: 'quest',
            title: 'A thousand registrations',
            description: 'What this quest is.',
            instructions: 'Register and report.',
            rewardLamports: credits,
            rewardReputation: 1,
            slots: 10,
            createdBy: sponsorId,
            ...(options.publishObstacles === undefined
              ? {}
              : { publishObstacles: options.publishObstacles }),
            timeoutHours: 24,
            status: 'active' as const,
            // The share this quest was published at (`#632`). Written, because a
            // null on a published row means *before the column existed* and is
            // read as the legacy half — which the last test in this block is
            // about.
            obstacleBonusPercent: QUEST_OBSTACLE_BONUS_DEFAULT_PERCENT,
          })
          .returning({ id: tasks.id })
        const taskId = row!.id as TaskId

        // **No escrow and no sponsor balance** (`#553` phase C). The bonus is
        // paid out of the invoice the sponsor settled in SOL, and what this
        // test needs is a priced quest — which the insert above already is.

        return { taskId, sponsorId }
      }

      /**
       * The attempt the bonus pays for (`#632`).
       *
       * Every citizen in this block tried the quest and hit a wall, which is the
       * case the bonus exists for. The one that did not is its own test at the
       * end, because *published and unpaid* is now a real and correct outcome.
       */
      const anAttempt = async (taskId: TaskId, agentId: AgentId) => {
        await db.insert(taskAttempts).values({
          agentId,
          taskId,
          attempt: 1,
          opener: 'submission',
          outcome: 'failed',
          openedAt: '2026-08-09T10:00:00.000Z',
          closedAt: '2026-08-09T10:05:00.000Z',
        })
      }

      const publishAnObstacle = async (taskId: TaskId, agentId: AgentId, broke: string) => {
        await anAttempt(taskId, agentId)
        await anObstacle(taskId, agentId, { broke })
        const queued = await unmoderatedQuestReports(db, 10)
        const mine = queued.find((row) => row.broke === broke)
        return await recordQuestReportModeration(db, {
          id: mine!.id,
          decision: 'approved',
          scrubbed: broke,
          publishedObstacle: broke,
        })
      }

      it('pays the first three and nobody after them', async () => {
        const { taskId } = await aPaidQuest(10)

        const paid: number[] = []
        for (const name of ['first', 'second', 'third', 'fourth']) {
          const agentId = await anAgent(`${name}-through`)
          paid.push(await publishAnObstacle(taskId, agentId, `The ${name} wall.`))
        }

        // A quarter of what one answer pays — `floor(10 × 25 / 100)` — to each
        // of the first three (`#632`). The fourth citizen reads what the first
        // three paid for, so the cost this compensates is gone.
        expect(paid).toEqual([2, 2, 2, 0])
      })

      it('owes the author a quarter of what an answer pays', async () => {
        const { taskId } = await aPaidQuest(20)
        const agentId = await anAgent('first-through-alone')

        await publishAnObstacle(taskId, agentId, 'The archive needs an account.')

        const [owed] = await db
          .select()
          .from(payoutObligations)
          .where(eq(payoutObligations.agentId, agentId))

        expect(owed?.kind).toBe('obstacle-bonus')
        expect(owed?.lamports).toBe(5)
        expect(owed?.taskId).toBe(taskId)
        // A bonus has no submission — the second uniqueness rule carries that job.
        expect(owed?.submissionId).toBeNull()
      })

      /**
       * **The rejection case `#632` is about.** The report is filed, moderated
       * and published exactly as any other, and it pays nothing — the bonus is
       * for a citizen that tried and hit a wall, and this one only read.
       */
      it('pays nothing for a published obstacle from a citizen that never attempted', async () => {
        const { taskId } = await aPaidQuest(20)
        const agentId = await anAgent('read-it-and-noticed')

        await anObstacle(taskId, agentId, { broke: 'Nobody whose mailbox cannot send can start.' })
        const queued = await unmoderatedQuestReports(db, 10)
        const mine = queued.find((row) => row.broke?.startsWith('Nobody whose'))
        const paid = await recordQuestReportModeration(db, {
          id: mine!.id,
          decision: 'approved',
          scrubbed: 'Nobody whose mailbox cannot send can start.',
          publishedObstacle: 'Nobody whose mailbox cannot send can start.',
        })

        expect(paid).toBe(0)

        const owed = await db
          .select()
          .from(payoutObligations)
          .where(eq(payoutObligations.agentId, agentId))
        expect(owed).toEqual([])

        // Published all the same: the report is welcome, it is simply not work.
        const corpus = await questObstacleCorpus(db, taskId)
        expect(corpus.map((source) => source.content)).toContain(
          'Nobody whose mailbox cannot send can start.',
        )
      })

      /**
       * A quest published before the column existed was funded at a half, and is
       * paid at a half. Reading it at today's quarter would be the Colony
       * keeping the difference on a deal that was already struck.
       */
      it('pays a legacy quest at the share it was funded at', async () => {
        const { taskId } = await aPaidQuest(20)
        await db.update(tasks).set({ obstacleBonusPercent: null }).where(eq(tasks.id, taskId))

        const agentId = await anAgent('answered-a-legacy-quest')
        const paid = await publishAnObstacle(taskId, agentId, 'The old wall.')

        expect(paid).toBe(10)
      })

      /** And the author is told, at the moment it files, rather than by silence. */
      it('tells an author with no attempt that the report is welcome and unpaid', async () => {
        const { taskId } = await aPaidQuest(20)
        const readOnly = await anAgent('filed-without-trying')
        const tried = await anAgent('filed-after-trying')
        await anAttempt(taskId, tried)

        expect(
          await fileQuestReport(db, {
            taskId,
            agentId: readOnly,
            kind: 'obstacle',
            broke: 'I could not start.',
          }),
        ).toMatchObject({ outcome: 'filed', earnsBonus: false })

        expect(
          await fileQuestReport(db, {
            taskId,
            agentId: tried,
            kind: 'obstacle',
            broke: 'I got as far as the form.',
          }),
        ).toMatchObject({ outcome: 'filed', earnsBonus: true })
      })

      /** The rejection case: moderation refused it, so it bought nobody anything. */
      it('pays nothing for a report moderation rejected', async () => {
        const { taskId } = await aPaidQuest(10)
        const agentId = await anAgent('refused-report')
        await anObstacle(taskId, agentId, { broke: 'I stopped because of the answer.' })
        const [queued] = await unmoderatedQuestReports(db, 10)

        const paid = await recordQuestReportModeration(db, {
          id: queued!.id,
          decision: 'rejected',
        })

        expect(paid).toBe(0)
        expect(await ledgerCreditsOf(db, agentId)).toBe(0)
      })

      /** And nothing for one the stage approved but did not publish. */
      it('pays nothing when the obstacle itself was withheld', async () => {
        const { taskId } = await aPaidQuest(10)
        const agentId = await anAgent('approved-but-unpublished')
        await anObstacle(taskId, agentId, {
          did: 'Read both and compared them.',
          broke: 'Stopped once I had decided the answer.',
        })
        const [queued] = await unmoderatedQuestReports(db, 10)

        const paid = await recordQuestReportModeration(db, {
          id: queued!.id,
          decision: 'approved',
          scrubbed: 'Read both and compared them.',
        })

        expect(paid).toBe(0)
      })

      /** A sponsor that publishes nothing owes nothing, and held no pool (`#370`). */
      it('pays nothing on a quest whose sponsor kept its obstacles', async () => {
        const { taskId } = await aPaidQuest(10, { publishObstacles: false })
        const agentId = await anAgent('stopped-privately')

        const paid = await publishAnObstacle(taskId, agentId, 'The archive needs an account.')

        expect(paid).toBe(0)
      })

      it('pays nothing on a quest whose answers pay too little to halve', async () => {
        const { taskId } = await aPaidQuest(1)
        const agentId = await anAgent('one-credit-quest')

        expect(await publishAnObstacle(taskId, agentId, 'The archive needs an account.')).toBe(0)
      })

      /**
       * **The boundary `#371` asks to be asserted rather than assumed.** On an
       * Academy rung a report pays nothing and never will: a rung is the
       * Colony's own work and it can afford to ask for the account of it as a
       * gift.
       */
      it('pays nothing on an Academy rung, which is a different kind of work', async () => {
        const taskId = await aQuest('academy')
        const agentId = await anAgent('rung-reporter')

        // Twice over, and the first is the stronger of the two: an obstacle
        // report cannot be filed against a rung at all — `fileQuestReport` reads
        // `tasks` with `kind = 'quest'` and answers `unknown-quest`.
        expect(
          (await anObstacle(taskId, agentId, { broke: 'The page would not load.' })).outcome,
        ).toBe('unknown-quest')

        // And if one ever reached the payment path anyway, it is refused there
        // too. This is the assertion `#371` asks for by name: a report costs
        // nothing and earns nothing on an Academy rung.
        const owed = await db.transaction(
          async (tx) => await oweForObstacleBonus(tx, { taskId, agentId, lamports: 5 }),
        )

        // It is refused before this, by the caller's three conditions — and if
        // one ever reached here anyway, the amount is still what it is worth,
        // which is why the assertion that matters is the one above about the
        // Academy rung never getting this far.
        expect(owed).toBe(5)
      })
    })

    /**
     * The three kinds that were here first keep their readers and their routing,
     * which is an acceptance criterion of `#367` and the thing a fourth kind is
     * most likely to break.
     */
    it('leaves the three existing kinds exactly where they were', async () => {
      const taskId = await aQuest()
      await fileQuestReport(db, {
        taskId,
        agentId: await anAgent('unclear-reporter'),
        kind: 'unclear',
        text: 'I cannot tell which of two things it is asking for.',
      })
      await fileQuestReport(db, {
        taskId,
        agentId: await anAgent('declining-reporter'),
        kind: 'declined',
        text: 'I will not do this, on conscience grounds.',
      })

      const queued = await unmoderatedQuestReports(db, 10)
      // `declined` never enters the queue, exactly as before.
      expect(queued).toHaveLength(1)
      await recordQuestReportModeration(db, {
        id: queued[0]!.id,
        decision: 'approved',
        scrubbed: 'I cannot tell which of two things it is asking for.',
      })

      expect((await sponsorQuestReports(db, taskId)).map((row) => row.kind)).toEqual(['unclear'])
      expect(await declineReasons(db, taskId)).toHaveLength(1)
      // And no obstacle briefing came out of any of it.
      expect(await questObstacleCorpus(db, taskId)).toHaveLength(0)
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

      expect(result).toMatchObject({ outcome: 'filed', replaced: false })
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

      expect(second).toMatchObject({ outcome: 'filed', replaced: true })
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

  /**
   * **The tests for `retireQuestEarly` stood here and moved with it** (`#619`).
   *
   * The counts above are still exactly the evidence a steward ends a quest on;
   * what changed is that ending one is `endQuest` in `quests/write.ts`, which
   * records who ended it and why and refuses everybody but the sponsor and a
   * steward. Its tests are in `quests.test.ts` beside the rest of the write
   * path, which is where the reader of this file should look.
   */
})
