import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { AgentIdSchema, BADGE_CATALOGUE, TaskIdSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import {
  agentBadges,
  agentSkills,
  agents,
  submissions,
  supportTickets,
  tasks,
} from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { badgesOf, markBadgeTold, sweepBadges, untoldBadge } from './badges.js'

const target = databaseTestTarget()

/**
 * `#241`: a layer that counts for nothing, which is what lets it be playful.
 *
 * Almost everything asserted here is a **negative**: that a badge changes
 * nothing, gates nothing, and cannot be taken away. Those are the properties
 * that erode quietly — a badge read by one eligibility check is still a badge,
 * and the day it becomes farmable is invisible from the outside.
 */
describe('the badges a citizen is given', () => {
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

  const anAgent = async (createdAt?: string): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({
        name: `decorated-${++seeded}`,
        platform: 'openclaw',
        ...(createdAt === undefined ? {} : { createdAt }),
      })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return AgentIdSchema.parse(row.id)
  }

  const aTask = async () => {
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
    return TaskIdSchema.parse(row!.id)
  }

  /** A rung passed, which is what `first-light` is about. */
  const aSkill = async (agentId: AgentId, skill: string) => {
    const taskId = await aTask()
    const [submission] = await db
      .insert(submissions)
      .values({
        taskId,
        agentId,
        payload: {},
        status: 'passed',
        verifiedAt: new Date().toISOString(),
      })
      .returning({ id: submissions.id })
    await db.insert(agentSkills).values({ agentId, skill, submissionId: submission!.id })
  }

  const held = async (agentId: AgentId) => (await badgesOf(db, agentId)).map((one) => one.slug)

  it('gives a citizen its first rung’s badge', async () => {
    const agentId = await anAgent()
    await aSkill(agentId, 'mailbox')

    await sweepBadges(db)

    expect(await held(agentId)).toContain('first-light')
  })

  /**
   * The criterion is *a ticket somebody acted on*, not *a ticket*. A citizen can
   * file all day; only a maintainer writes the issue URL, and the
   * `support_tickets_issue_means_looked_at` constraint makes a URL on an
   * untouched ticket impossible.
   */
  it('gives nothing for a ticket nobody acted on, and the badge once one did', async () => {
    const agentId = await anAgent()
    const [ticket] = await db
      .insert(supportTickets)
      .values({
        agentId,
        kind: 'question',
        subject: 'Something is wrong',
        body:
          'Something is wrong and this is the long version of saying so, because a ticket has a ' +
          'minimum length and a one-line complaint is not a report anybody can act on.',
        status: 'open',
      })
      .returning({ id: supportTickets.id })

    await sweepBadges(db)
    expect(await held(agentId)).not.toContain('ticket-that-landed')

    await db
      .update(supportTickets)
      .set({
        status: 'acknowledged',
        issueUrl: 'https://github.com/Kolonie-AI/kolonie-docs/issues/1',
      })
      .where(eq(supportTickets.id, ticket!.id))

    await sweepBadges(db)
    expect(await held(agentId)).toContain('ticket-that-landed')
  })

  it('gives the long-service badges only when the time has actually passed', async () => {
    const young = await anAgent()
    const old = await anAgent(new Date(Date.now() - 200 * 24 * 3600 * 1000).toISOString())

    await sweepBadges(db)

    expect(await held(young)).not.toContain('thirty')
    expect(await held(old)).toEqual(expect.arrayContaining(['thirty', 'hundred']))
    // Two hundred days is not a year, and the sweep must not round up.
    expect(await held(old)).not.toContain('year')
  })

  /** Held once. The sweep re-running changes nothing at all. */
  it('is idempotent, however many times it runs', async () => {
    const agentId = await anAgent()
    await aSkill(agentId, 'mailbox')

    await sweepBadges(db)
    const first = await held(agentId)
    await sweepBadges(db)
    await sweepBadges(db)

    expect(await held(agentId)).toEqual(first)
  })

  /**
   * **A badge never lapses**, on `kolonie-docs#131`'s vocabulary: what was true
   * stays true. `rare-air` is the sharpest case, because its criterion is a fact
   * about the population and a second citizen can falsify it at any time.
   */
  it('keeps a badge after its criterion has become impossible', async () => {
    const alone = await anAgent()
    await aSkill(alone, 'rare-rung')
    await sweepBadges(db)
    expect(await held(alone)).toContain('rare-air')

    const neighbour = await anAgent()
    await aSkill(neighbour, 'rare-rung')
    await sweepBadges(db)

    expect(await held(alone)).toContain('rare-air')
    expect(await held(neighbour)).not.toContain('rare-air')
  })

  /** Told once, through `#231`'s channel and no other. */
  it('has one untold badge at a time, and none once it has been told', async () => {
    const agentId = await anAgent()
    await aSkill(agentId, 'mailbox')
    await sweepBadges(db)

    const untold = await untoldBadge(db, agentId)
    expect(untold?.slug).toBe('first-light')

    expect(await markBadgeTold(db, untold!.id)).toBe(true)
    // The same row cannot be announced twice, which is what stops two calls
    // racing inside one run from both saying it.
    expect(await markBadgeTold(db, untold!.id)).toBe(false)

    // One at a time, oldest first: this citizen also qualified for `rare-air`,
    // and it waits for the next waking rather than arriving beside the first.
    const next = await untoldBadge(db, agentId)
    expect(next?.slug).not.toBe('first-light')
    await markBadgeTold(db, next!.id)
    expect(await untoldBadge(db, agentId)).toBeNull()
  })

  /**
   * **The catalogue is not published; what a citizen holds is.** A read that
   * answered *what exists* would turn the layer into a checklist and spend the
   * surprise once.
   */
  it('answers what a citizen holds and never what exists', async () => {
    const agentId = await anAgent()

    expect(await badgesOf(db, agentId)).toEqual([])
    expect(Object.keys(BADGE_CATALOGUE).length).toBeGreaterThan(0)
  })

  /**
   * The property most likely to erode, asserted structurally rather than by
   * example: **no storage module that decides anything reads a badge.**
   *
   * A test per gating path would only cover the paths somebody thought of. This
   * covers the ones nobody has written yet, and it fails with the offending
   * file's name in it.
   */
  it('is read by no storage module that decides anything', async () => {
    const storage = fileURLToPath(new URL('.', import.meta.url))
    const files = await readdir(storage)

    /**
     * The three that may. `badges.ts` owns the table; `standing-hints.ts` tells
     * the citizen it was given one, which decides nothing about what the citizen
     * may do; the tests are the tests.
     */
    const ALLOWED = new Set([
      'badges.ts',
      'badges.test.ts',
      'standing-hints.ts',
      'operator-pages.ts',
      /**
       * `#243`, and it is a test rather than a fourth reader. `attribution.ts`
       * itself is clean — it records a reading of a page and knows nothing about
       * badges, which is what keeps this rule true. Its test sweeps and reads
       * the badges to assert that the reading is what produces one, which is the
       * property worth pinning and cannot be pinned without touching both.
       */
      'attribution.test.ts',
      /**
       * `#512`, and a test rather than a sixth reader, on `attribution.test.ts`'
       * reasoning. `standing-hints.ts` is already allowed above; its test writes
       * a badge in order to assert that the **read-only** hint accessor an
       * operator's fleet page uses does *not* mark it told. Pinning that needs a
       * badge to exist, and the property being pinned is a non-read.
       */
      'standing-hints.test.ts',
    ])

    const offenders: string[] = []
    for (const file of files) {
      if (!file.endsWith('.ts') || ALLOWED.has(file)) continue

      const source = await readFile(`${storage}${file}`, 'utf8')
      if (/agentBadges|agent_badges|badgesOf|BADGE_CATALOGUE/.test(source)) offenders.push(file)
    }

    // A file arriving here is not necessarily wrong — but it has to be argued
    // for and added above, and the argument has to say why a badge is being read
    // by something that decides.
    expect(offenders).toEqual([])
  })

  /**
   * The same rule from the other side: the queries that decide what a citizen
   * may take never join this table. Read as SQL rather than as source, so a
   * clever import path cannot get round it.
   */
  it('is joined by no query that answers what a citizen may do', async () => {
    const agentId = await anAgent()
    await aSkill(agentId, 'mailbox')
    await sweepBadges(db)

    const views = await db.execute<{ count: string }>(sql`
      select count(*)::text as count from pg_views
       where schemaname = 'public' and definition ilike '%agent_badges%'`)

    expect(Number(views[0]?.count ?? '0')).toBe(0)
    // And the rows are there, so the assertion above is about the absence of a
    // view rather than about an empty table.
    expect(
      (await db.select().from(agentBadges).where(eq(agentBadges.agentId, agentId))).length,
    ).toBeGreaterThan(0)
  })
})
