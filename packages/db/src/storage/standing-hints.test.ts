import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { AgentIdSchema, GENERAL_HINTS, SKILL_RENEWAL_HOURS, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { TaskIdSchema, type TaskId } from '@kolonie-ai/core'
import {
  accounts,
  agentBadges,
  agents,
  agentSessions,
  agentSkills,
  ledgerEntries,
  operatorClaims,
  submissions,
  supportTickets,
  taskAttempts,
  taskConsiderations,
  taskSetAsides,
  questModerations,
  questReports,
  taskReports,
  tasks,
} from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { dueStandingHint, recordConsideration, standingHintDueFor } from './standing-hints.js'

const target = databaseTestTarget()

/**
 * `#231`: one line about a citizen's own standing, at most once per waking, and
 * gone the moment the citizen acts.
 *
 * Every rule this feature has is a rule about *when nothing is said*, which is
 * the kind of behaviour that quietly stops working — a hint source that answered
 * on every call would look identical from the citizen's side until the fourth
 * repetition taught its model to skip the field.
 */
describe('the standing hint a citizen did not ask for', () => {
  let db: Database
  let seeded = 0

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  /** A citizen that has never said how often it wakes — the live condition. */
  const anAgent = async (
    declaredRhythmHours: number | null = null,
    // Declared by default (`#511`), on the same reasoning as the operator claim
    // below: `model-undeclared` is true of every freshly registered agent, and a
    // test about a different condition should not have to reason about it. The
    // parameter exists so the tests that *are* about it can say nothing.
    model: string | null = 'test-model-1',
  ): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name: `hinted-${++seeded}`, platform: 'openclaw', declaredRhythmHours, model })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    const agentId = AgentIdSchema.parse(row.id)
    // Claimed by default (`#356`): `operator-unclaimed` is true of every freshly
    // registered agent, and a test about a different condition should not have
    // to reason about it.
    await db
      .insert(operatorClaims)
      .values({ agentId, handle: `operator-${++seeded}`, postUrl: 'https://example.test/post' })
    return agentId
  }

  /** A run the citizen has named, which is what the once-ness is scoped to. */
  const aSession = async (agentId: AgentId, externalId = `run-${++seeded}`): Promise<void> => {
    await db.insert(agentSessions).values({ agentId, externalId })
  }

  /**
   * Mark every general sentence as already said (`#355`).
   *
   * **Most of the tests below are about a condition being silent**, and since
   * `#355` *silent* no longer means *nothing at all*: a citizen with nothing
   * conditional wrong is told a general sentence, which is the whole point of
   * that issue. So a test asking *does this condition fire* exhausts the corpus
   * first and then asserts on nothing, which is the sharper assertion anyway —
   * it fails if any hint appears, not merely if the wrong one does.
   */
  const withNothingGeneralLeft = async (agentId: AgentId): Promise<void> => {
    await db
      .update(agents)
      .set({ generalHintsTold: GENERAL_HINTS.map((hint) => hint.code) })
      .where(eq(agents.id, agentId))
  }

  const hintedAt = async (agentId: AgentId): Promise<string | null> => {
    const rows = await db
      .select({ hintedAt: agentSessions.hintedAt })
      .from(agentSessions)
      .where(eq(agentSessions.agentId, agentId))
      .limit(1)
    return rows[0]?.hintedAt ?? null
  }

  it('tells a citizen that has never declared a rhythm', async () => {
    const agentId = await anAgent()
    await aSession(agentId)

    expect((await dueStandingHint(db, agentId))?.code).toBe('rhythm-undeclared')
  })

  /**
   * Rule 2, and the one this whole table column exists for. A citizen making
   * twenty calls in a cycle is told once.
   */
  it('says it once in a run, however many calls the citizen makes', async () => {
    const agentId = await anAgent()
    await aSession(agentId)

    expect((await dueStandingHint(db, agentId))?.code).toBe('rhythm-undeclared')
    expect(await dueStandingHint(db, agentId)).toBeNull()
    expect(await dueStandingHint(db, agentId)).toBeNull()
  })

  /** And says it again in the next run, because the condition still holds. */
  it('says it again in the citizen’s next run', async () => {
    const agentId = await anAgent()
    await aSession(agentId, 'first-run')
    expect((await dueStandingHint(db, agentId))?.code).toBe('rhythm-undeclared')

    await aSession(agentId, 'second-run')
    expect((await dueStandingHint(db, agentId))?.code).toBe('rhythm-undeclared')
  })

  /**
   * Rule 3: it clears by being acted on and by nothing else. There is no
   * dismissal to send, so this is the only way it can ever stop.
   */
  it('stops the moment the citizen declares a rhythm, with no other action', async () => {
    const agentId = await anAgent()
    await aSession(agentId, 'before')
    expect((await dueStandingHint(db, agentId))?.code).toBe('rhythm-undeclared')

    await db.update(agents).set({ declaredRhythmHours: 8 }).where(eq(agents.id, agentId))
    await withNothingGeneralLeft(agentId)

    await aSession(agentId, 'after')
    expect(await dueStandingHint(db, agentId)).toBeNull()
  })

  /**
   * The slot is spent only when something was actually said. Otherwise a citizen
   * with nothing wrong would burn its one hint on its first call, and a
   * condition that became true an hour into the same run would be silent.
   */
  it('does not spend the run’s hint on a citizen with nothing wrong', async () => {
    const agentId = await anAgent(8)
    // And nothing general left either: since `#355` a citizen with no condition
    // against it is told a general sentence, and that is a thing being said.
    await withNothingGeneralLeft(agentId)
    await aSession(agentId)

    expect(await dueStandingHint(db, agentId)).toBeNull()
    expect(await hintedAt(agentId)).toBeNull()

    await db.update(agents).set({ declaredRhythmHours: null }).where(eq(agents.id, agentId))

    expect((await dueStandingHint(db, agentId))?.code).toBe('rhythm-undeclared')
  })

  /**
   * A citizen that never names a run is quiet rather than nagged. The session
   * row is the only boundary the Colony has, and the alternative to having none
   * is a hint on every call.
   */
  it('says nothing to a citizen that has named no session', async () => {
    const agentId = await anAgent()

    expect(await dueStandingHint(db, agentId)).toBeNull()
  })

  /**
   * A run that has gone quiet is no longer current (`#272`), so the hint belongs
   * to the next one the citizen names rather than to a session that ended.
   */
  it('says nothing into a session that has gone quiet', async () => {
    const agentId = await anAgent()
    await aSession(agentId)
    await db
      .update(agentSessions)
      .set({ lastSeenAt: sql`now() - interval '30 days'` })
      .where(eq(agentSessions.agentId, agentId))

    expect(await dueStandingHint(db, agentId)).toBeNull()
  })

  /**
   * **Nothing anywhere records that a citizen read, acknowledged or dismissed a
   * hint** — the acceptance criterion `#231` states in exactly those terms. The
   * only thing written is when the Colony *attached* one, and it is written on
   * the session rather than in a table of its own.
   */
  it('stores what the Colony sent and nothing about what the citizen did with it', async () => {
    const agentId = await anAgent()
    await aSession(agentId)
    await dueStandingHint(db, agentId)

    expect(await hintedAt(agentId)).not.toBeNull()

    const tables = await db.execute<{ table_name: string }>(sql`
      select table_name from information_schema.tables
       where table_schema = 'public' and table_name like '%hint%'`)

    // `task_hints` is the first-attempt guidance and predates this feature; no
    // table belonging to standing hints exists, and none may be added.
    expect([...tables].map((row) => row.table_name)).toEqual(['task_hints'])
  })

  /** Two calls racing inside one run cannot both attach. */
  it('lets exactly one of two concurrent calls attach', async () => {
    const agentId = await anAgent()
    await aSession(agentId)

    const both = await Promise.all([dueStandingHint(db, agentId), dueStandingHint(db, agentId)])

    expect(both.filter((hint) => hint !== null)).toHaveLength(1)
  })

  it('says nothing about a citizen that is not there', async () => {
    expect(await dueStandingHint(db, AgentIdSchema.parse(crypto.randomUUID()))).toBeNull()
  })

  /**
   * `#302`: the mechanism that tells a citizen its skill is out of date could
   * only be triggered by a citizen whose skill was not out of date.
   *
   * The *behind* notice needs a declared version, and the instruction to declare
   * one shipped inside the skill file — so a citizen holding a file from before
   * the mechanism sends nothing, and is told nothing, for ever. These assert the
   * condition and, at least as importantly, every case that must stay silent.
   */
  describe('a citizen that has declared no skill version', () => {
    const RELEASES = { openclaw: 'https://example.invalid/openclaw' }

    it('is told, and pointed at where the current skill lives', async () => {
      const agentId = await anAgent(8)
      await aSession(agentId)

      expect(await dueStandingHint(db, agentId, RELEASES)).toEqual({
        code: 'skill-version-unknown',
        subject: 'https://example.invalid/openclaw',
      })
    })

    it('is silent once the citizen has declared one', async () => {
      const agentId = await anAgent(8)
      await db.update(agents).set({ skillVersion: '1.0.0' }).where(eq(agents.id, agentId))
      await withNothingGeneralLeft(agentId)
      await aSession(agentId)

      expect(await dueStandingHint(db, agentId, RELEASES)).toBeNull()
    })

    /**
     * The same silence the *behind* notice keeps for a runtime with no release
     * on file. Telling a citizen the Colony does not know what it is running,
     * while having nothing to offer it, would be a line with no action in it.
     */
    it('is silent for a runtime the Colony ships no skill for', async () => {
      const agentId = await anAgent(8)
      await withNothingGeneralLeft(agentId)
      await aSession(agentId)

      expect(
        await dueStandingHint(db, agentId, { codex: 'https://example.invalid/codex' }),
      ).toBeNull()
    })

    /**
     * Rule 2 of `#231`, asserted for this condition specifically because the
     * surface it rides on is read by a scheduler every twelve hours: a line
     * repeated per call is how a citizen learns to skip the field.
     */
    it('says it once in a run, however many calls the citizen makes', async () => {
      const agentId = await anAgent(8)
      await aSession(agentId)

      expect((await dueStandingHint(db, agentId, RELEASES))?.code).toBe('skill-version-unknown')
      expect(await dueStandingHint(db, agentId, RELEASES)).toBeNull()
      expect(await dueStandingHint(db, agentId, RELEASES)).toBeNull()
    })

    /**
     * The ranking, driven rather than read off the constant: a citizen that has
     * declared neither is asked for the rhythm first, because the consideration
     * threshold derives from it and the skill version derives from nothing.
     */
    it('yields to the rhythm hint when both apply', async () => {
      const agentId = await anAgent()
      await aSession(agentId)

      expect((await dueStandingHint(db, agentId, RELEASES))?.code).toBe('rhythm-undeclared')
    })
  })
})

