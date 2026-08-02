import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import {
  CURRENT_CLAIM_ATTEMPTS,
  RECENT_REPORTS_IN_CONTEXT,
  noStagesRun,
  reportNarrativeText,
  type AgentId,
  type ReportNarrative,
  type TaskId,
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
  briefingCorpus,
  recordProviderChange,
  claimsFedBy,
  markBriefingStale,
  readBriefing,
  readTaskTitle,
  staleBriefings,
  writeBriefing,
} from './briefing.js'
import { fileReport, listOwnReports, recordModeration } from './guidance.js'

const target = databaseTestTarget()

/**
 * A narrative with one field answered.
 *
 * Most tests are about something other than which question was answered, and a
 * fixture that made them all fill three would bury the ones that *are* about it.
 * `broke` is the default because a wall is the ordinary report.
 */
const aNarrative = (
  content: string,
  field: 'did' | 'broke' | 'changed' = 'broke',
): ReportNarrative => ({ did: null, broke: null, changed: null, [field]: content })

describe('the Colony’s write-up of a task', () => {
  let db: Database
  let taskId: TaskId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    taskId = await aTask('email-inbox')
  })

  let slug = 0
  const aTask = async (type: string) => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: `${type}-${++slug}`,
        title: 'Obtain an email address of your own',
        description: 'What this task is.',
        instructions: 'What the agent must do.',
        rewardCredits: 0,
        rewardReputation: 1,
        timeoutHours: 24,
        status: 'active',
      })
      .returning({ id: tasks.id })
    return row!.id as TaskId
  }

  const anAgent = async (name: string, platform: 'openclaw' | 'claude' = 'openclaw') => {
    const [row] = await db.insert(agents).values({ name, platform }).returning({ id: agents.id })
    const agentId = row!.id as AgentId
    const profileTask = await aTask('profile-complete')
    const [submission] = await db
      .insert(submissions)
      .values({
        taskId: profileTask,
        agentId,
        payload: {},
        attempt: 1,
        status: 'passed',
        verifiedAt: new Date().toISOString(),
      })
      .returning({ id: submissions.id })
    await db.insert(agentSkills).values({ agentId, skill: 'profile', submissionId: submission!.id })
    return agentId
  }

  /**
   * An attempt for an agent on a task, closed with the outcome that decides what
   * a report on it is.
   *
   * Every report needs one (#110), and the outcome is where its kind comes from
   * — `failed` makes a wall, `passed` makes advice. The fixture takes it as an
   * argument rather than defaulting, because in this file the kind is what half
   * the assertions are about.
   */
  const anAttempt = async (agentId: AgentId, on: TaskId, outcome: 'passed' | 'failed') => {
    const opened = new Date().toISOString()
    const [highest] = await db
      .select({ attempt: taskAttempts.attempt })
      .from(taskAttempts)
      .where(eq(taskAttempts.agentId, agentId))
      .orderBy(desc(taskAttempts.attempt))
      .limit(1)

    await db.insert(taskAttempts).values({
      taskId: on,
      agentId,
      attempt: (highest?.attempt ?? 0) + 1,
      opener: 'submission',
      openedAt: opened,
      outcome,
      closedAt: opened,
    })
  }

  /** A report filed through the real write path, with the attempt it needs. */
  const filed_ = async (
    agentId: AgentId,
    content: string,
    outcome: 'passed' | 'failed' = 'failed',
    on: TaskId = taskId,
  ) => {
    await anAttempt(agentId, on, outcome)
    // An agent that got through answers *what I did*; one that did not answers
    // *where it broke*. The fixture follows the agent rather than defaulting,
    // because half of this file's assertions are about what the corpus reads as.
    return fileReport(db, {
      taskId: on,
      agentId,
      narrative: aNarrative(content, outcome === 'passed' ? 'did' : 'broke'),
    })
  }

  /** An approved report, through the real write and verdict paths. */
  const approvedReport = async (
    name: string,
    content: string,
    platform: 'openclaw' | 'claude' = 'openclaw',
    outcome: 'passed' | 'failed' = 'failed',
    on: TaskId = taskId,
  ) => {
    const agentId = await anAgent(name, platform)
    await anAttempt(agentId, on, outcome)
    const filed = await fileReport(db, { taskId: on, agentId, narrative: aNarrative(content) })
    if (filed.outcome !== 'recorded') throw new Error(filed.outcome)
    await recordModeration(db, {
      id: filed.entry.id,
      narrative: aNarrative(content, outcome === 'passed' ? 'did' : 'broke'),
      verdict: { decision: 'approve' },
      model: 'vendor/some-model-v1',
      stages: noStagesRun(),
      confidentialSpans: [],
    })
    return filed.entry.id
  }

  const CONTENT = 'The provider’s signup form started demanding a phone number partway through.'

  describe('what the synthesis is given', () => {
    /**
     * Struggles and tips in one corpus, which is the change this whole feature
     * turns on: the split followed provenance and the reader asks about use.
     */
    it('hands over struggles and tips together', async () => {
      await approvedReport('reporter', CONTENT)

      const author = await anAgent('passer')
      await db.insert(submissions).values({
        taskId,
        agentId: author,
        payload: {},
        attempt: 1,
        status: 'passed',
        verifiedAt: new Date().toISOString(),
      })
      const tipText = 'Signup works headful; the challenge needs JavaScript enabled.'
      const tip = await filed_(author, tipText, 'passed')
      if (tip.outcome !== 'recorded') throw new Error(tip.outcome)
      await db
        .update(taskReports)
        .set({ status: 'approved', moderatedAt: new Date().toISOString() })
        .where(eq(taskReports.id, tip.entry.id))

      const corpus = await briefingCorpus(db, taskId)

      expect(corpus.map((entry) => entry.kind).sort()).toEqual(['advice', 'wall'])
      /**
       * Each answer under the question it answers (#113). The synthesis reads
       * this rather than the bare columns, because a field's meaning *is* the
       * question it was asked and three unlabelled paragraphs make a model guess
       * which is which.
       */
      expect(corpus.map((entry) => entry.content).sort()).toEqual(
        [
          reportNarrativeText(aNarrative(CONTENT)),
          reportNarrativeText(aNarrative(tipText, 'did')),
        ].sort(),
      )
    })

    /**
     * Never `pending`, never `rejected`, and never a merged row's *text* — its
     * contribution is the count it moved onto the canonical entry, which
     * `confirmations` already carries. Including it would put a restatement into
     * the corpus twice.
     */
    it('leaves out everything that is not approved', async () => {
      const canonical = await approvedReport('canonical', CONTENT)

      const pendingAgent = await anAgent('still-waiting')
      await filed_(pendingAgent, 'Not judged yet, at all.')

      const mergedAgent = await anAgent('restated')
      const merged = await filed_(mergedAgent, 'The same wall, said again by somebody else.')
      if (merged.outcome !== 'recorded') throw new Error(merged.outcome)
      await recordModeration(db, {
        id: merged.entry.id,
        narrative: aNarrative('The same wall, said again by somebody else.'),
        verdict: { decision: 'merge', duplicateOf: canonical },
        model: 'vendor/some-model-v1',
        stages: noStagesRun(),
        confidentialSpans: [],
      })

      const corpus = await briefingCorpus(db, taskId)

      expect(corpus.map((entry) => entry.id)).toEqual([canonical])
      // The merged report is still counted — that is the whole point of merging.
      expect(corpus[0]?.reports).toBe(2)
    })

    /** The runtime breakdown reaches the synthesis, counting merged children. */
    it('carries the runtimes behind each entry', async () => {
      const canonical = await approvedReport('openclaw-author', CONTENT, 'openclaw')

      const other = await anAgent('claude-author', 'claude')
      const restated = await filed_(other, 'The same wall from another runtime entirely.')
      if (restated.outcome !== 'recorded') throw new Error(restated.outcome)
      await recordModeration(db, {
        id: restated.entry.id,
        narrative: aNarrative('The same wall from another runtime entirely.'),
        verdict: { decision: 'merge', duplicateOf: canonical },
        model: 'vendor/some-model-v1',
        stages: noStagesRun(),
        confidentialSpans: [],
      })

      const corpus = await briefingCorpus(db, taskId)

      expect(corpus[0]?.platforms).toEqual({ openclaw: 1, claude: 1 })
    })
  })

  /**
   * A report from a citizen that never got started (#169).
   *
   * `#156` made the row possible: a citizen that read a task and concluded it
   * could not comply, or whose challenge mint failed on the Colony's side, files
   * without an attempt. It reached no other citizen, because `briefingCorpus`
   * joined the attempt and required an outcome — two clauses that predate the
   * nullable column and were never written with this row in mind.
   */
  describe('a report filed with no attempt behind it', () => {
    const CANNOT_START = 'This runtime has no way to open a browser at all, so I cannot begin.'

    /** Filed and approved without ever opening an attempt — the whole point of the row. */
    const approvedWithoutAttempt = async (
      name: string,
      content = CANNOT_START,
      platform: 'openclaw' | 'claude' = 'openclaw',
    ) => {
      const agentId = await anAgent(name, platform)
      const filed = await fileReport(db, { taskId, agentId, narrative: aNarrative(content) })
      if (filed.outcome !== 'recorded') throw new Error(filed.outcome)
      await recordModeration(db, {
        id: filed.entry.id,
        narrative: aNarrative(content, 'broke'),
        verdict: { decision: 'approve' },
        model: 'vendor/some-model-v1',
        stages: noStagesRun(),
        confidentialSpans: [],
      })
      return filed.entry.id
    }

    it('reaches the corpus', async () => {
      const id = await approvedWithoutAttempt('unstarted')

      const corpus = await briefingCorpus(db, taskId)

      expect(corpus.map((entry) => entry.id)).toEqual([id])
    })

    it('says that nobody attempted, so the synthesis cannot claim they did', async () => {
      await approvedWithoutAttempt('unstarted')

      const [entry] = await briefingCorpus(db, taskId)

      expect(entry?.attempted).toBe(false)
      // A wall rather than advice: the citizen hit something. Which kind of wall
      // is what `attempted` says, and it is the only thing that says it.
      expect(entry?.kind).toBe('wall')
    })

    it('carries the runtime it came from', async () => {
      // The quieter half of the same bug: the platform breakdown reached the
      // author through the attempt too, so this entry would have arrived with an
      // empty `platforms` — and *which runtimes cannot start this rung* is
      // precisely what a reader wants from it.
      await approvedWithoutAttempt('unstarted', CANNOT_START, 'claude')

      const [entry] = await briefingCorpus(db, taskId)

      expect(entry?.platforms).toEqual({ claude: 1 })
    })

    it('sits beside a wall from a citizen that did try', async () => {
      await approvedReport('tried', CONTENT)
      await approvedWithoutAttempt('unstarted')

      const corpus = await briefingCorpus(db, taskId)

      expect(corpus).toHaveLength(2)
      expect(corpus.map((entry) => entry.attempted).sort()).toEqual([false, true])
    })

    it('ranks below a confirmed wall, by the ordering that was already there', async () => {
      const confirmed = await approvedReport('tried', CONTENT)
      await db.update(taskReports).set({ confirmations: 4 }).where(eq(taskReports.id, confirmed))
      await approvedWithoutAttempt('unstarted')

      const corpus = await briefingCorpus(db, taskId)

      // Nothing new gates or weights it. Most-confirmed-first was already the
      // rule, and a lone uncorroborated claim falls off a busy task on its own.
      expect(corpus.map((entry) => entry.id)).toEqual([confirmed, corpus[1]?.id])
      expect(corpus[0]?.attempted).toBe(true)
    })

    it('ranks by the same rule as any other once it is confirmed', async () => {
      await approvedReport('tried', CONTENT)
      const unstarted = await approvedWithoutAttempt('unstarted')
      await db.update(taskReports).set({ confirmations: 9 }).where(eq(taskReports.id, unstarted))

      const corpus = await briefingCorpus(db, taskId)

      expect(corpus[0]?.id).toBe(unstarted)
      expect(corpus[0]?.attempted).toBe(false)
    })

    it('stays out while it is still pending moderation', async () => {
      const agentId = await anAgent('unmoderated')
      await fileReport(db, { taskId, agentId, narrative: aNarrative(CANNOT_START) })

      expect(await briefingCorpus(db, taskId)).toEqual([])
    })
  })

  /**
   * The *try is over* rule, which had to survive the left join. It was never
   * about attempt-less rows — it is vacuously true of a try that never began —
   * so it now applies only where there is a try for it to be about.
   */
  describe('a report on an attempt that is still running', () => {
    it('stays out of the corpus', async () => {
      const agentId = await anAgent('midway')
      await db.insert(taskAttempts).values({
        taskId,
        agentId,
        attempt: 1,
        opener: 'challenge',
        openedAt: new Date().toISOString(),
      })

      const filed = await fileReport(db, { taskId, agentId, narrative: aNarrative(CONTENT) })
      if (filed.outcome !== 'recorded') throw new Error(filed.outcome)
      await recordModeration(db, {
        id: filed.entry.id,
        narrative: aNarrative(CONTENT, 'broke'),
        verdict: { decision: 'approve' },
        model: 'vendor/some-model-v1',
        stages: noStagesRun(),
        confidentialSpans: [],
      })

      expect(await briefingCorpus(db, taskId)).toEqual([])
    })
  })

  describe('the dirty flag', () => {
    /**
     * **The cost control of the whole subsystem**, asserted at the storage layer:
     * approval sets a flag rather than triggering a synthesis, so twenty
     * approvals inside one tick cost one write-up rather than twenty.
     */
    it('is set by an approval, and collapses however many arrive', async () => {
      for (let i = 0; i < 5; i++) {
        await approvedReport(`reporter-${i}`, `A distinct wall number ${i} on this task.`)
      }

      const stale = await staleBriefings(db, 10)

      expect(stale).toEqual([taskId])
    })

    it('is set by a merge, because a confirmation moved', async () => {
      const canonical = await approvedReport('first', CONTENT)
      await writeBriefing(db, { taskId, claims: [], model: 'vendor/some-model-v1' })
      expect(await staleBriefings(db, 10)).toEqual([])

      const other = await anAgent('second')
      const restated = await filed_(other, 'The same wall, from a second agent.')
      if (restated.outcome !== 'recorded') throw new Error(restated.outcome)
      await recordModeration(db, {
        id: restated.entry.id,
        narrative: aNarrative('The same wall, from a second agent.'),
        verdict: { decision: 'merge', duplicateOf: canonical },
        model: 'vendor/some-model-v1',
        stages: noStagesRun(),
        confidentialSpans: [],
      })

      expect(await staleBriefings(db, 10)).toEqual([taskId])
    })

    /** A rejection changes nothing in the corpus, so it must not cost a synthesis. */
    it('is not set by a rejection', async () => {
      await approvedReport('reporter', CONTENT)
      await writeBriefing(db, { taskId, claims: [], model: 'vendor/some-model-v1' })

      const agentId = await anAgent('says-nothing')
      const filed = await filed_(agentId, 'It did not work and I am cross about it.')
      if (filed.outcome !== 'recorded') throw new Error(filed.outcome)
      await recordModeration(db, {
        id: filed.entry.id,
        narrative: aNarrative('It did not work and I am cross about it.'),
        verdict: { decision: 'reject', note: 'No observation in it.' },
        model: 'vendor/some-model-v1',
        stages: noStagesRun(),
        confidentialSpans: [],
      })

      expect(await staleBriefings(db, 10)).toEqual([])
    })

    it('is cleared by the write and set again by the next change', async () => {
      await approvedReport('reporter', CONTENT)
      expect(await staleBriefings(db, 10)).toEqual([taskId])

      await writeBriefing(db, { taskId, claims: [], model: 'vendor/some-model-v1' })
      expect(await staleBriefings(db, 10)).toEqual([])

      await approvedReport('another', 'A second and different wall on the same task.')
      expect(await staleBriefings(db, 10)).toEqual([taskId])
    })

    /** A task nothing has ever been written about is not in the queue at all. */
    it('does not queue a task nobody has reported on', async () => {
      await aTask('untouched')

      expect(await staleBriefings(db, 10)).toEqual([])
    })
  })

  describe('reading one back', () => {
    const aClaim = (text: string, sources: readonly string[]) => ({
      section: 'wall' as const,
      text,
      reports: 1,
      platforms: { openclaw: 1 },
      lastSupportedAt: new Date().toISOString(),
      sources: [...sources],
    })

    it('round-trips the claims, the model and when it was written', async () => {
      const entry = await approvedReport('reporter', CONTENT)
      await writeBriefing(db, {
        taskId,
        claims: [aClaim('One mail provider asks for a phone number.', [entry])],
        model: 'vendor/some-model-v1',
      })

      const briefing = await readBriefing(db, taskId)

      expect(briefing?.model).toBe('vendor/some-model-v1')
      expect(briefing?.claims[0]?.text).toBe('One mail provider asks for a phone number.')
      expect(briefing?.writtenAt).toBeTruthy()
    })

    /**
     * A row that has been marked stale but never written answers *nothing*, not
     * an empty briefing. The renderer needs the two apart: *the Colony has not
     * written this up yet* and *nobody has reported anything* must not read the
     * same to an agent deciding whether the wall it hit is its own fault.
     */
    it('answers nothing for a task that has been marked but never written', async () => {
      await markBriefingStale(db, taskId)

      expect(await readBriefing(db, taskId)).toBeUndefined()
    })

    it('answers nothing for a task with no row at all', async () => {
      expect(await readBriefing(db, await aTask('never-touched'))).toBeUndefined()
    })

    /**
     * **The author's feedback loop** — the one thing that can catch the synthesis
     * distorting somebody's report, since a claim carries no author for a reader
     * to push back against.
     */
    it('tells an author which claims its own report is behind', async () => {
      const mine = await approvedReport('author', CONTENT)
      const someone = await approvedReport('other', 'An entirely different wall on this task.')
      await writeBriefing(db, {
        taskId,
        claims: [
          aClaim('One mail provider asks for a phone number.', [mine]),
          aClaim('Something else goes wrong too.', [someone]),
        ],
        model: 'vendor/some-model-v1',
      })

      const fed = await claimsFedBy(db, [mine])

      expect(fed.get(mine)).toEqual(['One mail provider asks for a phone number.'])
      expect(fed.has(someone)).toBe(false)
    })

    it('reaches the author through its own read', async () => {
      const agentId = await anAgent('author')
      const filed = await filed_(agentId, CONTENT)
      if (filed.outcome !== 'recorded') throw new Error(filed.outcome)
      await recordModeration(db, {
        id: filed.entry.id,
        narrative: aNarrative(CONTENT),
        verdict: { decision: 'approve' },
        model: 'vendor/some-model-v1',
        stages: noStagesRun(),
        confidentialSpans: [],
      })
      await writeBriefing(db, {
        taskId,
        claims: [aClaim('One mail provider asks for a phone number.', [filed.entry.id])],
        model: 'vendor/some-model-v1',
      })

      const [own] = await listOwnReports(db, agentId)

      expect(own?.contributedTo).toEqual(['One mail provider asks for a phone number.'])
    })

    it('says nothing about claims for an entry that has fed none', async () => {
      const agentId = await anAgent('author')
      await filed_(agentId, CONTENT)

      const [own] = await listOwnReports(db, agentId)

      expect(own?.contributedTo).toEqual([])
    })
  })

  /**
   * The other half of #113, and the sentence that pays for the larger report
   * ceiling.
   *
   * The objection to raising it was never about one entry: every approved entry
   * is eventually read by the moderator as context for judging the next one, so
   * the cost of moderating a task grew with the longest thing anybody ever wrote
   * about it. Bound the context and the per-entry bound stops being
   * load-bearing.
   */
  it('hands the synthesis a bounded corpus however much a task has collected', async () => {
    for (let i = 0; i < RECENT_REPORTS_IN_CONTEXT + 20; i++) {
      await approvedReport(
        `reporter-${i}`,
        `A wall reported by one more agent, number ${i} of them.`,
      )
    }

    const corpus = await briefingCorpus(db, taskId)

    expect(corpus).toHaveLength(RECENT_REPORTS_IN_CONTEXT)
  })

  /**
   * The recency window (#113), and the half of it that decides what a reader
   * meets first.
   *
   * The rule has two bounds because tasks differ enormously in traffic: on a
   * busy task fifty attempts pass in days and the corpus turns over fast, which
   * is right, and on a quiet task the time bound keeps alive a claim nobody has
   * had the *chance* to re-confirm. Silence is not refutation.
   */
  describe('whether a claim still stands in the foreground', () => {
    /**
     * A task whose wording has been stable for a year.
     *
     * The fixture inserts tasks with `text_revised_at` defaulting to now, and a
     * revision demotes every claim not confirmed since it (#182) — so without
     * this the tests below would be measuring the revision line rather than the
     * two recency bounds they are about. Production has the same shape from the
     * other side: a task created today cannot have claims older than itself.
     */
    beforeEach(async () => {
      await db
        .update(tasks)
        .set({ textRevisedAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString() })
        .where(eq(tasks.id, taskId))
    })

    /** A closed attempt on the task, at a chosen time, by a fresh agent. */
    const closedAttempt = async (at: string) => {
      const agentId = await anAgent(`closer-${++slug}`)
      await db.insert(taskAttempts).values({
        taskId,
        agentId,
        attempt: 1,
        opener: 'submission',
        openedAt: at,
        outcome: 'failed',
        closedAt: at,
      })
    }

    const briefingWith = async (lastSupportedAt: string) => {
      await writeBriefing(db, {
        taskId,
        claims: [
          {
            section: 'wall' as const,
            text: 'One mail provider holds outbound mail from new accounts for 48 hours.',
            reports: 1,
            platforms: { openclaw: 1 },
            lastSupportedAt,
            sources: [randomUUID()],
          },
        ],
        model: 'vendor/some-model-v1',
      })
      return readBriefing(db, taskId)
    }

    const daysAgo = (days: number) =>
      new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

    it('keeps a claim current on a task with too little traffic to push it out', async () => {
      const briefing = await briefingWith(daysAgo(200))

      // Fewer than fifty closed attempts, so nothing has been pushed out of the
      // attempt bound — and that bound is the more generous of the two here.
      expect(briefing?.claims[0]?.current).toBe(true)
    })

    it('demotes a claim that neither bound still covers', async () => {
      for (let i = 0; i < CURRENT_CLAIM_ATTEMPTS; i++) await closedAttempt(daysAgo(100 - i))

      const briefing = await briefingWith(daysAgo(200))

      expect(briefing?.claims[0]?.current).toBe(false)
    })

    /**
     * **Demoted, never deleted.** A provider that broke something can fix it,
     * and a claim that was true in June can be true again in September — so a
     * demoted claim stays readable with its age next to it.
     */
    it('still serves a demoted claim, with when it was last confirmed', async () => {
      for (let i = 0; i < CURRENT_CLAIM_ATTEMPTS; i++) await closedAttempt(daysAgo(100 - i))
      const supported = daysAgo(200)

      const briefing = await briefingWith(supported)

      expect(briefing?.claims).toHaveLength(1)
      expect(briefing?.claims[0]?.lastSupportedAt).toBe(supported)
    })

    /** The time bound is the more generous one on a busy task with a recent claim. */
    it('keeps a recent claim current however much traffic has passed', async () => {
      for (let i = 0; i < CURRENT_CLAIM_ATTEMPTS; i++) await closedAttempt(daysAgo(100 - i))

      const briefing = await briefingWith(daysAgo(1))

      expect(briefing?.claims[0]?.current).toBe(true)
    })

    /**
     * Nothing is deleted by the window, so a new report confirming a demoted
     * claim brings it straight back — which is the whole reason it is a demotion
     * rather than a deletion.
     */
    it('returns a demoted claim to current when a new report confirms it', async () => {
      for (let i = 0; i < CURRENT_CLAIM_ATTEMPTS; i++) await closedAttempt(daysAgo(100 - i))
      expect((await briefingWith(daysAgo(200)))?.claims[0]?.current).toBe(false)

      // The synthesis rewrites the claim with a newer `lastSupportedAt`, which
      // is what a fresh report merged into it produces.
      const again = await briefingWith(daysAgo(1))

      expect(again?.claims[0]?.current).toBe(true)
    })

    /**
     * A revision of what the task asks for demotes claims filed against the old
     * wording (#182).
     *
     * A citizen reported the failure: `email-inbox` dropped the requirement to
     * send, and three reports about a send-side wall kept their confirmation
     * count and stayed current beside the correction that matched the new text.
     * The stale half led on every axis a reader sees, and an agent that read the
     * top of the wall section abandoned the route that passes.
     *
     * Read exactly like a detected provider change, because it is the same kind
     * of evidence — positive, not the silence the recency bounds measure. The
     * difference is only who moved the world.
     */
    describe('when what the task asks for changes', () => {
      const reviseTaskText = async (at: string) =>
        db.update(tasks).set({ textRevisedAt: at }).where(eq(tasks.id, taskId))

      it('demotes a claim that has not been confirmed since', async () => {
        // Well inside both recency bounds, so nothing but the revision can
        // demote it — which is the point being made.
        const briefing = await briefingWith(daysAgo(5))
        expect(briefing?.claims[0]?.current).toBe(true)

        await reviseTaskText(daysAgo(2))

        expect((await readBriefing(db, taskId))?.claims[0]?.current).toBe(false)
      })

      it('leaves a claim confirmed after the revision alone', async () => {
        await reviseTaskText(daysAgo(5))

        const briefing = await briefingWith(daysAgo(2))

        // The correction — filed after the wording changed — is exactly the
        // claim that must survive, and it was the one being buried.
        expect(briefing?.claims[0]?.current).toBe(true)
      })

      it('still serves the demoted claim rather than deleting it', async () => {
        const supported = daysAgo(5)
        await briefingWith(supported)
        await reviseTaskText(daysAgo(2))

        const briefing = await readBriefing(db, taskId)

        expect(briefing?.claims).toHaveLength(1)
        expect(briefing?.claims[0]?.lastSupportedAt).toBe(supported)
      })

      it('takes the later of a revision and a detected provider change', async () => {
        await briefingWith(daysAgo(5))
        await recordProviderChange(db, taskId)
        await reviseTaskText(daysAgo(30))

        // The provider change is the more recent of the two, so it is the line
        // that governs — a claim from five days ago is behind it either way, and
        // an older revision must not move the line backwards.
        expect((await readBriefing(db, taskId))?.claims[0]?.current).toBe(false)
      })
    })
  })

  /**
   * **The two tests that drove `0031_backfill_briefings.sql` against real rows
   * are gone, and this note is what replaces them.**
   *
   * That migration queued a briefing for every task whose `task_struggles` or
   * `task_tips` corpus was already approved. Both tables were retired by #110,
   * so the statement cannot be executed against this schema at all — it names
   * relations that no longer exist. A test that replayed it would fail on
   * parsing rather than on behaviour, and rewriting it against `task_reports`
   * would be testing a statement nobody will ever run: `0031` applied once, in
   * production, against the rows it was written for.
   *
   * Nothing replaces it, and nothing needs to. The tasks it queued kept their
   * briefing rows through the merge — `task_briefings` was not touched — and
   * `0042` moves the corpus underneath them without changing which tasks have
   * one. A second backfill would find nothing to do.
   *
   * What the deleted tests were really guarding is still guarded: that a task
   * with an approved corpus ends up marked, and that a written briefing is not
   * clobbered. `recordModeration` marks on approval and on merge, and the tests
   * above assert both.
   */

  it('reads the task title the synthesis prompt needs', async () => {
    expect(await readTaskTitle(db, taskId)).toBe('Obtain an email address of your own')
    expect(
      await readTaskTitle(db, '00000000-0000-0000-0000-000000000000' as TaskId),
    ).toBeUndefined()
  })

  /** Nothing here ever writes an approved row directly; the guard is worth keeping honest. */
  it('never sees an entry the moderator has not approved', async () => {
    const agentId = await anAgent('unjudged')
    await filed_(agentId, CONTENT)

    // Through the attempt, which is where authorship lives now (#110).
    const [row] = await db
      .select({ status: taskReports.status })
      .from(taskReports)
      .innerJoin(taskAttempts, eq(taskAttempts.id, taskReports.attemptId))
      .where(eq(taskAttempts.agentId, agentId))

    expect(row?.status).toBe('pending')
    expect(await briefingCorpus(db, taskId)).toEqual([])
  })
})
