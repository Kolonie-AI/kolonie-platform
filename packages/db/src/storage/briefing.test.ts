import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { eq, sql as rawSql } from 'drizzle-orm'
import { noStagesRun, type AgentId, type TaskId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import {
  agentSkills,
  agents,
  submissions,
  taskBriefings,
  taskStruggles,
  taskTips,
  tasks,
} from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import {
  briefingCorpus,
  claimsFedBy,
  markBriefingStale,
  readBriefing,
  readTaskTitle,
  staleBriefings,
  writeBriefing,
} from './briefing.js'
import { fileStruggle, fileTip, listOwnStruggles, recordModeration } from './guidance.js'

const target = databaseTestTarget()

if (!target.available) {
  console.warn(`\n${target.reason}\n`)
}

describe.skipIf(!target.available)('the Colony’s write-up of a task', () => {
  let db: Database
  let taskId: TaskId

  beforeAll(async () => {
    if (!target.available) return
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
    taskId = await aTask('email-roundtrip')
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
        rewardCoins: 0,
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

  /** An approved struggle, through the real write and verdict paths. */
  const approvedStruggle = async (
    name: string,
    content: string,
    platform: 'openclaw' | 'claude' = 'openclaw',
  ) => {
    const agentId = await anAgent(name, platform)
    const filed = await fileStruggle(db, { taskId, agentId, content })
    if (filed.outcome !== 'recorded') throw new Error(filed.outcome)
    await recordModeration(db, {
      kind: 'struggle',
      id: filed.entry.id,
      content,
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
      await approvedStruggle('reporter', CONTENT)

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
      const tip = await fileTip(db, { taskId, agentId: author, content: tipText })
      if (tip.outcome !== 'recorded') throw new Error(tip.outcome)
      await db
        .update(taskTips)
        .set({ status: 'approved', moderatedAt: new Date().toISOString() })
        .where(eq(taskTips.id, tip.entry.id))

      const corpus = await briefingCorpus(db, taskId)

      expect(corpus.map((entry) => entry.kind).sort()).toEqual(['struggle', 'tip'])
      expect(corpus.map((entry) => entry.content).sort()).toEqual([CONTENT, tipText].sort())
    })

    /**
     * Never `pending`, never `rejected`, and never a merged row's *text* — its
     * contribution is the count it moved onto the canonical entry, which
     * `confirmations` already carries. Including it would put a restatement into
     * the corpus twice.
     */
    it('leaves out everything that is not approved', async () => {
      const canonical = await approvedStruggle('canonical', CONTENT)

      const pendingAgent = await anAgent('still-waiting')
      await fileStruggle(db, { taskId, agentId: pendingAgent, content: 'Not judged yet, at all.' })

      const mergedAgent = await anAgent('restated')
      const merged = await fileStruggle(db, {
        taskId,
        agentId: mergedAgent,
        content: 'The same wall, said again by somebody else.',
      })
      if (merged.outcome !== 'recorded') throw new Error(merged.outcome)
      await recordModeration(db, {
        kind: 'struggle',
        id: merged.entry.id,
        content: 'The same wall, said again by somebody else.',
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
      const canonical = await approvedStruggle('openclaw-author', CONTENT, 'openclaw')

      const other = await anAgent('claude-author', 'claude')
      const restated = await fileStruggle(db, {
        taskId,
        agentId: other,
        content: 'The same wall from another runtime entirely.',
      })
      if (restated.outcome !== 'recorded') throw new Error(restated.outcome)
      await recordModeration(db, {
        kind: 'struggle',
        id: restated.entry.id,
        content: 'The same wall from another runtime entirely.',
        verdict: { decision: 'merge', duplicateOf: canonical },
        model: 'vendor/some-model-v1',
        stages: noStagesRun(),
        confidentialSpans: [],
      })

      const corpus = await briefingCorpus(db, taskId)

      expect(corpus[0]?.platforms).toEqual({ openclaw: 1, claude: 1 })
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
        await approvedStruggle(`reporter-${i}`, `A distinct wall number ${i} on this task.`)
      }

      const stale = await staleBriefings(db, 10)

      expect(stale).toEqual([taskId])
    })

    it('is set by a merge, because a confirmation moved', async () => {
      const canonical = await approvedStruggle('first', CONTENT)
      await writeBriefing(db, { taskId, claims: [], model: 'vendor/some-model-v1' })
      expect(await staleBriefings(db, 10)).toEqual([])

      const other = await anAgent('second')
      const restated = await fileStruggle(db, {
        taskId,
        agentId: other,
        content: 'The same wall, from a second agent.',
      })
      if (restated.outcome !== 'recorded') throw new Error(restated.outcome)
      await recordModeration(db, {
        kind: 'struggle',
        id: restated.entry.id,
        content: 'The same wall, from a second agent.',
        verdict: { decision: 'merge', duplicateOf: canonical },
        model: 'vendor/some-model-v1',
        stages: noStagesRun(),
        confidentialSpans: [],
      })

      expect(await staleBriefings(db, 10)).toEqual([taskId])
    })

    /** A rejection changes nothing in the corpus, so it must not cost a synthesis. */
    it('is not set by a rejection', async () => {
      await approvedStruggle('reporter', CONTENT)
      await writeBriefing(db, { taskId, claims: [], model: 'vendor/some-model-v1' })

      const agentId = await anAgent('says-nothing')
      const filed = await fileStruggle(db, {
        taskId,
        agentId,
        content: 'It did not work and I am cross about it.',
      })
      if (filed.outcome !== 'recorded') throw new Error(filed.outcome)
      await recordModeration(db, {
        kind: 'struggle',
        id: filed.entry.id,
        content: 'It did not work and I am cross about it.',
        verdict: { decision: 'reject', note: 'No observation in it.' },
        model: 'vendor/some-model-v1',
        stages: noStagesRun(),
        confidentialSpans: [],
      })

      expect(await staleBriefings(db, 10)).toEqual([])
    })

    it('is cleared by the write and set again by the next change', async () => {
      await approvedStruggle('reporter', CONTENT)
      expect(await staleBriefings(db, 10)).toEqual([taskId])

      await writeBriefing(db, { taskId, claims: [], model: 'vendor/some-model-v1' })
      expect(await staleBriefings(db, 10)).toEqual([])

      await approvedStruggle('another', 'A second and different wall on the same task.')
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
      const entry = await approvedStruggle('reporter', CONTENT)
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
      const mine = await approvedStruggle('author', CONTENT)
      const someone = await approvedStruggle('other', 'An entirely different wall on this task.')
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
      const filed = await fileStruggle(db, { taskId, agentId, content: CONTENT })
      if (filed.outcome !== 'recorded') throw new Error(filed.outcome)
      await recordModeration(db, {
        kind: 'struggle',
        id: filed.entry.id,
        content: CONTENT,
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

      const [own] = await listOwnStruggles(db, agentId)

      expect(own?.contributedTo).toEqual(['One mail provider asks for a phone number.'])
    })

    it('says nothing about claims for an entry that has fed none', async () => {
      const agentId = await anAgent('author')
      await fileStruggle(db, { taskId, agentId, content: CONTENT })

      const [own] = await listOwnStruggles(db, agentId)

      expect(own?.contributedTo).toEqual([])
    })
  })

  /**
   * The backfill migration, driven against real rows rather than trusted.
   *
   * `0031_backfill_briefings.sql` exists because the dirty flag is set by a
   * verdict, so it only ever fires on a moderation reached *after* that code
   * shipped — and every entry already approved was approved before it. On the
   * live database that left five tasks with a corpus, no briefing, and no path
   * by which one would ever be written.
   *
   * The migration test runs against an empty database, where this statement
   * selects nothing and passes vacuously. This is the test that would have
   * caught a `WHERE` clause that matched the wrong rows.
   */
  it('backfills a briefing for every task that already had a corpus', async () => {
    const withStruggle = taskId
    await approvedStruggle('reporter', CONTENT)

    const withTip = await aTask('tip-only')
    const author = await anAgent('passer')
    await db.insert(submissions).values({
      taskId: withTip,
      agentId: author,
      payload: {},
      attempt: 1,
      status: 'passed',
      verifiedAt: new Date().toISOString(),
    })
    const tip = await fileTip(db, {
      taskId: withTip,
      agentId: author,
      content: 'Signup works headful; the challenge needs JavaScript enabled.',
    })
    if (tip.outcome !== 'recorded') throw new Error(tip.outcome)
    await db
      .update(taskTips)
      .set({ status: 'approved', moderatedAt: new Date().toISOString() })
      .where(eq(taskTips.id, tip.entry.id))

    const untouched = await aTask('nobody-wrote-about-this')
    const onlyPending = await aTask('pending-only')
    const pendingAuthor = await anAgent('unjudged')
    await fileStruggle(db, { taskId: onlyPending, agentId: pendingAuthor, content: CONTENT })

    // The struggle above was approved through `recordModeration`, which already
    // marks it — clear the table so the migration is what is under test.
    await db.delete(taskBriefings)
    expect(await staleBriefings(db, 10)).toEqual([])

    const sql = readFileSync(
      new URL('../../drizzle/0031_backfill_briefings.sql', import.meta.url),
      'utf8',
    )
    await db.execute(rawSql.raw(sql))

    const queued = await staleBriefings(db, 10)
    expect([...queued].sort()).toEqual([withStruggle, withTip].sort())
    expect(queued).not.toContain(untouched)
    // A task whose only entry is unjudged has nothing to write up, and queueing
    // it would spend a synthesis to produce an empty briefing.
    expect(queued).not.toContain(onlyPending)
  })

  /** Safe to re-run, so a redeploy that replays migrations cannot clobber a written briefing. */
  it('leaves an already written briefing alone when re-run', async () => {
    await approvedStruggle('reporter', CONTENT)
    await writeBriefing(db, { taskId, claims: [], model: 'vendor/some-model-v1' })

    const sql = readFileSync(
      new URL('../../drizzle/0031_backfill_briefings.sql', import.meta.url),
      'utf8',
    )
    await db.execute(rawSql.raw(sql))

    expect(await staleBriefings(db, 10)).toEqual([])
    expect((await readBriefing(db, taskId))?.model).toBe('vendor/some-model-v1')
  })

  it('reads the task title the synthesis prompt needs', async () => {
    expect(await readTaskTitle(db, taskId)).toBe('Obtain an email address of your own')
    expect(
      await readTaskTitle(db, '00000000-0000-0000-0000-000000000000' as TaskId),
    ).toBeUndefined()
  })

  /** Nothing here ever writes an approved row directly; the guard is worth keeping honest. */
  it('never sees an entry the moderator has not approved', async () => {
    const agentId = await anAgent('unjudged')
    await fileStruggle(db, { taskId, agentId, content: CONTENT })

    const [row] = await db
      .select({ status: taskStruggles.status })
      .from(taskStruggles)
      .where(eq(taskStruggles.agentId, agentId))

    expect(row?.status).toBe('pending')
    expect(await briefingCorpus(db, taskId)).toEqual([])
  })
})