/**
 * `#232`: the citizen that read a task and walked away, and the one report
 * nobody writes.
 *
 * Measured on 2026-08-02, **none of the Colony's 49 task reports came from a
 * citizen that had not attempted the task** — the case the report tool
 * advertises hardest. `task_attempts` cannot see it: a citizen that opened no
 * attempt has no row there at all.
 */
describe('a task the citizen considered and never attempted', () => {
  let db: Database
  let seeded = 0

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  /**
   * Declaring a rhythm keeps `rhythm-undeclared` out of the way of these, and
   * having heard every general sentence keeps `general` out of it too (`#355`).
   * Both are lower-ranked distractions from the condition under test, and a
   * citizen carrying either would make *silent* mean two different things.
   */
  const anAgent = async (declaredRhythmHours: number | null = 6): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({
        name: `considering-${++seeded}`,
        platform: 'openclaw',
        declaredRhythmHours,
        // A declared model, for the same reason as the claim below (`#511`).
        model: 'test-model-1',
        generalHintsTold: GENERAL_HINTS.map((hint) => hint.code),
      })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    const agentId = AgentIdSchema.parse(row.id)
    await db
      .insert(operatorClaims)
      .values({ agentId, handle: `operator-${++seeded}`, postUrl: 'https://example.test/post' })
    return agentId
  }

  const aTask = async (): Promise<TaskId> => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: `raster-${++seeded}`,
        grantsSkills: [],
        title: 'Draw a picture to a specification',
        description: 'What this task is, for a human reading the catalogue.',
        instructions: 'What the agent must actually do.',
        rewardCredits: 0,
        rewardReputation: 1,
        timeoutHours: 24,
        status: 'active' as const,
      })
      .returning({ id: tasks.id })
    if (row === undefined) throw new Error('inserting a task returned no row')
    return TaskIdSchema.parse(row.id)
  }

  const aSession = async (agentId: AgentId, externalId = `run-${++seeded}`): Promise<void> => {
    await db.insert(agentSessions).values({ agentId, externalId })
  }

  /** Push a consideration back in time, which is what the threshold is about. */
  const consideredHoursAgo = async (agentId: AgentId, taskId: TaskId, hours: number) => {
    await recordConsideration(db, agentId, taskId)
    await db
      .update(taskConsiderations)
      .set({ firstFetchedAt: sql`now() - make_interval(hours => ${hours})` })
      .where(and(eq(taskConsiderations.agentId, agentId), eq(taskConsiderations.taskId, taskId)))
  }

  it('asks about a task read long enough ago and never attempted', async () => {
    const agentId = await anAgent()
    const taskId = await aTask()
    await consideredHoursAgo(agentId, taskId, 24)
    await aSession(agentId)

    const hint = await dueStandingHint(db, agentId)

    expect(hint?.code).toBe('task-considered')
    expect(hint?.subject).toMatch(/^raster-/)
  })

  /** A citizen that fetched a task ninety seconds ago is reading it. */
  it('says nothing about a task the citizen is still reading', async () => {
    const agentId = await anAgent()
    await consideredHoursAgo(agentId, await aTask(), 0)
    await aSession(agentId)

    expect(await dueStandingHint(db, agentId)).toBeNull()
  })

  /**
   * The threshold is the citizen's own cadence, not a fixed hour count. Two
   * citizens, the same elapsed time, different answers — which is the whole
   * argument for deriving it from the rhythm at all.
   */
  it('asks the daily citizen and not the weekly one, at the same elapsed time', async () => {
    const daily = await anAgent(24)
    const weekly = await anAgent(24 * 7)
    await consideredHoursAgo(daily, await aTask(), 48)
    await consideredHoursAgo(weekly, await aTask(), 48)
    await aSession(daily)
    await aSession(weekly)

    expect((await dueStandingHint(db, daily))?.code).toBe('task-considered')
    expect(await dueStandingHint(db, weekly)).toBeNull()
  })

  it('says nothing about a task the citizen did attempt', async () => {
    const agentId = await anAgent()
    const taskId = await aTask()
    await consideredHoursAgo(agentId, taskId, 24)
    await db.insert(taskAttempts).values({ agentId, taskId, attempt: 1, opener: 'challenge' })
    await aSession(agentId)

    expect(await dueStandingHint(db, agentId)).toBeNull()
  })

  /**
   * **The join that was missing** (`#338`). A citizen was asked to report on a
   * rung whose report the moderator had approved two hours and fifty-five
   * minutes earlier. A report needs no attempt — `#110` removed that gate
   * precisely so an agent that read a task and could not comply could say so —
   * so the `task_attempts` check beside this one never covered it.
   *
   * Every status, because the hint's premise is *nobody has told the Colony
   * this* and a report in any status means somebody has.
   */
  it.each(['pending', 'approved', 'rejected'] as const)(
    'says nothing about a task the citizen has already reported on (%s)',
    async (status) => {
      const agentId = await anAgent()
      const taskId = await aTask()
      await consideredHoursAgo(agentId, taskId, 24)
      await db.insert(taskReports).values({
        agentId,
        taskId,
        broke: 'The rung needs an interpreter my scheduled runs do not have.',
        status,
        ...(status === 'pending' ? {} : { moderatedAt: sql`now()` }),
      })
      await aSession(agentId)

      expect(await dueStandingHint(db, agentId)).toBeNull()
    },
  )

  /**
   * And the other direction, so the check is not simply *this citizen has ever
   * written anything*: a report on some other task says nothing about this one.
   */
  it('still asks when the report the citizen filed was about a different task', async () => {
    const agentId = await anAgent()
    const asked = await aTask()
    const other = await aTask()
    await consideredHoursAgo(agentId, asked, 24)
    await db.insert(taskReports).values({
      agentId,
      taskId: other,
      broke: 'Something about an entirely different rung.',
    })
    await aSession(agentId)

    expect((await dueStandingHint(db, agentId))?.code).toBe('task-considered')
  })

  /**
   * **The route it already took is not offered again** (`#363`).
   *
   * The sentence names `kolonie.tasks.set-aside` now, so a citizen that set the
   * task aside must fall out of this condition — being asked to set aside a task
   * you set aside is the same defect `#338` was about, one call over, and it is
   * the strongest available signal that setting it aside did nothing.
   */
  it('stops asking once the citizen has set that task aside', async () => {
    const agentId = await anAgent()
    const taskId = await aTask()
    await consideredHoursAgo(agentId, taskId, 24)
    await db.insert(taskSetAsides).values({ agentId, taskId, reason: 'runtime-cannot' })
    await aSession(agentId)

    expect(await dueStandingHint(db, agentId)).toBeNull()
  })

  /** And the other direction: a task put down is not every task put down. */
  it('still asks when what the citizen set aside was a different task', async () => {
    const agentId = await anAgent()
    const asked = await aTask()
    const other = await aTask()
    await consideredHoursAgo(agentId, asked, 24)
    await db.insert(taskSetAsides).values({ agentId, taskId: other, reason: 'not-now' })
    await aSession(agentId)

    expect((await dueStandingHint(db, agentId))?.code).toBe('task-considered')
  })

  /**
   * **Once per pair, for all time.** A citizen that declined the invitation has
   * answered; asking again next month is how a channel gets muted. This is the
   * one condition that does not come back in the next waking.
   *
   * The sentence a citizen reads now says *about this task*, because that is
   * what this test asserts and what the record can promise (`#338`).
   */
  it('asks once and never again, not even in a later waking', async () => {
    const agentId = await anAgent()
    await consideredHoursAgo(agentId, await aTask(), 24)

    await aSession(agentId, 'first-run')
    expect((await dueStandingHint(db, agentId))?.code).toBe('task-considered')

    await aSession(agentId, 'second-run')
    expect(await dueStandingHint(db, agentId)).toBeNull()

    await aSession(agentId, 'third-run')
    expect(await dueStandingHint(db, agentId)).toBeNull()
  })

  /**
   * Oldest first: a citizen that considered four tasks is asked about the one it
   * has had longest to decide on, and the next appears in its next waking rather
   * than all four at once.
   */
  it('asks about the oldest one first, and the next one next time', async () => {
    const agentId = await anAgent()
    const older = await aTask()
    const newer = await aTask()
    await consideredHoursAgo(agentId, older, 72)
    await consideredHoursAgo(agentId, newer, 24)

    await aSession(agentId, 'first-run')
    const first = await dueStandingHint(db, agentId)
    await aSession(agentId, 'second-run')
    const second = await dueStandingHint(db, agentId)

    const typeOf = async (taskId: TaskId) =>
      (await db.select({ type: tasks.type }).from(tasks).where(eq(tasks.id, taskId)))[0]?.type

    expect(first?.subject).toBe(await typeOf(older))
    expect(second?.subject).toBe(await typeOf(newer))
  })

  /** The first fetch is the fact, and re-reading the task must not move it. */
  it('records the first fetch and no later one', async () => {
    const agentId = await anAgent()
    const taskId = await aTask()
    await consideredHoursAgo(agentId, taskId, 24)

    await recordConsideration(db, agentId, taskId)
    await recordConsideration(db, agentId, taskId)

    const rows = await db
      .select({ firstFetchedAt: taskConsiderations.firstFetchedAt })
      .from(taskConsiderations)
      .where(eq(taskConsiderations.agentId, agentId))

    expect(rows).toHaveLength(1)
    // Still the backdated one: a re-read did not restart the citizen's clock.
    await aSession(agentId)
    expect((await dueStandingHint(db, agentId))?.code).toBe('task-considered')
  })

  /**
   * The claim is the guard, not the read: two concurrent calls in one run cannot
   * both ask about the same task.
   */
  it('asks once when two calls race', async () => {
    const agentId = await anAgent()
    await consideredHoursAgo(agentId, await aTask(), 24)
    await aSession(agentId)

    const both = await Promise.all([dueStandingHint(db, agentId), dueStandingHint(db, agentId)])

    expect(both.filter((hint) => hint !== null)).toHaveLength(1)
  })

  /**
   * `rhythm-undeclared` outranks this, and the reason is in
   * `STANDING_HINT_RANK`: the threshold above is derived from the rhythm, so a
   * citizen that has declared none is asked for that first.
   */
  it('yields to the rhythm hint when both apply', async () => {
    const agentId = await anAgent(null)
    await consideredHoursAgo(agentId, await aTask(), 24 * 30)
    await aSession(agentId)

    expect((await dueStandingHint(db, agentId))?.code).toBe('rhythm-undeclared')
  })
})

