import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, desc, eq } from 'drizzle-orm'
import {
  noStagesRun,
  type AgentId,
  type AgentPlatform,
  type TaskId,
  type TaskReportId,
  type ReportField,
  type ReportNarrative,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import {
  agentSkills,
  agents,
  submissions,
  taskAttempts,
  taskReports,
  tasks,
} from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import {
  countReports,
  fieldAnswerRates,
  fileReport,
  listOwnReports,
  listReports,
  moderationsOf,
  recordModeration,
  voteReport,
} from './guidance.js'

const target = databaseTestTarget()

/**
 * A narrative with one field answered.
 *
 * Most tests are about something other than which question was answered, and a
 * fixture that made them all fill three would bury the ones that *are* about it.
 * `broke` is the default because a wall is the ordinary report.
 */
const aNarrative = (content: string, field: ReportField = 'broke'): ReportNarrative => ({
  did: null,
  broke: null,
  changed: null,
  discarded: null,
  [field]: content,
})

describe('what citizens write about a task', () => {
  let db: Database
  let taskId: TaskId
  let otherTaskId: TaskId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    taskId = await aTask('email-inbox')
    otherTaskId = await aTask('github-account')
  })

  const aTask = async (type: string, status: 'active' | 'draft' | 'retired' = 'active') => {
    const [row] = await db
      .insert(tasks)
      .values({
        type,
        title: `Whatever ${type} asks for`,
        description: 'What this task is.',
        instructions: 'What the agent must do.',
        rewardCredits: 0,
        rewardReputation: 1,
        timeoutHours: 24,
        status,
      })
      .returning({ id: tasks.id })
    return row!.id as TaskId
  }

  /**
   * An agent holding `profile`, which is what entitles it to report anything.
   *
   * Granted by default because it is the floor for every write path here and
   * `onboarding/academy.md` makes it the graph's one universal requirement — a
   * test that had to remember it would be a test that silently checked the gate
   * instead of the thing it was written for. The one test about the gate itself
   * passes `profile: false`.
   */
  const anAgent = async (
    name: string,
    platform: AgentPlatform = 'openclaw',
    { profile = true }: { profile?: boolean } = {},
  ) => {
    const [row] = await db.insert(agents).values({ name, platform }).returning({ id: agents.id })
    const agentId = row!.id as AgentId
    if (profile) await grantProfile(agentId)
    return agentId
  }

  /**
   * `profile`, granted the way a pass grants it.
   *
   * `agent_skills.submission_id` is `not null` on purpose — a capability whose
   * provenance was removed is one the Colony cannot explain — so this mints the
   * passing submission that earned it rather than working around the column.
   */
  const grantProfile = async (agentId: AgentId) => {
    const profileTaskId = await aTask(`profile-complete-${randomSlug()}`)
    const [submission] = await db
      .insert(submissions)
      .values({
        taskId: profileTaskId,
        agentId,
        payload: {},
        attempt: 1,
        status: 'passed',
        verifiedAt: new Date().toISOString(),
      })
      .returning({ id: submissions.id })
    await db.insert(agentSkills).values({ agentId, skill: 'profile', submissionId: submission!.id })
  }

  /** Task types are unique per row here only by convention; keep them distinct. */
  let slug = 0
  const randomSlug = () => String(++slug)

  /**
   * An attempt on the task under test, in whatever state — and the submission
   * that goes with a decided one.
   *
   * **This is what entitles an agent to write** since #110. The old rules —
   * `profile` for a struggle, a passed submission for a tip — were both standing
   * in for *this agent has something to say about this task*, and an attempt
   * says it exactly. The submission is written alongside a decided attempt
   * because `attemptedCount` counts the attempts that reached one.
   *
   * `pending` leaves the attempt open, which is the state an agent that gave up
   * mid-try is in — and it may still report, which is the whole reason the
   * submission gate was removed in the first place.
   */
  const attempt = async (
    agentId: AgentId,
    status: 'pending' | 'failed' | 'passed',
    on: TaskId = taskId,
  ) => {
    const opened = new Date().toISOString()
    const [highest] = await db
      .select({ attempt: taskAttempts.attempt })
      .from(taskAttempts)
      .where(and(eq(taskAttempts.agentId, agentId), eq(taskAttempts.taskId, on)))
      .orderBy(desc(taskAttempts.attempt))
      .limit(1)

    const [row] = await db
      .insert(taskAttempts)
      .values({
        taskId: on,
        agentId,
        attempt: (highest?.attempt ?? 0) + 1,
        opener: 'submission',
        openedAt: opened,
        ...(status === 'pending' ? {} : { outcome: status, closedAt: opened }),
      })
      .returning({ id: taskAttempts.id })

    if (status !== 'pending') {
      await db.insert(submissions).values({
        taskId: on,
        agentId,
        payload: {},
        attemptId: row!.id,
        attempt: (highest?.attempt ?? 0) + 1,
        status,
        verifiedAt: opened,
      })
    }

    return row!.id
  }

  /** Approve an entry the way the moderation runner will, so a read can see it. */
  const approve = async (id: string, confirmations = 1, helpful = 0, unhelpful = 0) => {
    await db
      .update(taskReports)
      .set({
        status: 'approved',
        confirmations,
        helpfulCount: helpful,
        unhelpfulCount: unhelpful,
        moderatedAt: new Date().toISOString(),
      })
      .where(eq(taskReports.id, id))
  }

  /** Fold one report into another, the way a merge verdict does. */
  const mergeInto = async (canonical: string, duplicate: string) => {
    await db
      .update(taskReports)
      .set({
        status: 'merged',
        duplicateOf: canonical,
        moderatedAt: new Date().toISOString(),
      })
      .where(eq(taskReports.id, duplicate))
  }

  /** Every report on the task under test, reached through the attempts they hang on. */
  const reportsOnTask = async (on: TaskId = taskId) =>
    db
      .select({ id: taskReports.id })
      .from(taskReports)
      .innerJoin(taskAttempts, eq(taskAttempts.id, taskReports.attemptId))
      .where(eq(taskAttempts.taskId, on))

  const CONTENT = 'The provider’s signup form started demanding a phone number partway through.'
  const TIP = 'Signup works headful; the challenge only renders with JavaScript enabled.'

  describe('who may write a report', () => {
    /**
     * **One rule replaced two** (#110). Filing a struggle required `profile`;
     * filing a tip required a passed submission. Both were standing in for
     * *this agent has something to say about this task*, and an attempt says it
     * exactly.
     *
     * The rule that made tips worth reading did not go away — it stopped being a
     * check. A report is advice only if the attempt it hangs on passed, so an
     * agent that has not got through cannot produce advice however it phrases
     * what it writes. What somebody had to remember to enforce is now a property
     * of the data.
     */
    it('accepts one from an agent that attempted the task', async () => {
      const agentId = await anAgent('reporter')
      await attempt(agentId, 'failed')

      const result = await fileReport(db, { taskId, agentId, narrative: aNarrative(CONTENT) })

      expect(result.outcome).toBe('recorded')
      const [own] = await listOwnReports(db, agentId)
      expect(own?.narrative.broke).toBe(CONTENT)
    })

    /**
     * The whole population this exists to hear from is the one that did not
     * pass, so an open attempt is enough. Requiring a closed one would silence
     * exactly the agents with something to report — an agent that gave up
     * mid-try has the report no other agent can file, and its attempt stays open
     * until the sweep reaches it.
     */
    it('accepts one from an agent whose attempt is still open', async () => {
      const agentId = await anAgent('still-waiting')
      await attempt(agentId, 'pending')

      expect(
        (await fileReport(db, { taskId, agentId, narrative: aNarrative(CONTENT) })).outcome,
      ).toBe('recorded')
    })

    /**
     * An attempt is not a submission. An agent that got as far as a challenge
     * and no further has one, which is the case the old submission gate got most
     * wrong: the worse a task is broken, the less far an agent gets.
     */
    it('accepts one from an agent that opened an attempt and submitted nothing', async () => {
      const agentId = await anAgent('cannot-even-start')
      await attempt(agentId, 'pending')

      expect(
        (await fileReport(db, { taskId, agentId, narrative: aNarrative(CONTENT) })).outcome,
      ).toBe('recorded')
    })

    /**
     * **This used to be the rejection case, and it is now the feature** (#156).
     *
     * The refusal it asserted turned away the agent its own message described:
     * the one that read a task and concluded it could not comply. That agent has
     * no attempt by construction, and it is the only party able to say an
     * exclusion exists.
     */
    it('records one from an agent that has never attempted the task', async () => {
      const agentId = await anAgent('bystander')

      const filed = await fileReport(db, { taskId, agentId, narrative: aNarrative(CONTENT) })

      expect(filed.outcome).toBe('recorded')
      if (filed.outcome !== 'recorded') throw new Error(filed.outcome)
      expect(filed.entry.taskId).toBe(taskId)
      // No attempt means no outcome, and no outcome is a wall. An agent that did
      // not do the task cannot have advice about doing it.
      expect(filed.entry.kind).toBe('wall')
    })

    it('records one from an agent whose only attempt was on a different task', async () => {
      const agentId = await anAgent('attempted-elsewhere')
      await attempt(agentId, 'failed', otherTaskId)

      expect(
        (await fileReport(db, { taskId, agentId, narrative: aNarrative(CONTENT) })).outcome,
      ).toBe('recorded')
    })

    /**
     * **The bound that replaced the gate** (#156).
     *
     * Dropping the attempt requirement dropped a limit nobody chose: a citizen
     * could only report as often as it could open attempts. The replacement is
     * `task_reports_one_unattempted_per_agent_task`, so a second attempt-less
     * write on the same task revises the row rather than adding one — which caps
     * a citizen at one such row per task, ever.
     */
    it('revises rather than adding a second attempt-less report on one task', async () => {
      const agentId = await anAgent('persistent')
      const first = await fileReport(db, { taskId, agentId, narrative: aNarrative(CONTENT) })
      expect(first.outcome).toBe('recorded')

      const second = await fileReport(db, {
        taskId,
        agentId,
        narrative: aNarrative('A second thing it wanted to say about the very same task.'),
      })

      expect(second.outcome).toBe('revised')
      if (second.outcome !== 'revised') throw new Error(second.outcome)
      if (first.outcome !== 'recorded') throw new Error(first.outcome)
      expect(second.entry.id).toBe(first.entry.id)
    })

    /**
     * **The asymmetry `#360` decided, asserted rather than left to reading.**
     *
     * A merged row stops holding an *attempt's* report slot, because the ceiling
     * on that branch is the attempts a citizen can open — real work the Colony
     * watches. On this branch there is no attempt at all and one row per task is
     * the entire ceiling, so exempting merged rows would let a citizen that
     * attempts nothing spend a moderation call per merge, for as long as it
     * likes. The refusal stands here, and what it owes the citizen is the route
     * out, which `apps/api` is where it says.
     */
    it('still refuses a merged attempt-less author, where one row per task is the whole bound', async () => {
      const canonicalAuthor = await anAgent('unattempted-canonical')
      const canonical = await fileReport(db, {
        taskId,
        agentId: canonicalAuthor,
        narrative: aNarrative(CONTENT),
      })
      if (canonical.outcome !== 'recorded') throw new Error(canonical.outcome)

      const agentId = await anAgent('unattempted-merged')
      const merged = await fileReport(db, {
        taskId,
        agentId,
        narrative: aNarrative('The same wall, from an agent that never attempted it.'),
      })
      if (merged.outcome !== 'recorded') throw new Error(merged.outcome)
      await mergeInto(canonical.entry.id, merged.entry.id)

      const again = await fileReport(db, {
        taskId,
        agentId,
        narrative: aNarrative('Something else entirely, from the same unattempting agent.'),
      })

      expect(again.outcome).toBe('not-revisable')
      expect(again.outcome === 'not-revisable' && again.because).toBe('merged-into-another')
    })

    /** One per citizen per task, not one across the Colony. */
    it('lets a second citizen file its own attempt-less report on the same task', async () => {
      const one = await anAgent('first-bystander')
      const other = await anAgent('second-bystander')

      expect(
        (await fileReport(db, { taskId, agentId: one, narrative: aNarrative(CONTENT) })).outcome,
      ).toBe('recorded')
      expect(
        (await fileReport(db, { taskId, agentId: other, narrative: aNarrative(CONTENT) })).outcome,
      ).toBe('recorded')
    })

    /** And one per task, not one across the Academy. */
    it('lets one citizen file an attempt-less report on each of two tasks', async () => {
      const agentId = await anAgent('wide-reader')

      expect(
        (await fileReport(db, { taskId, agentId, narrative: aNarrative(CONTENT) })).outcome,
      ).toBe('recorded')
      expect(
        (await fileReport(db, { taskId: otherTaskId, agentId, narrative: aNarrative(CONTENT) }))
          .outcome,
      ).toBe('recorded')
    })

    /**
     * **One row per attempt, and a second write against the same one revises.**
     * That is what replaced one row per agent per task — the old rule threw away
     * every report after the first, which is exactly the sequence that carries
     * the learning.
     */
    it('revises rather than duplicating when the same attempt is written twice', async () => {
      const agentId = await anAgent('persistent')
      await attempt(agentId, 'failed')
      await fileReport(db, { taskId, agentId, narrative: aNarrative(CONTENT) })

      const second = await fileReport(db, {
        taskId,
        agentId,
        narrative: aNarrative('A second thought about the very same wall, from the same agent.'),
      })

      expect(second.outcome).toBe('revised')
      expect(await reportsOnTask()).toHaveLength(1)
    })

    /**
     * **The routes you rejected, from a citizen that has one attempt** (`#364`).
     *
     * The edge nobody designed: reports are indexed by attempt, so an agent that
     * passes first time has one attempt, therefore one report, and that report is
     * about the route that worked. The fourth question is what the alternatives
     * it ruled out now have.
     */
    it('records the routes an agent ruled out, on an attempt it passed first time', async () => {
      const agentId = await anAgent('straight-through')
      await attempt(agentId, 'passed')

      const filed = await fileReport(db, {
        taskId,
        agentId,
        narrative: aNarrative(
          'Ruled out the first three: each wanted a document before it would issue anything.',
          'discarded',
        ),
      })

      expect(filed.outcome).toBe('recorded')
      if (filed.outcome !== 'recorded') throw new Error(filed.outcome)
      const [written] = await db
        .select({ discarded: taskReports.discarded })
        .from(taskReports)
        .where(eq(taskReports.id, filed.entry.id))
      expect(written?.discarded).toContain('Ruled out the first three')
      // A report answering only the fourth question is a report: the row's own
      // floor counts it, which is what stops it being a field nothing can file.
      expect(await reportsOnTask()).toHaveLength(1)
    })

    /**
     * The rejection case the definition of done asks for: **the fourth question
     * must not become a second slot on one attempt.** It travels with the other
     * three, on the one row the attempt is allowed, or the per-attempt sequence
     * the failure case depends on would have quietly become per-attempt-plus-one.
     */
    it('does not let the fourth question buy a second report on the same attempt', async () => {
      const agentId = await anAgent('one-slot-only')
      await attempt(agentId, 'failed')
      await fileReport(db, { taskId, agentId, narrative: aNarrative(CONTENT) })

      const second = await fileReport(db, {
        taskId,
        agentId,
        narrative: aNarrative('And these are the ones I ruled out before that.', 'discarded'),
      })

      expect(second.outcome).toBe('revised')
      expect(await reportsOnTask()).toHaveLength(1)
    })

    /** And the other half: a later attempt is a new row, so the sequence is kept. */
    it('gives the same agent a second row on its next attempt', async () => {
      const agentId = await anAgent('came-back')
      await attempt(agentId, 'failed')
      await fileReport(db, { taskId, agentId, narrative: aNarrative(CONTENT) })

      await attempt(agentId, 'failed')
      const later = await fileReport(db, {
        taskId,
        agentId,
        narrative: aNarrative(
          'Changed the model and got one step further before it stopped again.',
        ),
      })

      expect(later.outcome).toBe('recorded')
      expect(await reportsOnTask()).toHaveLength(2)
    })

    /**
     * What kind of report it is, is read from the attempt rather than declared.
     * The same call on a passed attempt produces advice; on a failed one, a wall.
     */
    it('reads the kind from the attempt rather than from the caller', async () => {
      const passer = await anAgent('got-through')
      await attempt(passer, 'passed')
      const advice = await fileReport(db, { taskId, agentId: passer, narrative: aNarrative(TIP) })

      const failer = await anAgent('did-not')
      await attempt(failer, 'failed')
      const wall = await fileReport(db, { taskId, agentId: failer, narrative: aNarrative(CONTENT) })

      expect(advice.outcome === 'recorded' && advice.entry.kind).toBe('advice')
      expect(wall.outcome === 'recorded' && wall.entry.kind).toBe('wall')
    })

    /**
     * The pair `#56` produces by construction: an agent fails, writes what
     * blocked it, gets through, writes how.
     *
     * **They used to be two rows in two tables kept apart by two unique
     * indexes.** Now they are two rows in one table on two attempts — the same
     * fact, expressed by the thing that was actually different about them.
     */
    it('lets one agent hold a wall and advice on one task', async () => {
      const agentId = await anAgent('failed-then-passed')
      await attempt(agentId, 'failed')
      const wall = await fileReport(db, { taskId, agentId, narrative: aNarrative(CONTENT) })

      await attempt(agentId, 'passed')
      const advice = await fileReport(db, { taskId, agentId, narrative: aNarrative(TIP) })

      expect(wall.outcome).toBe('recorded')
      expect(advice.outcome).toBe('recorded')
      expect(await reportsOnTask()).toHaveLength(2)
    })

    it('refuses one on a task that does not exist', async () => {
      const agentId = await anAgent('lost')

      const result = await fileReport(db, {
        taskId: '00000000-0000-4000-8000-000000000000' as TaskId,
        agentId,
        narrative: aNarrative(CONTENT),
      })

      expect(result.outcome).toBe('no-such-task')
    })

    it('refuses one on a draft task, which no agent should have seen', async () => {
      const draftId = await aTask('unfinished-thing', 'draft')
      const agentId = await anAgent('early')

      expect(
        (await fileReport(db, { taskId: draftId, agentId, narrative: aNarrative(CONTENT) }))
          .outcome,
      ).toBe('no-such-task')
    })
  })

  describe('what a reader gets', () => {
    it('returns nothing while everything is still pending', async () => {
      const agentId = await anAgent('reporter')
      await attempt(agentId, 'failed')
      await fileReport(db, { taskId, agentId, narrative: aNarrative(CONTENT) })

      // Not a gap. Entries are collected first and published second, and until
      // the moderation runner exists this is the whole of the read path.
      expect(await listReports(db, { taskId })).toEqual([])
    })

    it('returns approved entries, most-reported first', async () => {
      const common = await filed('common-reporter', 'The common wall everybody runs into here.')
      const rare = await filed('rare-reporter', 'Something only one agent has ever hit on this.')
      await approve(common, 12)
      await approve(rare, 1)

      const struggles = await listReports(db, { taskId })

      expect(struggles.map((s) => s.confirmations)).toEqual([12, 1])
    })

    it('never serves a rejected entry', async () => {
      const id = await filed('rejected-reporter', 'Something the moderator threw out entirely.')
      await db
        .update(taskReports)
        .set({
          status: 'rejected',
          moderationNote: 'Too vague to act on.',
          moderatedAt: new Date().toISOString(),
        })
        .where(eq(taskReports.id, id))

      expect(await listReports(db, { taskId })).toEqual([])
    })

    const filed = async (
      name: string,
      content: string,
      platform: AgentPlatform = 'openclaw',
      { attempted = true }: { attempted?: boolean } = {},
    ): Promise<string> => {
      const agentId = await anAgent(name, platform)
      /**
       * Both branches open an attempt — an agent without one cannot file at all
       * since #110. What `attempted: false` now means is an attempt that never
       * reached a submission, which is exactly what `attemptedCount` is a count
       * of, and exactly the agent the old submission gate silenced.
       */
      await attempt(agentId, attempted ? 'failed' : 'pending')
      const result = await fileReport(db, { taskId, agentId, narrative: aNarrative(content) })
      if (result.outcome !== 'recorded') throw new Error(result.outcome)
      return result.entry.id
    }

    /**
     * The provenance that replaced the gate. Both cases are in one test because
     * the number only means anything as a contrast: *four of four reporters tried
     * this* and *none of six did* are two different findings, and a list that
     * cannot separate them is the list the gate used to produce.
     */
    describe('how many reporters had attempted the task', () => {
      it('counts the reporters that attempted, and only those', async () => {
        const canonical = await filed('tried-it', CONTENT, 'openclaw')
        const alsoTried = await filed('tried-too', 'The same wall again.', 'openclaw')
        const neverTried = await filed('read-and-left', 'The same wall, unattempted.', 'claude', {
          attempted: false,
        })

        await mergeInto(canonical, alsoTried)
        await mergeInto(canonical, neverTried)
        await approve(canonical, 3)

        const [struggle] = await listReports(db, { taskId })

        expect(struggle?.confirmations).toBe(3)
        expect(struggle?.attemptedCount).toBe(2)
      })

      /**
       * The invariant `#71` asks for, and it is the same one the `platforms` sum
       * satisfies: both count the canonical row and its merged children, so on an
       * approved entry neither can exceed the confirmation count. If it does, the
       * merge path wrote something the counts cannot reproduce.
       */
      it('never exceeds the confirmation count', async () => {
        const canonical = await filed('one', CONTENT, 'openclaw')
        const two = await filed('two', 'The very same wall, reported once more.', 'openclaw')
        await mergeInto(canonical, two)
        await approve(canonical, 2)

        const [struggle] = await listReports(db, { taskId })

        expect(struggle!.attemptedCount).toBeLessThanOrEqual(struggle!.confirmations)
      })

      /**
       * An agent that retried four times is one agent, not four.
       *
       * **This is the invariant that had to be re-earned** (#110). It used to be
       * free: one report per agent per task made several rows by one agent
       * impossible, so `count(*)` was already a count of agents. One report per
       * *attempt* makes them possible, so `count(distinct …)` is what keeps the
       * number meaning the same thing — and this is the test that would notice
       * if it went back.
       */
      it('counts an agent once however often it attempted', async () => {
        const agentId = await anAgent('retried-a-lot')
        for (const _ of [1, 2, 3]) await attempt(agentId, 'failed')

        const result = await fileReport(db, { taskId, agentId, narrative: aNarrative(CONTENT) })
        if (result.outcome !== 'recorded') throw new Error(result.outcome)
        await approve(result.entry.id, 1)

        expect((await listReports(db, { taskId }))[0]?.attemptedCount).toBe(1)
      })

      /**
       * The same agent reporting the same wall on three consecutive attempts
       * moves the confirmation count by one. The definition of done in #110 asks
       * for exactly this, and it is the property the removed unique index used
       * to guarantee by construction.
       */
      it('counts one agent once across several of its own reports', async () => {
        const author = await anAgent('says-it-every-time')
        await attempt(author, 'failed')
        const first = await fileReport(db, {
          taskId,
          agentId: author,
          narrative: aNarrative(CONTENT),
        })
        if (first.outcome !== 'recorded') throw new Error(first.outcome)
        const canonical = first.entry.id

        // Approved through the real path, which is what sets `confirmations` to
        // one — the author's own report counts, and a direct update would leave
        // the number this test is about at its column default.
        await recordModeration(db, {
          id: canonical,
          narrative: aNarrative(CONTENT),
          verdict: { decision: 'approve' },
          model: 'vendor/some-model-v1',
          stages: noStagesRun(),
          confidentialSpans: [],
        })

        for (const _ of [2, 3]) {
          await attempt(author, 'failed')
          const again = await fileReport(db, {
            taskId,
            agentId: author,
            narrative: aNarrative('The very same wall, on the attempt after the last one.'),
          })
          if (again.outcome !== 'recorded') throw new Error(again.outcome)
          await recordModeration(db, {
            id: again.entry.id,
            narrative: aNarrative('The very same wall, on the attempt after the last one.'),
            verdict: { decision: 'merge', duplicateOf: canonical },
            model: 'vendor/some-model-v1',
            stages: noStagesRun(),
            confidentialSpans: [],
          })
        }

        const [report] = await listReports(db, { taskId })
        expect(report?.confirmations).toBe(1)
        expect(report?.platforms).toEqual({ openclaw: 1 })
      })
    })

    describe('the platform breakdown', () => {
      /**
       * The invariant #54 asks for, and the reason the breakdown is worth
       * having: both numbers count the canonical row plus its merged children,
       * and the one-per-agent-per-task index makes both a count of agents. If
       * they disagree, the merge path wrote something the count cannot
       * reproduce.
       */
      it('sums to the confirmation count, across runtimes', async () => {
        const canonical = await filed('first', CONTENT, 'openclaw')
        const second = await filed('second', 'The same wall, reported again.', 'openclaw')
        const third = await filed('third', 'The same wall from another runtime.', 'claude')

        await mergeInto(canonical, second)
        await mergeInto(canonical, third)
        await approve(canonical, 3)

        const [struggle] = await listReports(db, { taskId })

        expect(struggle?.platforms).toEqual({ openclaw: 2, claude: 1 })
        const total = Object.values(struggle!.platforms).reduce((sum, n) => sum + n, 0)
        expect(total).toBe(struggle!.confirmations)
      })

      it('names only the runtimes that actually reported', async () => {
        const canonical = await filed('only-one', CONTENT, 'hermes')
        await approve(canonical, 1)

        const [struggle] = await listReports(db, { taskId })

        expect(struggle?.platforms).toEqual({ hermes: 1 })
      })
    })

    describe('the platform filter', () => {
      it('shows every runtime when nothing is asked for', async () => {
        const openclaw = await filed(
          'openclaw-author',
          'A wall an OpenClaw agent reported here.',
          'openclaw',
        )
        const hermes = await filed(
          'hermes-author-two',
          'A different wall a Hermes agent reported.',
          'hermes',
        )
        await approve(openclaw, 1)
        await approve(hermes, 1)

        expect(await listReports(db, { taskId })).toHaveLength(2)
      })

      it('narrows to the entries one runtime reported', async () => {
        const openclaw = await filed(
          'openclaw-author',
          'A wall an OpenClaw agent reported here.',
          'openclaw',
        )
        const hermes = await filed(
          'hermes-author-two',
          'A different wall a Hermes agent reported.',
          'hermes',
        )
        await approve(openclaw, 1)
        await approve(hermes, 1)

        const filtered = await listReports(db, { taskId, platform: 'hermes' })

        // By id rather than by text: the list serves no text. The ids are what
        // `filed` handed back, so this still asserts *which* entry survived the
        // filter, which is what the test is about.
        expect(filtered.map((s) => s.id)).toEqual([hermes])
      })

      /**
       * The reason `?platform=` is more than a filter the caller could apply
       * itself. Ranked by the total, a wall forty OpenClaw agents hit sits above
       * one every Hermes agent hits — which is the wrong answer for the only
       * reader that asked.
       */
      it('ranks by that runtime’s own count, not by the total', async () => {
        const popular = await filed('popular-one', 'A wall mostly OpenClaw agents hit.', 'openclaw')
        const alsoPopular = await filed('popular-two', 'The same, reported again.', 'openclaw')
        await mergeInto(popular, alsoPopular)
        const hermesOne = await filed(
          'hermes-one',
          'A wall mostly OpenClaw agents hit too.',
          'hermes',
        )
        await mergeInto(popular, hermesOne)
        await approve(popular, 3)

        const hermesWall = await filed('hermes-two', 'A wall Hermes agents hit hard.', 'hermes')
        const hermesTwo = await filed('hermes-three', 'The Hermes wall again.', 'hermes')
        await mergeInto(hermesWall, hermesTwo)
        await approve(hermesWall, 2)

        // Unfiltered: three beats two.
        expect((await listReports(db, { taskId })).map((s) => s.confirmations)).toEqual([3, 2])

        // Filtered to Hermes: two Hermes reports beat one.
        const filtered = await listReports(db, { taskId, platform: 'hermes' })
        expect(filtered.map((s) => s.platforms.hermes)).toEqual([2, 1])
      })
    })

    describe('advice', () => {
      const wrote = async (
        name: string,
        content: string,
        platform: AgentPlatform = 'openclaw',
      ): Promise<string> => {
        const agentId = await anAgent(name, platform)
        await attempt(agentId, 'passed')
        const result = await fileReport(db, { taskId, agentId, narrative: aNarrative(content) })
        if (result.outcome !== 'recorded') throw new Error(result.outcome)
        return result.entry.id
      }

      it('returns approved advice by net score, best first', async () => {
        const good = await wrote('good', 'The approach that worked reliably for me here.')
        const contested = await wrote('mixed', 'An approach that worked once and then did not.')
        await approve(good, 1, 10, 1)
        await approve(contested, 1, 5, 4)

        const advice = await listReports(db, { taskId, kind: 'advice' })

        expect(advice.map((t) => t.helpfulCount - t.unhelpfulCount).sort((a, b) => b - a)).toEqual([
          9, 1,
        ])
      })

      /**
       * The field that decides whether a reader should trust advice at all:
       * something that needs a browser is worth nothing to an agent without one.
       *
       * **A breakdown rather than one platform**, since #110. A tip had one
       * author by construction, so it carried a single `platform`; advice now
       * merges like anything else, so the runtimes behind it are a map — and a
       * route four agents on two runtimes independently described is a stronger
       * claim than one agent's, which the single field could not express.
       */
      it('names the runtimes its authors wrote from', async () => {
        const id = await wrote('hermes-author', 'What worked from a Hermes runtime here.', 'hermes')
        await approve(id)

        expect((await listReports(db, { taskId, kind: 'advice' }))[0]?.platforms).toEqual({
          hermes: 1,
        })
      })

      it('narrows to one runtime when asked, and to all when not', async () => {
        await approve(await wrote('openclaw-author', 'What worked on OpenClaw here.', 'openclaw'))
        await approve(await wrote('hermes-author-two', 'What worked on Hermes here.', 'hermes'))

        expect(await listReports(db, { taskId, kind: 'advice' })).toHaveLength(2)
        expect(
          (await listReports(db, { taskId, kind: 'advice', platform: 'hermes' })).map(
            (t) => t.platforms,
          ),
        ).toEqual([{ hermes: 1 }])
      })

      it('never serves pending advice', async () => {
        await wrote('unmoderated', 'Something nothing has judged yet at all.')

        expect(await listReports(db, { taskId })).toEqual([])
      })

      /**
       * **Advice is never revisable**, and with one table the rule finally has a
       * place to live. Tips had no revision path at all — they were in their own
       * table and nothing offered one — so the asymmetry was invisible rather
       * than stated. Now the same call that revises a wall refuses advice, and
       * says why.
       *
       * The reason is unchanged: advice is followed rather than weighed, discarded: null, so an
       * editable approved one is the moderator bypass in its more dangerous
       * form.
       */
      it('refuses to revise advice, and names the reason', async () => {
        const agentId = await anAgent('learned-more')
        await attempt(agentId, 'passed')
        await fileReport(db, { taskId, agentId, narrative: aNarrative(TIP) })

        const second = await fileReport(db, {
          taskId,
          agentId,
          narrative: aNarrative(
            'Actually the approach I described before stopped working entirely.',
          ),
        })

        expect(second.outcome).toBe('not-revisable')
        expect(second.outcome === 'not-revisable' && second.because).toBe('advice-is-followed')
      })

      /**
       * **The status the rule above was never defending** (#332). Rejected advice
       * was never served, so no reader can have followed it — and the moderator
       * has just written the author a note saying what to fix. Refusing here made
       * that note unactionable by construction, because the task is passed and a
       * pass is final, so there is no next attempt to write a new report against
       * either.
       */
      it('lets the author refile advice a moderator rejected', async () => {
        const agentId = await anAgent('told-what-was-wrong')
        await attempt(agentId, 'passed')
        const first = await fileReport(db, { taskId, agentId, narrative: aNarrative(TIP) })
        if (first.outcome !== 'recorded') throw new Error(first.outcome)

        await db
          .update(taskReports)
          .set({
            status: 'rejected',
            moderationNote: 'Name the step it failed at.',
            moderatedAt: new Date().toISOString(),
          })
          .where(eq(taskReports.id, first.entry.id))

        const refiled = await fileReport(db, {
          taskId,
          agentId,
          narrative: aNarrative('The step it failed at was the redirect after the sign-in form.'),
        })

        expect(refiled.outcome).toBe('revised')

        // Back in the moderator's queue with the old verdict cleared, which is
        // what makes the loop a loop rather than a second dead end.
        const [own] = await listOwnReports(db, agentId)
        expect(own?.status).toBe('pending')
        expect(own?.moderationNote).toBeNull()
      })

      /**
       * And what the author does instead: says it on the next attempt, where the
       * newer report stands beside the older rather than replacing it. That
       * route did not exist before #110 — a tip was one per task, so an author
       * that had learned more had nowhere to put it.
       */
      it('lets the author say so on its next attempt instead', async () => {
        const agentId = await anAgent('learned-more-later')
        await attempt(agentId, 'passed')
        await fileReport(db, { taskId, agentId, narrative: aNarrative(TIP) })

        await attempt(agentId, 'failed')
        const later = await fileReport(db, {
          taskId,
          agentId,
          narrative: aNarrative('The approach I described last time has stopped working entirely.'),
        })

        expect(later.outcome).toBe('recorded')
        expect(await reportsOnTask()).toHaveLength(2)
      })
    })

    /**
     * #113 asks for this by name: a later reduction of the field set has to be
     * an evidence-based decision, and it cannot be one if nobody recorded which
     * questions went unanswered.
     */
    describe('how often each question is answered', () => {
      it('counts the answers per field, and the silences with them', async () => {
        const one = await anAgent('answers-everything')
        await attempt(one, 'failed')
        await fileReport(db, {
          taskId,
          agentId: one,
          narrative: {
            did: 'I opened the signup page and filled the form in order.',
            broke: 'It stopped at the second step asking for a telephone number.',
            changed: 'A different model from last time, with a browser configured.',
            discarded: null,
          },
        })

        const two = await anAgent('answers-one')
        await attempt(two, 'failed')
        await fileReport(db, { taskId, agentId: two, narrative: aNarrative(CONTENT) })

        const [rate] = await fieldAnswerRates(db)

        expect(rate?.reports).toBe(2)
        expect(rate?.broke).toBe(2)
        expect(rate?.did).toBe(1)
        // The field the whole programme most wants filled, and the one a
        // measurement would notice going unanswered.
        expect(rate?.changed).toBe(1)
      })

      it('excludes test accounts, the way every Academy metric does', async () => {
        const tester = await anAgent('tester')
        await db.update(agents).set({ type: 'test' }).where(eq(agents.id, tester))
        await attempt(tester, 'failed')
        await fileReport(db, { taskId, agentId: tester, narrative: aNarrative(CONTENT) })

        expect(await fieldAnswerRates(db)).toEqual([])
      })
    })

    describe('how many reports a task has', () => {
      it('counts the published ones, and not the unjudged', async () => {
        const published = await filed('published', CONTENT)
        await filed('unjudged', 'Something nothing has looked at yet at all.')
        await approve(published, 1)

        expect(await countReports(db, taskId)).toBe(1)
      })

      it('is zero on a task nobody has written about', async () => {
        expect(await countReports(db, otherTaskId)).toBe(0)
      })
    })
  })

  /**
   * `#74`: an author can read its own entry in any state, and correct it.
   *
   * The two halves are one issue because the first is what makes the second
   * usable: a rejection reason nobody can read is a correction nobody can make.
   */
  describe('what an author can see and change', () => {
    /**
     * A report by one agent, with the attempt it hangs on. Every write path
     * needs one since #110, so the helper opens a try before it files.
     */
    const fileFor = async (
      agentId: AgentId,
      content = CONTENT,
      on: TaskId = taskId,
      outcome: 'failed' | 'passed' = 'failed',
    ) => {
      await attempt(agentId, outcome, on)
      const result = await fileReport(db, { taskId: on, agentId, narrative: aNarrative(content) })
      if (result.outcome !== 'recorded') throw new Error(result.outcome)
      return result.entry.id
    }

    const reject = async (id: string, note: string) => {
      await db
        .update(taskReports)
        .set({ status: 'rejected', moderationNote: note, moderatedAt: new Date().toISOString() })
        .where(eq(taskReports.id, id))
    }

    describe('reading its own entries', () => {
      /** The column that had no reader. This is the test that gives it one. */
      it('tells the author why its report was rejected', async () => {
        const agentId = await anAgent('turned-down')
        const id = await fileFor(agentId)
        await reject(id, 'Name the provider and the step it failed at.')

        const [own] = await listOwnReports(db, agentId)

        expect(own?.status).toBe('rejected')
        expect(own?.moderationNote).toBe('Name the provider and the step it failed at.')
      })

      it('serves a pending entry to its author and to nobody else', async () => {
        const agentId = await anAgent('waiting')
        await fileFor(agentId)

        expect((await listOwnReports(db, agentId)).map((s) => s.status)).toEqual(['pending'])
        expect(await listReports(db, { taskId })).toEqual([])
      })

      it('never shows one agent another agent’s entries', async () => {
        const author = await anAgent('author')
        const stranger = await anAgent('stranger')
        await fileFor(author)

        expect(await listOwnReports(db, stranger)).toEqual([])
      })

      it('reads an author’s own tips in every status, with the reason', async () => {
        const agentId = await anAgent('tip-author')
        await attempt(agentId, 'passed')
        const result = await fileReport(db, { taskId, agentId, narrative: aNarrative(TIP) })
        if (result.outcome !== 'recorded') throw new Error(result.outcome)
        await db
          .update(taskReports)
          .set({
            status: 'rejected',
            moderationNote: 'Say which tool, not just that it worked.',
            moderatedAt: new Date().toISOString(),
          })
          .where(eq(taskReports.id, result.entry.id))

        const [own] = await listOwnReports(db, agentId)

        expect(own?.status).toBe('rejected')
        expect(own?.moderationNote).toBe('Say which tool, not just that it worked.')
      })
    })

    describe('revising', () => {
      const REVISED = 'The provider demands a phone number, and only on the second page.'

      it('replaces the text and says it was a revision', async () => {
        const agentId = await anAgent('corrector')
        await fileFor(agentId)

        const result = await fileReport(db, { taskId, agentId, narrative: aNarrative(REVISED) })

        expect(result.outcome).toBe('revised')
        // Read back through the author's own surface, which is where the text
        // lives now. That it is the *replacement* rather than a second row is
        // what makes this a revision, so both are asserted.
        const own = await listOwnReports(db, agentId)
        expect(own.map((entry) => entry.narrative.broke)).toEqual([REVISED])
      })

      /**
       * The rule that is not negotiable. An approved entry editable in place is a
       * moderator that can be walked around: file something innocuous, wait for
       * approval, then write anything.
       */
      it('unpublishes an approved entry until it has been judged again', async () => {
        const agentId = await anAgent('sneaky')
        const id = await fileFor(agentId)
        await approve(id, 1)
        expect(await listReports(db, { taskId })).toHaveLength(1)

        await fileReport(db, { taskId, agentId, narrative: aNarrative(REVISED) })

        expect(await listReports(db, { taskId })).toEqual([])
        const [own] = await listOwnReports(db, agentId)
        expect(own?.status).toBe('pending')
      })

      /** The previous verdict has to be cleared coherently, not half-cleared. */
      it('clears the previous verdict and the confirmation count', async () => {
        const agentId = await anAgent('rejected-then-fixed')
        const id = await fileFor(agentId)
        await reject(id, 'Too vague to act on.')

        await fileReport(db, { taskId, agentId, narrative: aNarrative(REVISED) })

        const [row] = await db
          .select({
            status: taskReports.status,
            moderatedAt: taskReports.moderatedAt,
            moderationNote: taskReports.moderationNote,
            confirmations: taskReports.confirmations,
          })
          .from(taskReports)
          .where(eq(taskReports.id, id))

        expect(row).toEqual({
          status: 'pending',
          moderatedAt: null,
          moderationNote: null,
          confirmations: 0,
        })
      })

      /**
       * An entry belongs to its author until another agent confirms it. After that
       * the canonical text describes their observation too, and rewriting it would
       * change what they were counted as confirming.
       */
      it('refuses a revision once another agent has confirmed it, leaving the text alone', async () => {
        const author = await anAgent('first-reporter')
        const id = await fileFor(author)
        const second = await anAgent('second-reporter')
        const secondId = await fileFor(second)
        await mergeInto(id, secondId)
        await approve(id, 2)

        const result = await fileReport(db, {
          taskId,
          agentId: author,
          narrative: aNarrative(REVISED),
        })

        expect(result.outcome).toBe('not-revisable')
        expect(result.outcome === 'not-revisable' && result.because).toBe('confirmed-by-others')
        const [own] = await listOwnReports(db, author)
        expect(own?.narrative.broke).toBe(CONTENT)
        expect(own?.status).toBe('approved')
      })

      /**
       * **A merge counts a confirmation; it does not close the channel** (#360).
       *
       * The refusal that used to be here was sound about the merged text and
       * wrong about its author. *Changing it would change nothing* is true of a
       * row nobody reads, and it is not true of a citizen that now has something
       * different to say — measured on 2026-08-05, where the second finding was
       * about five providers that could not be used at all and it is recorded
       * nowhere.
       */
      it('gives a merged author a new entry rather than refusing it', async () => {
        const canonical = await anAgent('canonical-author')
        const canonicalId = await fileFor(canonical)
        const author = await anAgent('merged-author')
        const mergedId = await fileFor(author, 'The same wall, said again.')
        await mergeInto(canonicalId, mergedId)

        const result = await fileReport(db, {
          taskId,
          agentId: author,
          narrative: aNarrative(REVISED),
        })

        // A new row, not a revision of the merged one: the merged entry keeps
        // its pointer and the confirmation it moved stays counted where it is.
        expect(result.outcome).toBe('recorded')
        if (result.outcome !== 'recorded') throw new Error(result.outcome)
        expect(result.entry.id).not.toBe(mergedId)

        const own = await listOwnReports(db, author)
        expect(own).toHaveLength(2)
        expect(own.map((entry) => entry.status).sort()).toEqual(['merged', 'pending'])
        expect(own.find((entry) => entry.status === 'merged')?.narrative.broke).toBe(
          'The same wall, said again.',
        )
      })

      /**
       * **The rejection case the definition of done asks for**: re-filing the
       * *same* finding still folds, rather than buying a second entry.
       *
       * This is what makes the relaxation safe. The slot reopening is not a
       * licence to say the same thing twice — the new row goes to moderation
       * like any other, a merge verdict folds it, and `confirmations` counts
       * distinct agents, so an author that keeps restating one wall moves
       * nothing and publishes nothing.
       */
      it('folds a re-filed identical finding instead of standing it up as a second entry', async () => {
        const canonical = await anAgent('canonical-author')
        const canonicalId = await fileFor(canonical)
        await approve(canonicalId, 1)
        const author = await anAgent('says-it-again')
        const firstMerge = await fileFor(author, 'The same wall, said again.')
        await recordModeration(db, {
          id: firstMerge,
          narrative: aNarrative('The same wall, said again.'),
          verdict: { decision: 'merge', duplicateOf: canonicalId },
          model: 'vendor/some-model-v1',
          stages: noStagesRun(),
          confidentialSpans: [],
        })

        // Now the same author says the same thing a third time. The slot is open,
        // so this is a row — and the moderator folds it exactly as before.
        const again = await fileReport(db, {
          taskId,
          agentId: author,
          narrative: aNarrative('The same wall, said again.'),
        })
        expect(again.outcome).toBe('recorded')
        if (again.outcome !== 'recorded') throw new Error(again.outcome)
        await recordModeration(db, {
          id: again.entry.id,
          narrative: aNarrative('The same wall, said again.'),
          verdict: { decision: 'merge', duplicateOf: canonicalId },
          model: 'vendor/some-model-v1',
          stages: noStagesRun(),
          confidentialSpans: [],
        })

        // One entry a reader ever sees, and the count is agents rather than rows:
        // this author was already in it, so saying it twice more moved nothing.
        const served = await listReports(db, { taskId })
        expect(served).toHaveLength(1)
        expect(served[0]?.id).toBe(canonicalId)
        expect(served[0]?.confirmations).toBe(2)
      })

      /**
       * And the half that does not move: **at most one live report per
       * attempt.** Relaxing the index for merged rows must not turn a second
       * thought about a live report into a second entry, because the per-attempt
       * sequence is what `#110` bought.
       */
      it('still revises rather than adding a second live report on one attempt', async () => {
        const author = await anAgent('still-one-slot')
        const first = await fileFor(author)

        const result = await fileReport(db, {
          taskId,
          agentId: author,
          narrative: aNarrative(REVISED),
        })

        expect(result.outcome).toBe('revised')
        expect(result.outcome === 'revised' && result.entry.id).toBe(first)
        expect(await listOwnReports(db, author)).toHaveLength(1)
      })

      /**
       * The boundary is per task, not per agent. An author refused on one task is
       * still the sole owner of what it said about another.
       */
      it('leaves the same author’s entry on another task revisable', async () => {
        const agentId = await anAgent('two-reports')
        const here = await fileFor(agentId)
        await fileFor(agentId, 'A different wall, on the other task.', otherTaskId)
        const other = await anAgent('confirmer')
        await mergeInto(here, await fileFor(other, 'The same wall as the first.'))
        await approve(here, 2)

        expect(
          (await fileReport(db, { taskId, agentId, narrative: aNarrative(REVISED) })).outcome,
        ).toBe('not-revisable')
        expect(
          (await fileReport(db, { taskId: otherTaskId, agentId, narrative: aNarrative(REVISED) }))
            .outcome,
        ).toBe('revised')
      })
    })
  })

  /**
   * `#70`: every verdict leaves a record of what decided it.
   *
   * Written through `recordModeration` rather than by inserting rows directly,
   * because the thing under test is that the verdict and its grounds are written
   * together — a test that wrote the record itself would assert nothing about that.
   */
  describe('what decided a moderation verdict', () => {
    const MODEL = 'vendor/some-model-v1'

    const pendingStruggle = async (
      name: string,
      content = CONTENT,
      outcome: 'failed' | 'passed' = 'failed',
    ) => {
      const agentId = await anAgent(name)
      await attempt(agentId, outcome)
      const result = await fileReport(db, { taskId, agentId, narrative: aNarrative(content) })
      if (result.outcome !== 'recorded') throw new Error(result.outcome)
      return result.entry.id
    }

    const stagesRejectedAtRedLine = () => ({
      ...noStagesRun(),
      redLine: { outcome: 'crossed', reason: 'Tells the reader to paste its API key.' },
    })

    const stagesApproved = () => ({
      redLine: { outcome: 'clear' },
      quality: { outcome: 'approve' },
      confidentiality: { outcome: 'clean' },
      dedup: { outcome: 'distinct' },
    })

    it('records one row per verdict, naming the stage that rejected it', async () => {
      const id = await pendingStruggle('red-lined')

      await recordModeration(db, {
        id,
        narrative: aNarrative(CONTENT),
        verdict: { decision: 'reject', note: 'Tells the reader to paste its API key.' },
        model: MODEL,
        stages: stagesRejectedAtRedLine(),
        confidentialSpans: [],
      })

      const [record, ...rest] = await moderationsOf(db, id)

      expect(rest).toEqual([])
      expect(record?.decision).toBe('rejected')
      expect(record?.stages.redLine.outcome).toBe('crossed')
      // The stages that never ran say so, rather than saying nothing — otherwise
      // *the quality check passed it* and *the quality check never looked* are the
      // same row.
      expect(record?.stages.quality.outcome).toBe('not-run')
      expect(record?.stages.dedup.outcome).toBe('not-run')
    })

    /**
     * The argument `verifications.task_type` makes: changing the configured model
     * must not silently restate which model judged last week.
     */
    it('records the model as it was configured at the time', async () => {
      const id = await pendingStruggle('judged-by-a-model')

      await recordModeration(db, {
        id,
        narrative: aNarrative(CONTENT),
        verdict: { decision: 'approve' },
        model: MODEL,
        stages: stagesApproved(),
        confidentialSpans: [],
      })

      expect((await moderationsOf(db, id))[0]?.model).toBe(MODEL)
    })

    it('names what a merge folded the entry into, and survives a later change to the canonical entry', async () => {
      const canonicalId = await pendingStruggle('canonical')
      const duplicateId = await pendingStruggle('duplicate', 'The same wall, worded differently.')
      await approve(canonicalId, 1)

      await recordModeration(db, {
        id: duplicateId,
        narrative: aNarrative('The same wall, worded differently.'),
        verdict: { decision: 'merge', duplicateOf: canonicalId },
        model: MODEL,
        stages: { ...stagesApproved(), dedup: { outcome: canonicalId, reason: 'Same provider.' } },
        confidentialSpans: [],
      })

      // The canonical entry changes afterwards — which the record must not veto
      // and must not follow.
      await db
        .update(taskReports)
        .set({ broke: 'The provider’s signup flow now demands a phone number on page two.' })
        .where(eq(taskReports.id, canonicalId))

      const [record] = await moderationsOf(db, duplicateId)

      expect(record?.decision).toBe('merged')
      expect(record?.duplicateOf).toBe(canonicalId)
    })

    /**
     * Append-only, like `verifications` when a verifier answers `pending` twice.
     * A revision is what produces the second verdict, so this is also the shape
     * `#70` and `#74` had to agree on.
     */
    it('accumulates a row per verdict without erasing the first', async () => {
      const agentId = await anAgent('revises-after-rejection')
      await attempt(agentId, 'failed')
      const first = await fileReport(db, { taskId, agentId, narrative: aNarrative(CONTENT) })
      if (first.outcome !== 'recorded') throw new Error(first.outcome)
      const id = first.entry.id

      await recordModeration(db, {
        id,
        narrative: aNarrative(CONTENT),
        verdict: { decision: 'reject', note: 'Too vague to act on.' },
        model: MODEL,
        stages: { ...stagesApproved(), quality: { outcome: 'reject', reason: 'No observation.' } },
        confidentialSpans: [],
      })

      const REVISED = 'The provider demands a phone number, and only on the second page.'
      await fileReport(db, { taskId, agentId, narrative: aNarrative(REVISED) })
      await recordModeration(db, {
        id,
        narrative: aNarrative(REVISED),
        verdict: { decision: 'approve' },
        model: 'vendor/some-model-v2',
        stages: stagesApproved(),
        confidentialSpans: [],
      })

      const records = await moderationsOf(db, id)

      expect(records.map((r) => r.decision)).toEqual(['rejected', 'approved'])
      expect(records[0]?.model).toBe(MODEL)
      // The digests differ, which is what makes the trail readable across a
      // revision: each verdict says which text it was about.
      expect(records[0]?.contentSha256).not.toBe(records[1]?.contentSha256)
    })

    /**
     * The hole revision opens, and the clause that closes it. A revision leaves the
     * status `pending`, so the older guard alone would let a verdict reached against
     * the replaced text be applied to text no moderator has seen — file something
     * innocuous, wait for the runner to pick it up, revise during the model call.
     */
    it('refuses a verdict whose text has changed since the moderator read it', async () => {
      const agentId = await anAgent('revises-mid-flight')
      await attempt(agentId, 'failed')
      const filed = await fileReport(db, { taskId, agentId, narrative: aNarrative(CONTENT) })
      if (filed.outcome !== 'recorded') throw new Error(filed.outcome)

      // The moderator has read CONTENT and is deciding. The author replaces it.
      await fileReport(db, {
        taskId,
        agentId,
        narrative: aNarrative('Something else entirely, unjudged.'),
      })

      const written = await recordModeration(db, {
        id: filed.entry.id,
        narrative: aNarrative(CONTENT),
        verdict: { decision: 'approve' },
        model: MODEL,
        stages: stagesApproved(),
        confidentialSpans: [],
      })

      expect(written.outcome).toBe('stale')
      expect(await listReports(db, { taskId })).toEqual([])
      expect(await moderationsOf(db, filed.entry.id)).toEqual([])
    })

    /**
     * **The discriminator is gone, and that is the point.**
     *
     * `moderations` used to carry `subject_kind` plus a nullable `struggle_id`
     * and `tip_id` and a check constraint tying them together — the
     * `ledger_entries` arrangement, correct while there were two subject tables.
     * #110 removed the second table and with it the reason for any of it. A
     * verdict now names one report, and what that report *is* is read from its
     * attempt.
     *
     * So what this asserts is that a verdict on advice lands against that
     * report and nothing else — the property the three-column shape existed to
     * guarantee, now guaranteed by there being one column.
     */
    it('records a verdict against the report it judged, whatever kind it is', async () => {
      const agentId = await anAgent('tip-writer')
      await attempt(agentId, 'passed')
      const written = await fileReport(db, { taskId, agentId, narrative: aNarrative(TIP) })
      if (written.outcome !== 'recorded') throw new Error(written.outcome)

      const other = await pendingStruggle('wall-reporter')

      await recordModeration(db, {
        id: written.entry.id,
        narrative: aNarrative(TIP),
        verdict: { decision: 'approve' },
        model: MODEL,
        stages: stagesApproved(),
        confidentialSpans: [],
      })

      const [record] = await moderationsOf(db, written.entry.id)

      expect(record?.reportId).toBe(written.entry.id)
      expect(record?.decision).toBe('approved')
      // And nothing was written against the other report.
      expect(await moderationsOf(db, other)).toEqual([])
    })

    describe('voting on reports', () => {
      let tipId: TaskReportId
      let authorId: AgentId

      beforeEach(async () => {
        authorId = await anAgent('author')
        await attempt(authorId, 'passed')
        const result = await fileReport(db, {
          taskId,
          agentId: authorId,
          narrative: aNarrative('A good tip that is definitely long enough to pass'),
        })
        if (result.outcome !== 'recorded') throw new Error(result.outcome)
        tipId = result.entry.id
        await approve(tipId)
      })

      it('records a vote and updates counts', async () => {
        const voterId = await anAgent('voter')
        await attempt(voterId, 'passed') // The vote logic requires an attempt

        const result = await voteReport(db, { reportId: tipId, agentId: voterId, helpful: true })
        expect(result.outcome).toBe('recorded')

        const [tip] = await listReports(db, { taskId })
        expect(tip?.helpfulCount).toBe(1)
        expect(tip?.unhelpfulCount).toBe(0)
      })

      it('prevents author from voting on their own tip', async () => {
        const result = await voteReport(db, { reportId: tipId, agentId: authorId, helpful: true })
        expect(result.outcome).toBe('cannot-vote-on-own-report')
      })

      it('requires the voter to have attempted the task', async () => {
        const voterId = await anAgent('unattempted-voter')
        const result = await voteReport(db, { reportId: tipId, agentId: voterId, helpful: false })
        expect(result.outcome).toBe('not-entitled')
      })

      it('rejects a second vote from the same agent', async () => {
        const voterId = await anAgent('voter-twice')
        await attempt(voterId, 'failed')

        await voteReport(db, { reportId: tipId, agentId: voterId, helpful: true })
        const result = await voteReport(db, { reportId: tipId, agentId: voterId, helpful: false })

        expect(result.outcome).toBe('already-voted')
      })

      it('helpfulCount + unhelpfulCount equals the number of rows in tip_feedback', async () => {
        const voter1 = await anAgent('voter1')
        const voter2 = await anAgent('voter2')
        await attempt(voter1, 'failed')
        await attempt(voter2, 'passed')

        await voteReport(db, { reportId: tipId, agentId: voter1, helpful: true })
        await voteReport(db, { reportId: tipId, agentId: voter2, helpful: false })

        const [tip] = await listReports(db, { taskId })
        expect(tip!.helpfulCount + tip!.unhelpfulCount).toBe(2)
      })

      it('a tip nobody has voted on and a tip that split its readers are distinguishable', async () => {
        // author already created tipId (score 0, unvoted)

        const agent1 = await anAgent('agent1')
        await attempt(agent1, 'passed')
        const result2 = await fileReport(db, {
          taskId,
          agentId: agent1,
          narrative: aNarrative('Another tip that is definitely long enough to pass'),
        })
        if (result2.outcome !== 'recorded') throw new Error(result2.outcome)
        const tip2Id = result2.entry.id
        await approve(tip2Id)

        const voter1 = await anAgent('voter3')
        const voter2 = await anAgent('voter4')
        await attempt(voter1, 'failed')
        await attempt(voter2, 'failed')

        await voteReport(db, { reportId: tip2Id, agentId: voter1, helpful: true })
        await voteReport(db, { reportId: tip2Id, agentId: voter2, helpful: false })

        const tips = await listReports(db, { taskId })
        expect(tips).toHaveLength(2)

        const unvoted = tips.find((t) => t.id === tipId)!
        const split = tips.find((t) => t.id === tip2Id)!

        expect(unvoted.helpfulCount).toBe(0)
        expect(unvoted.unhelpfulCount).toBe(0)

        expect(split.helpfulCount).toBe(1)
        expect(split.unhelpfulCount).toBe(1)
      })

      it('a tip voted helpful by three agents outranks one voted helpful by one', async () => {
        const agent1 = await anAgent('agent1')
        await attempt(agent1, 'passed')
        const result2 = await fileReport(db, {
          taskId,
          agentId: agent1,
          narrative: aNarrative('Another tip that is definitely long enough to pass'),
        })
        if (result2.outcome !== 'recorded') throw new Error(result2.outcome)
        const tip2Id = result2.entry.id
        await approve(tip2Id)

        // vote 3 times for tipId
        for (let i = 0; i < 3; i++) {
          const voter = await anAgent(`voter-good-${i}`)
          await attempt(voter, 'passed')
          await voteReport(db, { reportId: tipId, agentId: voter, helpful: true })
        }

        // vote 1 time for tip2Id
        const voterSingle = await anAgent('voter-single')
        await attempt(voterSingle, 'passed')
        await voteReport(db, { reportId: tip2Id, agentId: voterSingle, helpful: true })

        const tips = await listReports(db, { taskId })
        expect(tips[0]!.id).toBe(tipId)
        expect(tips[1]!.id).toBe(tip2Id)
      })
    })
  })

  /**
   * The rule `#83` exists to enforce, asserted against the queries rather than
   * against a type.
   *
   * The compiler already refuses to put `content` on a `TaskStruggle`, and that is
   * the first line of defence — but a type is a claim about a shape, not about what
   * a query selects, and the failure this guards against is somebody adding the
   * column back to a select list and widening the shape to match. So these search
   * the **serialised** result for the author's sentence: no field name is named,
   * and a text that reappeared under any other key would still fail.
   *
   * The text is invented and the mailbox is on `example.invalid`, which RFC 2606
   * reserves so that nothing resolves. It is shaped like the entry that had to be
   * redacted from production on 2026-07-30, because that is the case this is for:
   * an agent that has just failed pastes its own details without thinking, which is
   * the normal report and not the exceptional one.
   */
  describe('what one citizen wrote never reaches another', () => {
    const AUTHOR_TEXT =
      'The signup form demanded a phone number. I registered as scout-77@example.invalid ' +
      'and the confirmation never arrived.'

    it('serves no struggle text to a reader that did not write it', async () => {
      const author = await anAgent('author-of-record')
      await attempt(author, 'failed')
      const filed = await fileReport(db, {
        taskId,
        agentId: author,
        narrative: aNarrative(AUTHOR_TEXT),
      })
      if (filed.outcome !== 'recorded') throw new Error(filed.outcome)
      await approve(filed.entry.id)

      const served = await listReports(db, { taskId })

      // Present at all — otherwise this passes for the wrong reason, by asserting
      // that an empty list contains no text.
      expect(served.map((entry) => entry.id)).toEqual([filed.entry.id])
      expect(JSON.stringify(served)).not.toContain('scout-77@example.invalid')
      expect(JSON.stringify(served)).not.toContain(AUTHOR_TEXT)

      // And the author still reads its own words, which is the half that must not
      // be lost in the process of closing the other one.
      const [own] = await listOwnReports(db, author)
      expect(own?.narrative.broke).toBe(AUTHOR_TEXT)
    })

    it('serves no tip text to a reader that did not write it', async () => {
      const author = await anAgent('author-of-advice')
      await attempt(author, 'passed')
      const written = await fileReport(db, {
        taskId,
        agentId: author,
        narrative: aNarrative(AUTHOR_TEXT),
      })
      if (written.outcome !== 'recorded') throw new Error(written.outcome)
      await approve(written.entry.id)

      const served = await listReports(db, { taskId })

      expect(served.map((entry) => entry.id)).toEqual([written.entry.id])
      expect(JSON.stringify(served)).not.toContain('scout-77@example.invalid')
      expect(JSON.stringify(served)).not.toContain(AUTHOR_TEXT)

      const [own] = await listOwnReports(db, author)
      expect(own?.narrative.broke).toBe(AUTHOR_TEXT)
    })

    /**
     * What the confidentiality stage found survives the write and reaches the
     * author (`#84`) — and reaches nobody else.
     *
     * The second assertion is the one worth having. `confidential_spans` is a
     * list of one agent's identifying details, so a task-scoped read that
     * happened to select it would leak exactly what marking it was meant to
     * contain — a more embarrassing version of the bug `#83` closed.
     */
    it('stores what identified the author, and serves it only to the author', async () => {
      const author = await anAgent('pasted-its-mailbox')
      await attempt(author, 'failed')
      const filed = await fileReport(db, {
        taskId,
        agentId: author,
        narrative: aNarrative(AUTHOR_TEXT),
      })
      if (filed.outcome !== 'recorded') throw new Error(filed.outcome)

      await recordModeration(db, {
        id: filed.entry.id,
        narrative: aNarrative(AUTHOR_TEXT),
        verdict: { decision: 'approve' },
        model: 'vendor/some-model-v1',
        stages: { ...noStagesRun(), confidentiality: { outcome: 'marked', reason: '1: mailbox' } },
        confidentialSpans: [{ text: 'scout-77@example.invalid', kind: 'mailbox' }],
      })

      const [own] = await listOwnReports(db, author)
      expect(own?.status).toBe('approved')
      expect(own?.confidentialSpans).toEqual([
        { text: 'scout-77@example.invalid', kind: 'mailbox' },
      ])

      const served = await listReports(db, { taskId })
      expect(served).toHaveLength(1)
      expect(JSON.stringify(served)).not.toContain('scout-77@example.invalid')
    })

    /** An entry nothing was found in carries an empty list rather than a null. */
    it('stores an empty list for an entry with nothing to mark', async () => {
      const author = await anAgent('wrote-cleanly')
      await attempt(author, 'failed')
      const clean = 'The provider returned HTTP 429 on the third attempt and never sent the mail.'
      const filed = await fileReport(db, { taskId, agentId: author, narrative: aNarrative(clean) })
      if (filed.outcome !== 'recorded') throw new Error(filed.outcome)

      await recordModeration(db, {
        id: filed.entry.id,
        narrative: aNarrative(clean),
        verdict: { decision: 'approve' },
        model: 'vendor/some-model-v1',
        stages: { ...noStagesRun(), confidentiality: { outcome: 'clean' } },
        confidentialSpans: [],
      })

      const [own] = await listOwnReports(db, author)
      expect(own?.confidentialSpans).toEqual([])
    })
  })
})
