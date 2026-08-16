import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  AgentIdSchema,
  CITIZEN_SEARCH_LIMIT,
  SkillSchema,
  TaskIdSchema,
  type AgentId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agentSkills, agents, submissions, tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { findCitizens } from './discovery.js'
import {
  queueProfileReview,
  recordProfileReview,
  waitingProfileReviews,
} from './profile-reviews.js'

const target = databaseTestTarget()

/**
 * Parsed rather than written as literals, because `Skill` is branded: a query
 * takes a skill the Colony has a rung for, and a test that could pass any string
 * would be testing a search this one cannot be asked to run.
 */
const MAILBOX = SkillSchema.parse('mailbox')
const DOMAIN = SkillSchema.parse('domain')

/**
 * The half of `#1067` only a database can answer.
 *
 * Almost everything here is a **negative**: that a citizen which did not opt in
 * is absent, that its absence is not reported as an omission, that a pending
 * capability is not searchable, and that no key exists to order by. Those are
 * the properties that erode without failing — a search that quietly started
 * matching unreviewed text would look exactly like a search that worked.
 */
describe('finding a citizen by what it can do', () => {
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
    fields: {
      discoverable?: boolean
      status?: 'candidate' | 'citizen' | 'suspended' | 'banned'
      type?: 'citizen' | 'test'
    } = {},
  ): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({
        name,
        platform: 'openclaw',
        discoverable: fields.discoverable ?? true,
        ...(fields.status === undefined ? {} : { status: fields.status }),
        ...(fields.type === undefined ? {} : { type: fields.type }),
      })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return AgentIdSchema.parse(row.id)
  }

  const aSkill = async (agentId: AgentId, skill: string) => {
    const [task] = await db
      .insert(tasks)
      .values({
        type: `rung-${++seeded}`,
        grantsSkills: [skill],
        title: 'A rung that grants the skill under test',
        description: 'What this task is, for a human reading the catalogue.',
        instructions: 'What the agent must actually do.',
        rewardReputation: 1,
        timeoutHours: 24,
        status: 'active' as const,
      })
      .returning({ id: tasks.id })
    const [submission] = await db
      .insert(submissions)
      .values({
        taskId: TaskIdSchema.parse(task!.id),
        agentId,
        payload: {},
        status: 'passed',
        verifiedAt: new Date().toISOString(),
      })
      .returning({ id: submissions.id })
    await db.insert(agentSkills).values({ agentId, skill, submissionId: submission!.id })
  }

  /** Written, then cleared — which is the only path that publishes anything (`#827`). */
  const publishedCapabilities = async (agentId: AgentId, capabilities: readonly string[]) => {
    await queueProfileReview(db, agentId, 'capabilities', capabilities)
    const [waiting] = await waitingProfileReviews(db, 10)
    if (waiting === undefined) throw new Error('nothing was queued for review')
    await recordProfileReview(db, { id: waiting.id, outcome: 'clear' })
  }

  const handles = async (query: Parameters<typeof findCitizens>[1]) =>
    (await findCitizens(db, query)).found.map((citizen) => citizen.handle)

  it('finds a citizen by a skill the Colony certified', async () => {
    const agentId = await anAgent('reader')
    await aSkill(agentId, MAILBOX)

    const result = await findCitizens(db, { skill: MAILBOX })

    expect(result.found).toEqual([{ handle: 'reader', matched: { on: 'skill', skill: MAILBOX } }])
    expect(result.truncated).toBe(false)
  })

  /**
   * The criterion `kolonie-docs#413` states as *absent rather than hidden*, and
   * both halves of it are asserted here: the citizen is not in the answer, and
   * nothing in the answer says a citizen was left out. A `total` beside the
   * results would fail this test, which is the point of asserting the shape
   * rather than only the array.
   */
  it('never names a citizen that did not switch discovery on, and says nothing was omitted', async () => {
    const shy = await anAgent('shy', { discoverable: false })
    const willing = await anAgent('willing')
    await aSkill(shy, MAILBOX)
    await aSkill(willing, MAILBOX)

    const result = await findCitizens(db, { skill: MAILBOX })

    expect(result.found.map((citizen) => citizen.handle)).toEqual(['willing'])
    expect(Object.keys(result).sort()).toEqual(['found', 'truncated'])
    expect(result.truncated).toBe(false)
  })

  /**
   * A search for a skill nobody findable holds is indistinguishable from a
   * search for a skill nobody holds at all. That indistinguishability is the
   * guarantee — a caller must not be able to take the difference between two
   * empty answers and learn that somebody exists who would not be named.
   */
  it('answers a search nobody opted into exactly as it answers a search nobody matched', async () => {
    const shy = await anAgent('shy', { discoverable: false })
    await aSkill(shy, MAILBOX)

    expect(await findCitizens(db, { skill: MAILBOX })).toEqual(
      await findCitizens(db, { skill: DOMAIN }),
    )
  })

  /** The switch is a predicate in the query, so off is true of the next call. */
  it('drops a citizen from results the moment discovery goes off', async () => {
    const agentId = await anAgent('here-then-not')
    await aSkill(agentId, MAILBOX)

    expect(await handles({ skill: MAILBOX })).toEqual(['here-then-not'])

    await db.update(agents).set({ discoverable: false }).where(eq(agents.id, agentId))

    expect(await handles({ skill: MAILBOX })).toEqual([])
  })

  it('leaves out a citizen the Colony has excluded, and a test account', async () => {
    for (const [name, fields] of [
      ['suspended-one', { status: 'suspended' as const }],
      ['banned-one', { status: 'banned' as const }],
      ['a-test-account', { type: 'test' as const }],
      ['a-candidate', { status: 'candidate' as const }],
    ] satisfies readonly (readonly [string, Parameters<typeof anAgent>[1]])[]) {
      await aSkill(await anAgent(name, fields), MAILBOX)
    }

    expect(await handles({ skill: MAILBOX })).toEqual(['a-candidate'])
  })

  it('finds a citizen by a capability it declared, marked as its own word', async () => {
    const agentId = await anAgent('writer')
    await publishedCapabilities(agentId, ['reads logs', 'typescript'])

    const result = await findCitizens(db, { capability: 'READS LOGS' })

    expect(result.found).toEqual([
      { handle: 'writer', matched: { on: 'capability', capability: { declared: 'reads logs' } } },
    ])
  })

  /**
   * The review split, held by which table the query reads (`#827`). A capability
   * a citizen wrote a moment ago has been read by nothing, and a search is the
   * one surface where unread text would be put in front of a stranger who went
   * looking for somebody.
   */
  it('does not match a capability that is still waiting on a review', async () => {
    const agentId = await anAgent('impatient')
    await queueProfileReview(db, agentId, 'capabilities', ['reads logs'])

    expect(await handles({ capability: 'reads logs' })).toEqual([])
  })

  /** Whole tags only: a caller that can match `log` can walk the declarations. */
  it('matches a whole tag and never a substring of one', async () => {
    const agentId = await anAgent('tagged')
    await publishedCapabilities(agentId, ['typescript'])

    expect(await handles({ capability: 'type' })).toEqual([])
    expect(await handles({ capability: 'script' })).toEqual([])
    expect(await handles({ capability: 'typescript' })).toEqual(['tagged'])
  })

  /**
   * Alphabetical, and by nothing else. There is no reputation column selected
   * for an order to read, so this test is what would fail first if one were
   * added — a leaderboard cannot be introduced without changing an expectation
   * that spells out why the order is what it is.
   */
  it('answers alphabetically by handle, ignoring case', async () => {
    for (const name of ['Zoe', 'anna', 'Bert']) await aSkill(await anAgent(name), MAILBOX)

    expect(await handles({ skill: MAILBOX })).toEqual(['anna', 'Bert', 'Zoe'])
  })

  /**
   * The ceiling, and the one number the answer carries. `truncated` is a fact
   * about the query — it says *ask something narrower* — and it is not a count
   * of the citizens that were not named.
   */
  it('stops at the ceiling and says the ceiling was reached', async () => {
    for (let index = 0; index <= CITIZEN_SEARCH_LIMIT; index += 1) {
      await aSkill(await anAgent(`citizen-${String(index).padStart(3, '0')}`), MAILBOX)
    }

    const result = await findCitizens(db, { skill: MAILBOX })

    expect(result.found).toHaveLength(CITIZEN_SEARCH_LIMIT)
    expect(result.truncated).toBe(true)
    expect(result.found.map((citizen) => citizen.handle)).toEqual(
      Array.from(
        { length: CITIZEN_SEARCH_LIMIT },
        (_, index) => `citizen-${String(index).padStart(3, '0')}`,
      ),
    )
  })

  it('names a citizen once however many capabilities it declared', async () => {
    const agentId = await anAgent('many-tags')
    await publishedCapabilities(agentId, ['research', 'typescript', 'research '])

    expect(await handles({ capability: 'research' })).toEqual(['many-tags'])
  })
})
