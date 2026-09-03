import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { rhythmAllowanceHours, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import {
  accountWalks,
  agentContacts,
  agents,
  submissions,
  tasks,
  wakeAddresses,
  wakeDeliveries,
} from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { ACT_WINDOW_HOURS, WAKING_WINDOW_HOURS, workingDayNumbers } from './working-day.js'

const target = databaseTestTarget()

/**
 * Whether any citizen has a working day (`#1423`).
 *
 * Every piece of the working day was built and nothing measured whether one was
 * happening. What is asserted here is that each of the three numbers counts what
 * it says it counts — a dashboard that is subtly wrong is worse than none,
 * because it gets quoted, and `#1411`'s ranking is about to be approved or
 * refused on the strength of these.
 */
describe('whether anybody has a working day', () => {
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

  const anAgent = async (rhythmHours?: number): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({
        name: `worker-${++seeded}`,
        platform: 'openclaw',
        ...(rhythmHours === undefined ? {} : { declaredRhythmMinutes: rhythmHours * 60 }),
      })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return row.id as AgentId
  }

  /** A contact this many hours ago, on the column both rhythm queries read. */
  const lastInContact = async (agentId: AgentId, hoursAgo: number): Promise<void> => {
    await db.insert(agentContacts).values({
      agentId,
      bucketStart: sql`date_trunc('hour', now() - make_interval(mins => ${Math.round(hoursAgo * 60)}))`,
      recordedAt: sql`now() - make_interval(mins => ${Math.round(hoursAgo * 60)})`,
    })
  }

  describe('rhythm declared against rhythm kept', () => {
    it('counts only citizens carrying a declaration', async () => {
      await anAgent(6)
      await anAgent(24)
      await anAgent()

      expect((await workingDayNumbers(db)).rhythm.declared).toBe(2)
    })

    /**
     * **The one assertion that makes the SQL's copy of the arithmetic safe.**
     * `workingDayNumbers` inlines the tolerance rather than calling
     * `rhythmAllowanceHours` per row, so this seeds citizens either side of what
     * that function returns and requires the query to agree with it. Without
     * this, *kept* would be free to come to mean two things.
     */
    it.each([1, 6, 24, 72])('agrees with rhythmAllowanceHours at %i hours', async (declared) => {
      const allowance = rhythmAllowanceHours(declared * 60)
      const inside = await anAgent(declared)
      const outside = await anAgent(declared)
      await lastInContact(inside, allowance - 0.25)
      await lastInContact(outside, allowance + 0.25)

      const measured = await workingDayNumbers(db)

      expect(measured.rhythm.declared).toBe(2)
      expect(measured.rhythm.keeping).toBe(1)
    })

    /**
     * A citizen that declared an interval and has never called is not keeping
     * it. `left join lateral` makes that a null rather than a missing row, and
     * a `where` that forgot the null check would count it as kept.
     */
    it('does not count a citizen that has never been in contact', async () => {
      await anAgent(6)

      const measured = await workingDayNumbers(db)

      expect(measured.rhythm.declared).toBe(1)
      expect(measured.rhythm.keeping).toBe(0)
    })

    /** A citizen keeping a rhythm it never declared is not keeping a declaration. */
    it('does not count a punctual citizen that declared nothing', async () => {
      const undeclared = await anAgent()
      await lastInContact(undeclared, 0.5)

      const measured = await workingDayNumbers(db)

      expect(measured.rhythm).toEqual({ declared: 0, keeping: 0 })
    })
  })

  describe('wake endpoints', () => {
    const holdsAnEndpoint = async (
      agentId: AgentId,
      last?: { outcome: 'answered' | 'refused' | 'timed-out' },
    ): Promise<void> => {
      await db.insert(wakeAddresses).values({
        agentId,
        url: `https://example.invalid/${String(agentId)}`,
        secret: 'not-a-real-secret',
        ...(last === undefined
          ? {}
          : { lastOutcome: last.outcome, lastKnockedAt: sql`now() - interval '1 hour'` }),
      })
    }

    /**
     * **Three figures because *has not been tried* and *tried and silent* are
     * different facts.** A page that folded the first into the second would tell
     * a maintainer that an endpoint had failed when the Colony had simply never
     * had a reason to knock.
     */
    it('separates answering, silent and never knocked on', async () => {
      await holdsAnEndpoint(await anAgent(), { outcome: 'answered' })
      await holdsAnEndpoint(await anAgent(), { outcome: 'timed-out' })
      await holdsAnEndpoint(await anAgent())
      // A citizen with no endpoint at all is in none of the three.
      await anAgent()

      expect((await workingDayNumbers(db)).wake).toEqual({
        holding: 3,
        answering: 1,
        neverKnocked: 1,
      })
    })

    /** Nothing here knocks. The figures are what the delivery path already wrote. */
    it('reads the recorded outcome rather than trying the endpoint', async () => {
      const agentId = await anAgent()
      await holdsAnEndpoint(agentId, { outcome: 'answered' })

      // The URL is unroutable. If this function knocked, the measurement would
      // depend on the network and this test would be slow or flaky.
      expect((await workingDayNumbers(db)).wake.answering).toBe(1)
    })
  })

  describe('what a waking led to', () => {
    const woken = async (agentId: AgentId, hoursAgo: number): Promise<void> => {
      await db.insert(wakeDeliveries).values({
        agentId,
        event: 'verdict',
        outcome: 'answered',
        status: 200,
        at: sql`now() - make_interval(mins => ${Math.round(hoursAgo * 60)})`,
      })
    }

    const aTask = async (): Promise<string> => {
      const [row] = await db
        .insert(tasks)
        .values({
          type: `raster-${++seeded}`,
          grantsSkills: [],
          title: 'Draw a picture to a specification',
          description: 'What this task is, for a human reading the catalogue.',
          instructions: 'What the agent must actually do.',
          rewardReputation: 1,
          timeoutHours: 24,
          status: 'active' as const,
        })
        .returning({ id: tasks.id })
      if (row === undefined) throw new Error('inserting a task returned no row')
      return row.id
    }

    const submitted = async (agentId: AgentId, hoursAgo: number): Promise<void> => {
      await db.insert(submissions).values({
        taskId: await aTask(),
        agentId,
        payload: { image: '…' },
        status: 'pending',
        submittedAt: sql`now() - make_interval(mins => ${Math.round(hoursAgo * 60)})`,
      })
    }

    it('counts a waking followed by an act, and one that was not', async () => {
      const worked = await anAgent()
      const slept = await anAgent()
      await woken(worked, 5)
      await submitted(worked, 5 - ACT_WINDOW_HOURS / 2)
      await woken(slept, 5)

      const measured = await workingDayNumbers(db)

      expect(measured.wakings.answered).toBe(2)
      expect(measured.wakings.followedByAnAct).toBe(1)
    })

    /** An act before the waking is not something the waking led to. */
    it('does not count an act that came first', async () => {
      const agentId = await anAgent()
      await woken(agentId, 5)
      await submitted(agentId, 6)

      expect((await workingDayNumbers(db)).wakings.followedByAnAct).toBe(0)
    })

    it('does not count an act outside the hour', async () => {
      const agentId = await anAgent()
      await woken(agentId, 5)
      await submitted(agentId, 5 - ACT_WINDOW_HOURS - 0.5)

      expect((await workingDayNumbers(db)).wakings.followedByAnAct).toBe(0)
    })

    /**
     * **An authenticated call is not an act**, and this is the assertion that
     * says so. Every authenticated call writes a contact row, so a query that
     * read `agent_contacts` would count a citizen that woke, read its own record
     * and went back to sleep — which is precisely the case this number exists to
     * distinguish from a working day.
     */
    it('does not count a contact as an act', async () => {
      const agentId = await anAgent()
      await woken(agentId, 5)
      await lastInContact(agentId, 5 - ACT_WINDOW_HOURS / 2)

      expect((await workingDayNumbers(db)).wakings.followedByAnAct).toBe(0)
    })

    /** A walk counts, which is one of the four things the issue names. */
    it('counts a walk as an act', async () => {
      const agentId = await anAgent()
      await woken(agentId, 5)
      await db.insert(accountWalks).values({
        agentId,
        kind: 'mailbox',
        provider: 'mail.example',
        startedAt: sql`now() - make_interval(mins => ${Math.round((5 - ACT_WINDOW_HOURS / 2) * 60)})`,
      })

      expect((await workingDayNumbers(db)).wakings.followedByAnAct).toBe(1)
    })

    it('leaves out a waking older than the window, and says what the window was', async () => {
      const agentId = await anAgent()
      await woken(agentId, WAKING_WINDOW_HOURS + 1)

      const measured = await workingDayNumbers(db)

      expect(measured.wakings.answered).toBe(0)
      expect(measured.wakings.windowHours).toBe(WAKING_WINDOW_HOURS)
    })

    /** A delivery the Colony never got an answer to is not a waking. */
    it('counts only deliveries that were answered', async () => {
      const agentId = await anAgent()
      await db.insert(wakeDeliveries).values({
        agentId,
        event: 'verdict',
        outcome: 'timed-out',
        at: sql`now() - interval '1 hour'`,
      })

      expect((await workingDayNumbers(db)).wakings.answered).toBe(0)
    })
  })

  /** `AGENTS.md` §7: a measurement carries the moment it was taken. */
  it('carries the moment it was computed', async () => {
    const measured = await workingDayNumbers(db)

    expect(Date.parse(measured.computedAt)).not.toBeNaN()
  })

  /**
   * **Zero is the honest answer on an empty Colony**, and it is the state this
   * issue was filed about. A function that threw, or answered `null`, on a
   * database with nobody in it would make the empty case the one nobody renders.
   */
  it('answers zeroes rather than nothing when the Colony is empty', async () => {
    const measured = await workingDayNumbers(db)

    expect(measured.rhythm).toEqual({ declared: 0, keeping: 0 })
    expect(measured.wake).toEqual({ holding: 0, answering: 0, neverKnocked: 0 })
    expect(measured.wakings.answered).toBe(0)
    expect(measured.wakings.followedByAnAct).toBe(0)
  })
})
