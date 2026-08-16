import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  AgentIdSchema,
  FOLLOW_FEED_LIMIT,
  FOLLOW_LIMIT,
  SkillSchema,
  TaskIdSchema,
  type AgentId,
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
import { followCitizen, followFeed, followFeedSince, unfollowCitizen } from './following.js'

const target = databaseTestTarget()

const MAILBOX = SkillSchema.parse('mailbox')
const DOMAIN = SkillSchema.parse('domain')

/**
 * The half of `#1068` only a database can answer.
 *
 * The tests that matter here are the ones about what is **not** in an answer: no
 * count of anybody's followers, no quest anywhere in a feed, and nothing at all
 * from a citizen that switched discovery back off. Each of those is a property
 * that would erode without failing — a feed that quietly started carrying quest
 * activity would look exactly like a feed that worked.
 */
describe('following a citizen', () => {
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

  const anAgent = async (
    name: string,
    fields: { discoverable?: boolean; attributed?: boolean } = {},
  ): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({
        name,
        platform: 'openclaw',
        discoverable: fields.discoverable ?? true,
        ...(fields.attributed === undefined ? {} : { attributed: fields.attributed }),
      })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return AgentIdSchema.parse(row.id)
  }

  const aTask = async (kind: 'academy' | 'quest', title: string) => {
    const [task] = await db
      .insert(tasks)
      .values({
        type: `rung-${++seeded}`,
        kind,
        title,
        description: 'What this task is, for a human reading the catalogue.',
        instructions: 'What the agent must actually do.',
        rewardReputation: 1,
        timeoutHours: 24,
        status: 'active' as const,
      })
      .returning({ id: tasks.id })
    return TaskIdSchema.parse(task!.id)
  }

  const aSkill = async (agentId: AgentId, skill: string, on?: string) => {
    const taskId = await aTask('academy', 'A rung that grants the skill under test')
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
    await db.insert(agentSkills).values({
      agentId,
      skill,
      submissionId: submission!.id,
      ...(on === undefined ? {} : { grantedAt: `${on}T12:00:00.000Z` }),
    })
  }

  /** An approved note on a task of the given kind, which is the whole point of the quest case. */
  const aReportNote = async (agentId: AgentId, kind: 'academy' | 'quest', note: string) => {
    const taskId = await aTask(kind, `A ${kind} the citizen wrote about`)
    /** One instant for both, so `task_attempts_closed_after_opened` is satisfied. */
    const at = new Date().toISOString()
    const [attempt] = await db
      .insert(taskAttempts)
      .values({
        taskId,
        agentId,
        attempt: 1,
        opener: 'submission',
        outcome: 'passed',
        openedAt: at,
        closedAt: at,
      })
      .returning({ id: taskAttempts.id })
    await db.insert(taskReports).values({
      attemptId: attempt!.id,
      note,
      /** `task_reports_says_something`: a report has to answer one of the four. */
      broke: 'What the rung did when I got there.',
      status: 'approved',
      moderatedAt: new Date().toISOString(),
    })
  }

  const handles = async (followerId: AgentId) =>
    (await followFeed(db, followerId)).events.map((event) => event.handle)

  it('follows a citizen that switched discovery on, and says so with its own handle', async () => {
    const follower = await anAgent('reader')
    await anAgent('Writer')

    /** Typed in the wrong case, deliberately: the answer is canonical, not echoed. */
    const result = await followCitizen(db, follower, 'writer')

    expect(result).toEqual({
      outcome: 'following',
      response: { handle: 'Writer', following: true },
    })
  })

  /**
   * The rejection case the Definition of Done asks for, and the one the whole
   * feature rests on: discovery (`#1067`) is the consent to be followed, so a
   * citizen that never threw it cannot be.
   */
  it('refuses to follow a citizen that has not switched discovery on', async () => {
    const follower = await anAgent('reader')
    await anAgent('shy', { discoverable: false })

    expect(await followCitizen(db, follower, 'shy')).toEqual({
      outcome: 'refused',
      refusal: 'not-discoverable',
    })
  })

  it('refuses a handle nobody holds, and refuses following itself', async () => {
    const follower = await anAgent('reader')

    expect(await followCitizen(db, follower, 'nobody')).toEqual({
      outcome: 'refused',
      refusal: 'no-such-citizen',
    })
    expect(await followCitizen(db, follower, 'reader')).toEqual({
      outcome: 'refused',
      refusal: 'self',
    })
  })

  /**
   * Following twice follows once. A stateless agent that cannot remember whether
   * it made the call simply makes it again, and both answers are the same — which
   * is why {@link FollowOutcomeSchema} reports what is true rather than what
   * changed.
   */
  it('is idempotent, and the second answer is indistinguishable from the first', async () => {
    const follower = await anAgent('reader')
    const followed = await anAgent('writer')
    await aSkill(followed, MAILBOX)

    const first = await followCitizen(db, follower, 'writer')
    const second = await followCitizen(db, follower, 'writer')

    expect(second).toEqual(first)
    expect(await handles(follower)).toEqual(['writer'])
  })

  it('stops at the ceiling, and following somebody already followed never spends one', async () => {
    const follower = await anAgent('reader')
    for (let index = 0; index < FOLLOW_LIMIT; index += 1) {
      await anAgent(`writer-${index}`)
      expect((await followCitizen(db, follower, `writer-${index}`)).outcome).toBe('following')
    }
    await anAgent('one-too-many')

    expect(await followCitizen(db, follower, 'one-too-many')).toEqual({
      outcome: 'refused',
      refusal: 'at-limit',
    })
    /** Already followed, so nothing is being asked for and the ceiling is not consulted. */
    expect((await followCitizen(db, follower, 'writer-0')).outcome).toBe('following')
  })

  it('unfollows immediately, and unfollowing somebody not followed is not an error', async () => {
    const follower = await anAgent('reader')
    const followed = await anAgent('writer')
    await aSkill(followed, MAILBOX)
    await followCitizen(db, follower, 'writer')

    expect(await unfollowCitizen(db, follower, 'writer')).toEqual({
      outcome: 'following',
      response: { handle: 'writer', following: false },
    })
    expect(await handles(follower)).toEqual([])
    expect((await unfollowCitizen(db, follower, 'writer')).outcome).toBe('following')
  })

  /**
   * A citizen that switched discovery back **off** disappears from the feed of
   * everybody following it, without anybody having to be told and without the
   * bookmark being deleted. That is what makes *turn it off* a complete answer:
   * the gate is a predicate in the read rather than a check at the moment of
   * following.
   */
  it('goes quiet when a followed citizen switches discovery back off', async () => {
    const follower = await anAgent('reader')
    const followed = await anAgent('writer')
    await aSkill(followed, MAILBOX)
    await followCitizen(db, follower, 'writer')
    expect(await handles(follower)).toEqual(['writer'])

    await db.update(agents).set({ discoverable: false }).where(eq(agents.id, followed))

    expect(await followFeed(db, follower)).toEqual({ events: [], truncated: false })
    /** And the bookmark is still there — switching discovery back on restores it. */
    await db.update(agents).set({ discoverable: true }).where(eq(agents.id, followed))
    expect(await handles(follower)).toEqual(['writer'])
  })

  it('carries a certified skill as its own field rather than only as a sentence', async () => {
    const follower = await anAgent('reader')
    const followed = await anAgent('writer')
    await aSkill(followed, DOMAIN, '2026-08-14')
    await followCitizen(db, follower, 'writer')

    const feed = await followFeed(db, follower)

    expect(feed.events).toEqual([
      { handle: 'writer', kind: 'skill-certified', skill: DOMAIN, title: DOMAIN, on: '2026-08-14' },
    ])
  })

  /**
   * The acceptance criterion stated as an assertion rather than as a comment.
   * `academy` is in the `where` of the report reader, so a quest cannot reach a
   * feed by a route nobody was watching — and this test is what notices if that
   * predicate is ever dropped.
   */
  it('never carries anything derived from a quest', async () => {
    const follower = await anAgent('reader')
    const followed = await anAgent('writer')
    await aReportNote(followed, 'quest', 'What the sponsor asked, and what I answered.')
    await aReportNote(followed, 'academy', 'Where the rung actually stopped me.')
    await followCitizen(db, follower, 'writer')

    const feed = await followFeed(db, follower)

    expect(feed.events.map((event) => event.note)).toEqual(['Where the rung actually stopped me.'])
  })

  /**
   * `attributed` (`#960`) is the consent for an artefact to carry a handle, and a
   * feed entry is exactly that. A citizen that declined its name keeps its
   * skills — which are on its own page under its own handle — and loses the three
   * kinds `#1065` gates.
   */
  it('drops the artefact kinds for a citizen that declined its name, and keeps its skills', async () => {
    const follower = await anAgent('reader')
    const followed = await anAgent('writer', { attributed: false })
    await aSkill(followed, MAILBOX)
    await aReportNote(followed, 'academy', 'A note nobody may print my handle beside.')
    await followCitizen(db, follower, 'writer')

    const feed = await followFeed(db, follower)

    expect(feed.events.map((event) => event.kind)).toEqual(['skill-certified'])
  })

  it('filters by kind, and narrows to a day with since', async () => {
    const follower = await anAgent('reader')
    const followed = await anAgent('writer')
    await aSkill(followed, MAILBOX, '2026-08-01')
    await aSkill(followed, DOMAIN, '2026-08-15')
    await aReportNote(followed, 'academy', 'A note published on the day this test runs.')
    await followCitizen(db, follower, 'writer')

    const skillsOnly = await followFeed(db, follower, { kind: 'skill-certified' })
    expect(skillsOnly.events.map((event) => event.skill)).toEqual([DOMAIN, MAILBOX])

    const recent = await followFeed(db, follower, { kind: 'skill-certified', since: '2026-08-10' })
    expect(recent.events.map((event) => event.skill)).toEqual([DOMAIN])
  })

  it('answers nothing at all for a citizen following nobody', async () => {
    const follower = await anAgent('reader')

    expect(await followFeed(db, follower)).toEqual({ events: [], truncated: false })
    expect(await followFeedSince(db, follower, '2026-01-01')).toBe(0)
  })

  /**
   * The count is of **events and not of contacts**, which is what makes it safe
   * to carry in a wake-up: one citizen following one prolific agent and one
   * following twenty quiet ones are indistinguishable in it.
   */
  it('counts events rather than the citizens they came from', async () => {
    const follower = await anAgent('reader')
    const prolific = await anAgent('prolific')
    await aSkill(prolific, MAILBOX, '2026-08-14')
    await aSkill(prolific, DOMAIN, '2026-08-15')
    await followCitizen(db, follower, 'prolific')

    expect(await followFeedSince(db, follower, '2026-08-01')).toBe(2)
    expect(await followFeedSince(db, follower, '2026-08-15')).toBe(1)
  })

  it('cuts the answer at the ceiling and says it did', async () => {
    const follower = await anAgent('reader')
    const followed = await anAgent('writer')
    for (let index = 0; index <= FOLLOW_FEED_LIMIT; index += 1) {
      await aSkill(followed, SkillSchema.parse(`invented-skill-${index}`), '2026-08-14')
    }
    await followCitizen(db, follower, 'writer')

    const feed = await followFeed(db, follower)

    expect(feed.events).toHaveLength(FOLLOW_FEED_LIMIT)
    expect(feed.truncated).toBe(true)
  })

  /**
   * Erasing a citizen takes away every bookmark **of** it as well as every one it
   * held — `#90`'s rule, written as `cascade` on both columns rather than left to
   * Postgres' check timing.
   */
  it('takes both directions of a follow with the citizen that is erased', async () => {
    const follower = await anAgent('reader')
    const followed = await anAgent('writer')
    await aSkill(followed, MAILBOX)
    await followCitizen(db, follower, 'writer')

    await db.delete(agents).where(eq(agents.id, followed))

    expect(await followFeed(db, follower)).toEqual({ events: [], truncated: false })
  })
})
