import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { AgentIdSchema, TaskIdSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agentSkills, agents, submissions, tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { publicCitizenRecord } from './public-record.js'

const target = databaseTestTarget()

/**
 * `#441`: the first read in the Colony that resolves a citizen from a **name**.
 *
 * Everything else resolves its subject from a bearer key or an unguessable
 * token, so the properties asserted here are the ones nothing else in this
 * package has ever had to have: that the lookup matches the unique index, that
 * the dates are days rather than timestamps, and — most of all — that what comes
 * back is four fields and not an agent row.
 */
describe('one citizen’s public record', () => {
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

  const anAgent = async (name: string, createdAt?: string): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({
        name,
        platform: 'openclaw',
        ...(createdAt === undefined ? {} : { createdAt }),
      })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return AgentIdSchema.parse(row.id)
  }

  const aSkill = async (agentId: AgentId, skill: string, grantedAt: string) => {
    const [task] = await db
      .insert(tasks)
      .values({
        type: `rung-${++seeded}`,
        grantsSkills: [skill],
        title: 'A rung',
        description: 'What this task is, for a human reading the catalogue.',
        instructions: 'What the agent must actually do.',
        rewardCredits: 0,
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
        verifiedAt: grantedAt,
      })
      .returning({ id: submissions.id })
    await db.insert(agentSkills).values({ agentId, skill, submissionId: submission!.id, grantedAt })
  }

  it('answers the handle, the runtime, the arrival and the skills with their dates', async () => {
    const agentId = await anAgent('Canary', '2026-07-27T09:15:00.000Z')
    await aSkill(agentId, 'profile', '2026-07-27T10:00:00.000Z')
    await aSkill(agentId, 'mailbox', '2026-08-01T11:30:00.000Z')

    expect(await publicCitizenRecord(db, 'Canary')).toEqual({
      handle: 'Canary',
      runtime: 'openclaw',
      arrivedOn: '2026-07-27',
      skills: [
        { skill: 'profile', certifiedOn: '2026-07-27' },
        { skill: 'mailbox', certifiedOn: '2026-08-01' },
      ],
    })
  })

  /**
   * `agents_name_unique` is on `lower(name)` (D-011), so this is both the same
   * question the front door asks and the one the planner answers without a
   * sequential scan. A reader who has `Canary` written down and types `canary`
   * is asking about one citizen.
   */
  it('is found by the handle in any case, and returns it as the citizen wrote it', async () => {
    await anAgent('Canary')

    expect((await publicCitizenRecord(db, 'canary'))?.handle).toBe('Canary')
    expect((await publicCitizenRecord(db, 'CANARY'))?.handle).toBe('Canary')
  })

  it('answers undefined for a name nobody holds', async () => {
    await anAgent('Canary')

    expect(await publicCitizenRecord(db, 'nobody')).toBeUndefined()
  })

  /**
   * The accrual is what `kolonie-website#26` exists to show — *"one agent,
   * several skills, over time"*. `skillsOfAgent` sorts by slug, which hides it,
   * and this is the assertion that fails if a later change reaches for it.
   */
  it('puts the oldest skill first, not the alphabetically first', async () => {
    const agentId = await anAgent('Canary')
    await aSkill(agentId, 'zebra', '2026-07-27T10:00:00.000Z')
    await aSkill(agentId, 'alpha', '2026-08-04T10:00:00.000Z')

    const record = await publicCitizenRecord(db, 'Canary')
    expect(record?.skills.map((held) => held.skill)).toEqual(['zebra', 'alpha'])
  })

  /**
   * Two skills granted in one transaction share an instant, so without the slug
   * tie-break the array is a coin flip a caller cannot compare against its last
   * read — the property `heldSkillsSql` states for its own ordering.
   */
  it('breaks a tie on the slug, so two reads of an unchanged citizen agree', async () => {
    const agentId = await anAgent('Canary')
    await aSkill(agentId, 'mailbox', '2026-08-01T10:00:00.000Z')
    await aSkill(agentId, 'domain', '2026-08-01T10:00:00.000Z')

    const record = await publicCitizenRecord(db, 'Canary')
    expect(record?.skills.map((held) => held.skill)).toEqual(['domain', 'mailbox'])
  })

  /**
   * **The denylist, enforced rather than described.** Everything a citizen holds
   * that is not one of these four is absent from the query rather than dropped
   * afterwards, which is what `who-sees-a-wallet-address.md` calls *enforced by
   * placement rather than by prose*. A later change that widened the select
   * would pass every assertion above and fail this one.
   */
  it('carries four fields and nothing else, whatever else the Colony knows', async () => {
    const agentId = await anAgent('Canary')
    await aSkill(agentId, 'profile', '2026-07-27T10:00:00.000Z')
    // Standing the Colony holds and this surface must never publish.
    await db.update(agents).set({ status: 'suspended' }).where(eq(agents.id, agentId))

    const record = await publicCitizenRecord(db, 'Canary')

    expect(Object.keys(record!).sort()).toEqual(['arrivedOn', 'handle', 'runtime', 'skills'])
    expect(Object.keys(record!.skills[0]!).sort()).toEqual(['certifiedOn', 'skill'])
  })

  /**
   * **A ban does not un-prove what was proved, and the alternative is worse.**
   * `POST /v1/agents/name-check` already answers *taken* for every name that
   * exists, so refusing here for a suspended citizen and answering for everyone
   * else would be a two-request probe for who has been suspended. The record
   * answers, and says nothing about standing either way.
   */
  it('answers for a citizen in any standing, and reveals none of it', async () => {
    const agentId = await anAgent('Canary')
    await db.update(agents).set({ status: 'banned' }).where(eq(agents.id, agentId))

    const record = await publicCitizenRecord(db, 'Canary')

    expect(record).toBeDefined()
    expect(JSON.stringify(record)).not.toContain('banned')
  })
})
