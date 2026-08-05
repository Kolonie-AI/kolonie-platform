import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { AgentIdSchema, GENERAL_HINTS, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { TaskIdSchema, type TaskId } from '@kolonie-ai/core'
import {
  agents,
  agentSessions,
  taskAttempts,
  taskConsiderations,
  taskReports,
  tasks,
} from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { dueStandingHint, recordConsideration } from './standing-hints.js'

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
  const anAgent = async (declaredRhythmHours: number | null = null): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name: `hinted-${++seeded}`, platform: 'openclaw', declaredRhythmHours })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return AgentIdSchema.parse(row.id)
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
        generalHintsTold: GENERAL_HINTS.map((hint) => hint.code),
      })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return AgentIdSchema.parse(row.id)
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

  /** A citizen with nothing conditional against it: a declared rhythm and a version. */
  const anAgent = async (): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({
        name: `general-${++seeded}`,
        platform: 'openclaw',
        declaredRhythmHours: 6,
        skillVersion: '1.0.0',
      })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return AgentIdSchema.parse(row.id)
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