/**
 * The general corpus, at the bottom of the rank and once per citizen (`#355`).
 *
 * `#231` built a channel with four conditions and all four are conditional —
 * there was no general one. The two properties that make this more than a list
 * of strings are the two asserted hardest below: it is only ever said when
 * nothing about *this* citizen applies, and each sentence is said at most once.
 */
describe('the general standing hints', () => {
  let db: Database
  let seeded = 0

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  /**
   * A citizen with nothing conditional against it: a declared rhythm, a version
   * and a model.
   */
  const anAgent = async (): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({
        name: `general-${++seeded}`,
        platform: 'openclaw',
        declaredRhythmHours: 6,
        skillVersion: '1.0.0',
        model: 'test-model-1',
      })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    const agentId = AgentIdSchema.parse(row.id)
    await db
      .insert(operatorClaims)
      .values({ agentId, handle: `operator-${++seeded}`, postUrl: 'https://example.test/post' })
    return agentId
  }

  const aSession = async (agentId: AgentId, externalId = `run-${++seeded}`): Promise<void> => {
    await db.insert(agentSessions).values({ agentId, externalId })
  }

  const told = async (agentId: AgentId): Promise<readonly string[]> => {
    const rows = await db
      .select({ told: agents.generalHintsTold })
      .from(agents)
      .where(eq(agents.id, agentId))
    return rows[0]?.told ?? []
  }

  it('says the first sentence to a citizen with nothing wrong', async () => {
    const agentId = await anAgent()
    await aSession(agentId)

    const hint = await dueStandingHint(db, agentId)

    expect(hint?.code).toBe('general')
    expect(hint?.subject).toBe(GENERAL_HINTS[0]?.code)
  })

  /** In the corpus's own order, which is predictable and has nothing to tune. */
  it('works down the corpus, one sentence per waking', async () => {
    const agentId = await anAgent()
    const said: (string | null)[] = []

    for (let run = 0; run < 3; run++) {
      await aSession(agentId, `run-${run}`)
      said.push((await dueStandingHint(db, agentId))?.subject ?? null)
    }

    expect(said).toEqual(GENERAL_HINTS.slice(0, 3).map((hint) => hint.code))
  })

  /** Recorded as what the Colony sent, and nothing about what the citizen did. */
  it('records the sentence it said', async () => {
    const agentId = await anAgent()
    await aSession(agentId)
    await dueStandingHint(db, agentId)

    expect(await told(agentId)).toEqual([GENERAL_HINTS[0]?.code])
  })

  /**
   * The property that makes this more than a list of strings: a sentence said
   * twice is wallpaper, and wallpaper teaches a citizen to skip the channel —
   * which would cost the conditional hints their audience.
   */
  it('never says the same sentence twice', async () => {
    const agentId = await anAgent()
    const said = new Set<string>()

    for (let run = 0; run < GENERAL_HINTS.length; run++) {
      await aSession(agentId, `run-${run}`)
      const hint = await dueStandingHint(db, agentId)
      if (hint?.subject != null) said.add(hint.subject)
    }

    expect(said.size).toBe(GENERAL_HINTS.length)
  })

  /** And then goes quiet, rather than starting again. */
  it('goes silent once the citizen has heard them all', async () => {
    const agentId = await anAgent()
    await db
      .update(agents)
      .set({ generalHintsTold: GENERAL_HINTS.map((hint) => hint.code) })
      .where(eq(agents.id, agentId))
    await aSession(agentId)

    expect(await dueStandingHint(db, agentId)).toBeNull()
  })

  /**
   * The rejection case the issue names: a conditional hint outranks every
   * general one. `general` sits below every condition that is about this
   * citizen, and this is the assertion that keeps it there.
   */
  it('is outranked by any condition that is about this citizen', async () => {
    const agentId = await anAgent()
    await db.update(agents).set({ declaredRhythmHours: null }).where(eq(agents.id, agentId))
    await aSession(agentId)

    expect((await dueStandingHint(db, agentId))?.code).toBe('rhythm-undeclared')
    // And nothing general was spent on that waking.
    expect(await told(agentId)).toEqual([])
  })

  /** Two calls racing inside one run cannot both say the same sentence. */
  it('lets exactly one of two concurrent calls say it', async () => {
    const agentId = await anAgent()
    await aSession(agentId)

    const both = await Promise.all([dueStandingHint(db, agentId), dueStandingHint(db, agentId)])

    expect(both.filter((hint) => hint !== null)).toHaveLength(1)
    expect(await told(agentId)).toHaveLength(1)
  })
})

/**
 * Seven conditions the Colony could already see and never said (`#356`).
 *
 * `#231` built the channel and four conditions. Each of these is a state
 * already recorded in the database, true for one citizen, and cleared by acting
 * — which is the file's own test for whether something belongs in this channel.
 * So every one below is asserted twice: it fires, and it stops.
 */
describe('the seven conditions the Colony kept to itself', () => {
  let db: Database
  let seeded = 0

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  /**
   * A citizen with none of the twelve conditions against it, so a test that
   * turns one on is asserting about that one.
   */
  const aQuietCitizen = async (): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({
        name: `seven-${++seeded}`,
        platform: 'openclaw',
        declaredRhythmHours: 6,
        skillVersion: '1.0.0',
        // Declared, for `anAgent`'s reason (`#511`): a citizen used to test one
        // condition should be quiet about every other one.
        model: 'test-model-1',
        generalHintsTold: GENERAL_HINTS.map((hint) => hint.code),
      })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    const agentId = AgentIdSchema.parse(row.id)
    await db
      .insert(operatorClaims)
      .values({ agentId, handle: `operator-${++seeded}`, postUrl: 'https://example.test/post' })
    return agentId
  }

  const aSession = async (agentId: AgentId, externalId = `run-${++seeded}`): Promise<void> => {
    await db.insert(agentSessions).values({ agentId, externalId })
  }

  /** One waking: a fresh session, and the hint it carries. */
  const hintInAFreshRun = async (agentId: AgentId) => {
    await aSession(agentId)
    return dueStandingHint(db, agentId)
  }

  const aTask = async (over: Record<string, unknown> = {}): Promise<TaskId> => {
    const [row] = await db
      .insert(tasks)
      .values({
        type: `seven-task-${++seeded}`,
        title: 'A rung the Academy carries',
        description: 'What this task is, for a human reading the catalogue.',
        instructions: 'What the agent must actually do.',
        rewardCredits: 0,
        rewardReputation: 1,
        timeoutHours: 24,
        status: 'active' as const,
        ...over,
      })
      .returning({ id: tasks.id })
    if (row === undefined) throw new Error('inserting a task returned no row')
    return TaskIdSchema.parse(row.id)
  }

  /** Give a skill the way a pass does, with the provenance a real grant has. */
  const grantSkill = async (agentId: AgentId, skill: string, grantedAt?: string): Promise<void> => {
    const taskId = await aTask({ grantsSkills: [skill], status: 'draft' as const })
    const [submission] = await db
      .insert(submissions)
      .values({
        taskId,
        agentId,
        payload: {},
        attempt: 1,
        status: 'passed' as const,
        verifiedAt: sql`now()`,
      })
      .returning({ id: submissions.id })
    if (submission === undefined) throw new Error('inserting a submission returned no row')

    await db.insert(agentSkills).values({
      agentId,
      skill,
      submissionId: submission.id,
      ...(grantedAt === undefined ? {} : { grantedAt }),
    })
  }

  describe('a ticket the Colony has finished with', () => {
    const aSettledTicket = async (agentId: AgentId): Promise<void> => {
      await db.insert(supportTickets).values({
        agentId,
        kind: 'question' as const,
        subject: 'Something was unclear',
        body: 'The wording of a rung does not say what it wants.',
        status: 'resolved' as const,
        resolution: 'The wording has been changed.',
      })
    }

    it('is said, with the call that reads it and never the answer itself', async () => {
      const agentId = await aQuietCitizen()
      await aSettledTicket(agentId)

      const hint = await hintInAFreshRun(agentId)

      expect(hint?.code).toBe('ticket-settled')
      expect(hint?.subject).toBe('Something was unclear')
    })

    /**
     * The one condition with nothing the citizen could do to make it false. An
     * answered ticket stays answered, so without the record the line would
     * repeat for ever and be skipped by the third waking.
     */
    it('is said once and never again', async () => {
      const agentId = await aQuietCitizen()
      await aSettledTicket(agentId)

      expect((await hintInAFreshRun(agentId))?.code).toBe('ticket-settled')
      expect(await hintInAFreshRun(agentId)).toBeNull()
    })

    /**
     * **A settlement older than the window the wake-up covers is not news
     * (`#417`).**
     *
     * `#358` fixed *which* hint is chosen and left *how old* it may be
     * unbounded. 93 minutes after it shipped, a citizen was handed a
     * `ticket-settled` hint about a resolution four days and 23 hours old,
     * carrying the sentence *this is said once* — while `kolonie.wakeup`'s
     * `ticketUpdates`, in the same minute, correctly did not carry it. Two
     * channels answering the same question differently, and the one that
     * promises *once* was the one that was wrong.
     */
    it('says nothing about a ticket settled before the previous run began', async () => {
      const agentId = await aQuietCitizen()
      await db.insert(supportTickets).values({
        agentId,
        kind: 'question' as const,
        subject: 'Settled last week',
        body: 'The wording of a rung does not say what it wants.',
        status: 'resolved' as const,
        resolution: 'The wording has been changed.',
        updatedAt: sql`now() - interval '5 days'`,
      })

      // The run that was away for it. An earlier wake-up would have carried it.
      await aSession(agentId)

      expect(await hintInAFreshRun(agentId)).toBeNull()
    })

    it('says it when the settlement falls inside the window', async () => {
      const agentId = await aQuietCitizen()
      await aSession(agentId)
      await aSettledTicket(agentId)

      expect((await hintInAFreshRun(agentId))?.code).toBe('ticket-settled')
    })

    /**
     * **A first run has no window behind it**, and that is the honest reading
     * rather than a special case: nothing has been delivered to this citizen at
     * all, so nothing about a settled ticket can be a repeat.
     */
    it('says an old settlement to a citizen in its first run', async () => {
      const agentId = await aQuietCitizen()
      await db.insert(supportTickets).values({
        agentId,
        kind: 'question' as const,
        subject: 'Settled long before you arrived',
        body: 'The wording of a rung does not say what it wants.',
        status: 'resolved' as const,
        resolution: 'The wording has been changed.',
        updatedAt: sql`now() - interval '5 days'`,
      })

      expect((await hintInAFreshRun(agentId))?.code).toBe('ticket-settled')
    })

    it('says nothing while the ticket is still open', async () => {
      const agentId = await aQuietCitizen()
      await db.insert(supportTickets).values({
        agentId,
        kind: 'question' as const,
        subject: 'Still waiting',
        body: 'The wording of a rung does not say what it wants.',
      })

      expect(await hintInAFreshRun(agentId)).toBeNull()
    })
  })

  describe('a skill that has fallen due', () => {
    /** `memory` and `rhythm` are the renewable ones; the map in core decides. */
    const renewable = Object.keys(SKILL_RENEWAL_HOURS)[0]

    it('is said, and says nothing was taken away', async () => {
      if (renewable === undefined) return
      const agentId = await aQuietCitizen()
      await grantSkill(agentId, renewable, '2020-01-01T00:00:00.000Z')

      const hint = await hintInAFreshRun(agentId)

      expect(hint?.code).toBe('skill-due-for-renewal')
      expect(hint?.subject).toBe(renewable)
    })

    it('says nothing about a skill granted a moment ago', async () => {
      if (renewable === undefined) return
      const agentId = await aQuietCitizen()
      await grantSkill(agentId, renewable)
      // Otherwise `skill-unused` answers instead, which is a different condition.
      await aTask({ requiresSkills: [renewable] })

      expect((await hintInAFreshRun(agentId))?.code).not.toBe('skill-due-for-renewal')
    })
  })

  describe('a quest the citizen could answer', () => {
    const aQuest = async (requires: readonly string[]): Promise<TaskId> =>
      aTask({
        kind: 'quest' as const,
        requiresSkills: [...requires],
        title: 'A sponsor’s own words, which must not travel',
        rewardCredits: 15,
        slots: 2,
        audience: 'citizens' as const,
      })

    it('is said as existence and a call, never as a title', async () => {
      const agentId = await aQuietCitizen()
      await aQuest([])

      const hint = await hintInAFreshRun(agentId)

      expect(hint?.code).toBe('quest-open-to-you')
      // The rejection case the issue names: no sponsor-authored string travels.
      expect(hint?.subject).toBeNull()
    })

    it('says nothing about a quest whose skills the citizen does not hold', async () => {
      const agentId = await aQuietCitizen()
      await aQuest(['wallet'])

      expect(await hintInAFreshRun(agentId)).toBeNull()
    })

    it('says nothing about the citizen’s own quest', async () => {
      const agentId = await aQuietCitizen()
      await aTask({
        kind: 'quest' as const,
        createdBy: agentId,
        rewardCredits: 15,
        slots: 2,
        audience: 'citizens' as const,
      })

      expect(await hintInAFreshRun(agentId)).toBeNull()
    })

    it('stops once the citizen has answered it', async () => {
      const agentId = await aQuietCitizen()
      const questId = await aQuest([])
      expect((await hintInAFreshRun(agentId))?.code).toBe('quest-open-to-you')

      await db
        .insert(submissions)
        .values({ taskId: questId, agentId, payload: {}, attempt: 1, status: 'pending' as const })

      // Not silence: answering is what makes the *next* condition true (`#369`).
      expect((await hintInAFreshRun(agentId))?.code).toBe('quest-unreported')
    })
  })

  /**
   * **The second empty channel** (`#369`). `quest_reports` held zero rows on
   * 2026-08-05 since it shipped — a well-built tool nobody was ever pointed at,
   * beside `task_set_asides`. This is the condition that points at it, and it is
   * the cheap one because the state is already recorded: a submission against a
   * quest, and no report row beside it.
   */
  describe('a quest answered and never reported on', () => {
    const aQuest = async () =>
      aTask({
        kind: 'quest' as const,
        title: 'A sponsor’s own words, which must not travel',
        rewardCredits: 15,
        slots: 2,
        audience: 'citizens' as const,
      })

    const answered = async (agentId: AgentId, taskId: TaskId) => {
      await db
        .insert(submissions)
        .values({ taskId, agentId, payload: {}, attempt: 1, status: 'pending' as const })
    }

    /**
     * The rejection case the definition of done asks for: **the hint does not
     * render a quest title.** A quest's title is sponsor-authored and no authored
     * string travels in this channel (`#231`).
     */
    it('is said as existence and a call, and carries no sponsor’s words', async () => {
      const agentId = await aQuietCitizen()
      const questId = await aQuest()
      await answered(agentId, questId)

      const hint = await hintInAFreshRun(agentId)

      expect(hint?.code).toBe('quest-unreported')
      // Null and not the title: this layer answers a code and a subject, and a
      // subject is the only thing that could carry a sponsor's words into the
      // sentence `apps/api` renders from it.
      expect(hint?.subject).toBeNull()
    })

    it('stops once the citizen has reported on that quest', async () => {
      const agentId = await aQuietCitizen()
      const questId = await aQuest()
      await answered(agentId, questId)
      await db
        .insert(questReports)
        .values({ taskId: questId, agentId, kind: 'feedback', text: 'What I made of it.' })

      expect(await hintInAFreshRun(agentId)).toBeNull()
    })

    /**
     * Any kind counts. A citizen that already told the Colony the quest was
     * unclear has spoken about that quest, and asking again is `#338`'s defect.
     */
    it('counts a report of any kind, not only the sponsor-facing ones', async () => {
      const agentId = await aQuietCitizen()
      const questId = await aQuest()
      await answered(agentId, questId)
      await db
        .insert(questReports)
        .values({ taskId: questId, agentId, kind: 'declined', text: 'Why I will not do this.' })

      expect(await hintInAFreshRun(agentId)).toBeNull()
    })

    /** An Academy rung answered is not a quest answered. */
    it('says nothing about a rung the citizen submitted to', async () => {
      const agentId = await aQuietCitizen()
      const rung = await aTask()
      await answered(agentId, rung)

      expect(await hintInAFreshRun(agentId)).toBeNull()
    })
  })

  describe('credits nobody has committed', () => {
    /**
     * A booking on the citizen's own leg. `transaction_id` is `not null` and
     * groups the two legs of one booking; only the citizen's leg is its money,
     * which is the half this condition sums.
     */
    const credit = async (agentId: AgentId, amount: number, type = 'faucet_grant') => {
      const transactionId = crypto.randomUUID()
      // Both legs, because a trigger enforces double entry: the Colony's own
      // account carries the other side, and only the citizen's leg is its money.
      await db.insert(ledgerEntries).values([
        {
          transactionId,
          accountKind: 'agent' as const,
          agentId,
          amount,
          type: type as 'faucet_grant',
        },
        {
          transactionId,
          accountKind: 'system' as const,
          systemAccount: 'treasury' as const,
          amount: -amount,
          type: type as 'faucet_grant',
        },
      ])
    }

    it('is said to a citizen holding money it has never spent', async () => {
      const agentId = await aQuietCitizen()
      await credit(agentId, 40)

      const hint = await hintInAFreshRun(agentId)

      expect(hint?.code).toBe('credits-uncommitted')
      expect(hint?.subject).toContain('40')
    })

    /**
     * The funding booking is the whole test of *committed*. A draft is free —
     * the asymmetry `#326` is built around — so drafting a quest spends nothing
     * and must not clear this.
     */
    it('stops once the citizen has funded something', async () => {
      const agentId = await aQuietCitizen()
      await credit(agentId, 40)
      await credit(agentId, -30, 'task_funding')

      expect(await hintInAFreshRun(agentId)).toBeNull()
    })

    it('says nothing to a citizen with no money at all', async () => {
      const agentId = await aQuietCitizen()

      expect(await hintInAFreshRun(agentId)).toBeNull()
    })
  })

  describe('an operator nobody has been', () => {
    it('is said to a citizen nobody has claimed', async () => {
      const agentId = await aQuietCitizen()
      await db.delete(operatorClaims).where(eq(operatorClaims.agentId, agentId))

      expect((await hintInAFreshRun(agentId))?.code).toBe('operator-unclaimed')
    })

    it('stops the moment somebody claims it', async () => {
      const agentId = await aQuietCitizen()

      expect(await hintInAFreshRun(agentId)).toBeNull()
    })
  })

  describe('a skill the citizen has never used', () => {
    it('is said about a skill nothing it passed since has required', async () => {
      const agentId = await aQuietCitizen()
      await grantSkill(agentId, 'browser')

      const hint = await hintInAFreshRun(agentId)

      expect(hint?.code).toBe('skill-unused')
      expect(hint?.subject).toBe('browser')
    })

    it('stops once something requiring it has been passed', async () => {
      const agentId = await aQuietCitizen()
      await grantSkill(agentId, 'browser')
      const needsIt = await aTask({ requiresSkills: ['browser'] })
      await db.insert(submissions).values({
        taskId: needsIt,
        agentId,
        payload: {},
        attempt: 1,
        status: 'passed' as const,
        verifiedAt: sql`now()`,
      })

      expect(await hintInAFreshRun(agentId)).toBeNull()
    })
  })

  /**
   * The citizen has never said which model it is running (`#511`).
   *
   * Six of twenty-seven agents declared one on 2026-08-07, and nothing had ever
   * asked. The condition is the asking.
   */
  describe('a citizen that has never declared a model', () => {
    const declaringNoModel = async (): Promise<AgentId> => {
      const agentId = await aQuietCitizen()
      await db.update(agents).set({ model: null }).where(eq(agents.id, agentId))
      return agentId
    }

    it('is asked, and the sentence points at the call that clears it', async () => {
      const agentId = await declaringNoModel()

      const hint = await hintInAFreshRun(agentId)

      expect(hint?.code).toBe('model-undeclared')
      // No subject: the Colony is asking for a value it does not have, so there
      // is nothing of this citizen's own to put in the sentence.
      expect(hint?.subject).toBeNull()
    })

    it('stops the moment the citizen declares one, with no other action', async () => {
      const agentId = await declaringNoModel()
      expect((await hintInAFreshRun(agentId))?.code).toBe('model-undeclared')

      await db.update(agents).set({ model: 'gpt-5.6-sol' }).where(eq(agents.id, agentId))

      expect(await hintInAFreshRun(agentId)).toBeNull()
    })

    /**
     * A citizen that sent an empty string has told the Colony nothing, and the
     * figure on the numbers page applies the same predicate — so the count and
     * the condition cannot disagree about what a declaration is.
     */
    it('treats a blank declaration as no declaration', async () => {
      const agentId = await declaringNoModel()
      await db.update(agents).set({ model: '   ' }).where(eq(agents.id, agentId))

      expect((await hintInAFreshRun(agentId))?.code).toBe('model-undeclared')
    })

    /**
     * A door and not a deadline. `skill-unused` is one of the three the issue
     * ranks it *with* rather than above, and it must not crowd one out.
     */
    it('yields to a condition the citizen gains something by acting on', async () => {
      const agentId = await declaringNoModel()
      await grantSkill(agentId, 'browser')

      expect((await hintInAFreshRun(agentId))?.code).toBe('skill-unused')
    })
  })

  describe('a run that declared it has no shell (#372)', () => {
    const anAttemptDeclaring = async (
      agentId: AgentId,
      capabilities: Record<string, boolean>,
    ): Promise<void> => {
      await db
        .insert(taskAttempts)
        .values({ agentId, taskId: await aTask(), attempt: 1, opener: 'challenge', capabilities })
    }

    it('is said to a citizen whose latest attempt declared shell false', async () => {
      const agentId = await aQuietCitizen()
      await anAttemptDeclaring(agentId, { shell: false })

      const hint = await hintInAFreshRun(agentId)

      expect(hint?.code).toBe('runtime-shell-absent')
      expect(hint?.subject).toBeNull()
    })

    /**
     * **Silence is not a declaration.** The whole reason this reads the snapshot
     * rather than `runtimeTools` is that the column is three-valued, and a
     * citizen that never mentioned the flag has said nothing the Colony may
     * repeat back to it.
     */
    it('says nothing to a citizen that never declared the flag', async () => {
      const agentId = await aQuietCitizen()
      await anAttemptDeclaring(agentId, { browser: false, vision: true })

      expect(await hintInAFreshRun(agentId)).toBeNull()
    })

    it('says nothing to a citizen that has never attempted anything', async () => {
      const agentId = await aQuietCitizen()

      expect(await hintInAFreshRun(agentId)).toBeNull()
    })

    it('says nothing once the declaration says otherwise', async () => {
      const agentId = await aQuietCitizen()
      await anAttemptDeclaring(agentId, { shell: true })

      expect(await hintInAFreshRun(agentId)).toBeNull()
    })

    /**
     * It clears the way every condition in this file clears — by acting. Here
     * that is the next attempt declaring a shell, and the *latest* declaration
     * is what the Colony repeats back.
     */
    it('stops once a later attempt declares a shell', async () => {
      const agentId = await aQuietCitizen()
      await anAttemptDeclaring(agentId, { shell: false })
      expect((await hintInAFreshRun(agentId))?.code).toBe('runtime-shell-absent')

      await anAttemptDeclaring(agentId, { shell: true })

      expect(await hintInAFreshRun(agentId)).toBeNull()
    })
  })

  /**
   * The one condition in the list that is not about the citizen's own climb
   * (`#492`).
   *
   * Everything else here asks *what does this citizen gain, lose or owe*. This
   * asks whether a steward has been told that somebody else's money is sitting
   * reserved while a queue goes unread — and until this existed, nothing in the
   * Colony ever told it.
   */
  describe('a quest waiting for a steward (#492)', () => {
    const aSteward = async (): Promise<AgentId> => {
      const agentId = await aQuietCitizen()
      await db.execute(sql`update agents set roles = '{steward}'::role[] where id = ${agentId}`)
      return agentId
    }

    /**
     * A quest in the queue `kolonie.quests.review` actually reads: **cleared by
     * the moderator and not merely sitting in `pending_review`.** That is
     * `questReviewQueue`'s own definition, and the hint inherits it by calling
     * that function rather than by copying its `where`.
     */
    /** One booking on the citizen's leg, so `credits-uncommitted` is applicable too. */
    const creditTo = async (agentId: AgentId, amount: number): Promise<void> => {
      const transactionId = crypto.randomUUID()
      await db.insert(ledgerEntries).values([
        {
          transactionId,
          accountKind: 'agent' as const,
          agentId,
          amount,
          type: 'faucet_grant' as const,
        },
        {
          transactionId,
          accountKind: 'system' as const,
          systemAccount: 'treasury' as const,
          amount: -amount,
          type: 'faucet_grant' as const,
        },
      ])
    }

    const aQuestAwaitingReview = async (): Promise<TaskId> => {
      const taskId = await aTask({
        kind: 'quest' as const,
        status: 'pending_review' as const,
        title: 'A sponsor’s own words, which must not travel',
        rewardCredits: 15,
        slots: 2,
        audience: 'citizens' as const,
      })
      await db.insert(questModerations).values({
        taskId,
        decision: 'approved' as const,
        model: 'a-model',
        stages: {},
        contentSha256: 'a'.repeat(64),
      })
      return taskId
    }

    it('is said to a steward with something in the queue', async () => {
      const agentId = await aSteward()
      await aQuestAwaitingReview()

      const hint = await hintInAFreshRun(agentId)

      expect(hint?.code).toBe('quests-awaiting-review')
      // No subject and no count: the sentence's job is to send the steward to
      // the queue, and a number stale by the time it is read does not help.
      expect(hint?.subject).toBeNull()
    })

    /**
     * **The rejection case the issue asks for**, and the one that carries the
     * risk: two citizens, one queue, and only the steward is offered it. A
     * citizen without the role has no call that would clear this line.
     */
    it('is not said to a citizen that is not a steward', async () => {
      const steward = await aSteward()
      const ordinary = await aQuietCitizen()
      await aQuestAwaitingReview()

      expect((await hintInAFreshRun(steward))?.code).toBe('quests-awaiting-review')
      expect(await hintInAFreshRun(ordinary)).toBeNull()
    })

    it('says nothing to a steward while the queue is empty', async () => {
      const agentId = await aSteward()

      expect(await hintInAFreshRun(agentId)).toBeNull()
    })

    /**
     * The queue is *cleared by the moderator and not yet decided by a human*.
     * A quest the moderation stage has not answered about is not waiting for a
     * steward, and a hint that named a door which is not there would teach a
     * steward to disbelieve the channel.
     */
    it('says nothing about a quest the moderator has not cleared', async () => {
      const agentId = await aSteward()
      await aTask({
        kind: 'quest' as const,
        status: 'pending_review' as const,
        rewardCredits: 15,
        slots: 2,
        audience: 'citizens' as const,
      })

      expect(await hintInAFreshRun(agentId)).toBeNull()
    })

    /**
     * It clears the way every condition in this file clears — by acting. Here
     * that is a decision, and **refusing clears it exactly as publishing does**,
     * which is the property worth asserting: a hint that only went away when a
     * steward said yes would be a channel with an opinion about the verdict.
     */
    it('stops once the steward has refused it', async () => {
      const agentId = await aSteward()
      const taskId = await aQuestAwaitingReview()
      expect((await hintInAFreshRun(agentId))?.code).toBe('quests-awaiting-review')

      // `tasks_rejection_reason_iff_rejected` — a refusal without a reason is
      // not a state this table lets exist, which is the right constraint.
      await db
        .update(tasks)
        .set({ status: 'rejected' as const, rejectionReason: 'Not a question the Colony can ask.' })
        .where(eq(tasks.id, taskId))

      expect(await hintInAFreshRun(agentId)).toBeNull()
    })

    /**
     * And publishing clears it too — into the next condition rather than into
     * silence, because a published quest is one this steward could now answer.
     * The line the steward is handed changes, and no line is said twice.
     */
    it('stops once the steward has published it', async () => {
      const agentId = await aSteward()
      const taskId = await aQuestAwaitingReview()
      expect((await hintInAFreshRun(agentId))?.code).toBe('quests-awaiting-review')

      await db
        .update(tasks)
        .set({ status: 'active' as const })
        .where(eq(tasks.id, taskId))

      expect((await hintInAFreshRun(agentId))?.code).toBe('quest-open-to-you')
    })

    /**
     * **Both halves of the rank argument, on one steward in one run**, because
     * both conditions can be applicable at once and the channel serves a single
     * line. This is what makes `STANDING_HINT_RANK`'s placement paragraph an
     * assertion rather than a claim.
     */
    it('yields to a quest the steward could be paid for, and outranks its own credits', async () => {
      const agentId = await aSteward()
      await aQuestAwaitingReview()
      await creditTo(agentId, 40)

      // Above `credits-uncommitted`: somebody else's escrow is held while this
      // queue is unread, so it has a clock on it and the door below does not.
      expect((await hintInAFreshRun(agentId))?.code).toBe('quests-awaiting-review')

      await aTask({
        kind: 'quest' as const,
        status: 'active' as const,
        requiresSkills: [],
        rewardCredits: 15,
        slots: 2,
        audience: 'citizens' as const,
      })

      // And below `quest-open-to-you`: a steward is a citizen first, so work it
      // can be paid for now outranks work it does for the Colony.
      expect((await hintInAFreshRun(agentId))?.code).toBe('quest-open-to-you')
    })
  })

  /**
   * The first account of a kind (`#558`).
   *
   * The half of `#515` aimed at the belief rather than at the record: the
   * inventory exists, and an agent has to think to ask for it.
   */
  describe('the first account of a kind this citizen proved', () => {
    const anAccount = async (
      agentId: AgentId,
      kind: string,
      state: { proved?: boolean; provedAt?: string } = {},
    ): Promise<string> => {
      const proved = state.proved ?? true
      const [row] = await db
        .insert(accounts)
        .values({
          agentId,
          kind,
          identifier: `${kind}-${++seeded}@example.test`,
          proved,
          ...(proved ? { provedAt: state.provedAt ?? sql`now()` } : {}),
          capabilities: proved ? ['control'] : [],
          provenance: 'self-acquired' as const,
        })
        .returning({ id: accounts.id })
      if (row === undefined) throw new Error('inserting an account returned no row')
      return row.id
    }

    it('is said once, naming the kind', async () => {
      const agentId = await aQuietCitizen()
      await anAccount(agentId, 'mailbox')

      const hint = await hintInAFreshRun(agentId)

      expect(hint?.code).toBe('account-kind-proved')
      // The kind slug and never the address: the identifier is the citizen's own
      // text, and no such string travels in this channel.
      expect(hint?.subject).toBe('mailbox')
    })

    /** The rejection case the issue asks for, in the shape it asks for it. */
    it('says nothing on the second account of the same kind', async () => {
      const agentId = await aQuietCitizen()
      await anAccount(agentId, 'mailbox')
      expect((await hintInAFreshRun(agentId))?.code).toBe('account-kind-proved')

      await anAccount(agentId, 'mailbox')

      expect(await hintInAFreshRun(agentId)).toBeNull()
    })

    it('says nothing twice about the same account either', async () => {
      const agentId = await aQuietCitizen()
      await anAccount(agentId, 'mailbox')

      expect((await hintInAFreshRun(agentId))?.code).toBe('account-kind-proved')
      expect(await hintInAFreshRun(agentId)).toBeNull()
    })

    it('is said again for a kind the citizen has not been told about', async () => {
      const agentId = await aQuietCitizen()
      await anAccount(agentId, 'mailbox', { provedAt: '2026-08-01T09:00:00Z' })
      await anAccount(agentId, 'github', { provedAt: '2026-08-02T09:00:00Z' })

      // Earliest first, so the kinds arrive in the order they were earned, one
      // per waking rather than all at once.
      expect((await hintInAFreshRun(agentId))?.subject).toBe('mailbox')
      expect((await hintInAFreshRun(agentId))?.subject).toBe('github')
      expect(await hintInAFreshRun(agentId)).toBeNull()
    })

    it('says nothing about an account the citizen only declared', async () => {
      const agentId = await aQuietCitizen()
      await anAccount(agentId, 'trello', { proved: false })

      expect(await hintInAFreshRun(agentId)).toBeNull()
    })

    /**
     * The kind is what was said, so retiring the account does not un-say it —
     * and it does not silence the kind either, which is the direction that
     * matters: the account a citizen has given up is exactly the one whose
     * capability it may never have learned it had.
     */
    it('is still said about a kind the citizen has since retired', async () => {
      const agentId = await aQuietCitizen()
      const id = await anAccount(agentId, 'mailbox')
      await db
        .update(accounts)
        .set({ status: 'retired' as const })
        .where(eq(accounts.id, id))

      expect((await hintInAFreshRun(agentId))?.code).toBe('account-kind-proved')
    })

    /**
     * Both halves of the placement argument in `STANDING_HINT_RANK`, on one
     * citizen: it leads the doors, and it yields to anything with a clock.
     */
    it('leads the doors and yields to a lapsing skill', async () => {
      const agentId = await aQuietCitizen()
      await db.delete(operatorClaims).where(eq(operatorClaims.agentId, agentId))
      await grantSkill(agentId, 'browser')
      await anAccount(agentId, 'mailbox')

      // Above `operator-unclaimed` and `skill-unused`: the first is the same idea
      // one layer down, and a citizen that does not know it holds a mailbox is
      // not helped by hearing that the skill the mailbox granted has gone unused.
      expect((await hintInAFreshRun(agentId))?.code).toBe('account-kind-proved')
    })

    it('yields to the one condition where waiting costs something earned', async () => {
      const [skill, hours] = Object.entries(SKILL_RENEWAL_HOURS)[0] ?? []
      if (skill === undefined || hours === undefined) return

      const agentId = await aQuietCitizen()
      await anAccount(agentId, 'mailbox')
      await grantSkill(
        agentId,
        skill,
        new Date(Date.parse('2026-08-08T00:00:00Z') - (hours + 1) * 3_600_000).toISOString(),
      )

      // An account is not going anywhere; a current skill is.
      expect((await hintInAFreshRun(agentId))?.code).toBe('skill-due-for-renewal')
    })
  })

  /**
   * The rejection case `#356` names, and the assertion that keeps every
   * placement argument in `STANDING_HINT_RANK` honest: a higher-ranked condition
   * wins, and the ranking is data rather than a chain of `if`s.
   */
  it('answers with the highest-ranked condition when several apply', async () => {
    const agentId = await aQuietCitizen()
    await db.delete(operatorClaims).where(eq(operatorClaims.agentId, agentId))
    await grantSkill(agentId, 'browser')
    await db.insert(supportTickets).values({
      agentId,
      kind: 'question' as const,
      subject: 'Something was unclear',
      body: 'The wording of a rung does not say what it wants.',
      status: 'resolved' as const,
      resolution: 'The wording has been changed.',
    })

    // `ticket-settled` outranks `operator-unclaimed` and `skill-unused`, and the
    // rank is where that argument is written down.
    expect((await hintInAFreshRun(agentId))?.code).toBe('ticket-settled')
  })

  /**
   * What an agent is waiting on, read by somebody else (`#512`).
   *
   * The operator's fleet page asks this, and the two properties it has to have
   * are that it **agrees** with what the agent is told and that asking **costs
   * the agent nothing**.
   */
  describe('reading a citizen’s condition without saying anything to it', () => {
    const slotSpent = async (agentId: AgentId): Promise<boolean> => {
      const [row] = await db
        .select({ hintedAt: agentSessions.hintedAt })
        .from(agentSessions)
        .where(eq(agentSessions.agentId, agentId))
        .limit(1)
      return row?.hintedAt != null
    }

    it('answers what the agent itself would be told', async () => {
      const agentId = await aQuietCitizen()
      await grantSkill(agentId, 'browser')

      const facing = await standingHintDueFor(db, agentId)

      expect(facing?.code).toBe('skill-unused')
      // The same answer the agent gets, from the same computation.
      expect(await hintInAFreshRun(agentId)).toEqual(facing)
    })

    /**
     * The property the page depends on: an operator refreshing its dashboard
     * twenty times must not use up the line its agent was going to be given.
     */
    it('spends no slot, so the agent is still told', async () => {
      const agentId = await aQuietCitizen()
      await grantSkill(agentId, 'browser')
      await aSession(agentId)

      expect((await standingHintDueFor(db, agentId))?.code).toBe('skill-unused')
      expect((await standingHintDueFor(db, agentId))?.code).toBe('skill-unused')
      expect(await slotSpent(agentId)).toBe(false)

      expect((await dueStandingHint(db, agentId))?.code).toBe('skill-unused')
    })

    /**
     * It ignores the slot, which is the one honest difference in the answer: an
     * operator asking *what is my agent stuck on* wants the condition, not the
     * schedule.
     */
    it('still answers after the agent has had its one line for the run', async () => {
      const agentId = await aQuietCitizen()
      await grantSkill(agentId, 'browser')
      await aSession(agentId)
      expect((await dueStandingHint(db, agentId))?.code).toBe('skill-unused')
      expect(await dueStandingHint(db, agentId)).toBeNull()

      expect((await standingHintDueFor(db, agentId))?.code).toBe('skill-unused')
    })

    it('marks no badge told, so the agent still hears about it', async () => {
      const agentId = await aQuietCitizen()
      await db.insert(agentBadges).values({ agentId, badge: 'first-light' as never })

      expect((await standingHintDueFor(db, agentId))?.code).toBe('badge-awarded')

      expect((await hintInAFreshRun(agentId))?.code).toBe('badge-awarded')
    })

    it('answers with nothing for a citizen with nothing against it', async () => {
      const agentId = await aQuietCitizen()

      expect(await standingHintDueFor(db, agentId)).toBeNull()
    })

    it('answers with nothing for an agent that does not exist', async () => {
      expect(await standingHintDueFor(db, AgentIdSchema.parse(crypto.randomUUID()))).toBeNull()
    })
  })
})
