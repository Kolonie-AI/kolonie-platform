import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { AgentIdSchema, HumanIdSchema, type AgentId, type HumanId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { accounts, agents, agentSkills, humans, submissions, tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { outsideQuestAudienceSql, sponsorAddressUnconfirmedSql } from './console-identity.js'
import { openSponsorIdentity, sponsorAgentOf, sponsorIdentityOf } from './sponsor-identity.js'

const target = databaseTestTarget()

/**
 * `#430`: a sponsor identity hangs off a human account, which is the real answer
 * to `#400`.
 *
 * The properties worth a real database are the ones a fake would flatten: that
 * `outsideQuestAudienceSql` still answers what it always answered, that a second
 * identity cannot be opened, and that the funding gate is not accidentally
 * carried over from the typed-address path it does not apply to.
 */
describe('the sponsor identity a person holds', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  const aPerson = async (): Promise<HumanId> => {
    const [row] = await db.insert(humans).values({}).returning({ id: humans.id })
    if (row === undefined) throw new Error('inserting a human returned no row')
    return HumanIdSchema.parse(row.id)
  }

  const predicate = async (agentId: AgentId): Promise<boolean> => {
    const [row] = await db.execute<{ sponsor: boolean }>(
      sql`select ${outsideQuestAudienceSql(agentId)} as sponsor`,
    )
    return row?.sponsor === true
  }

  const unconfirmed = async (agentId: AgentId): Promise<boolean> => {
    const [row] = await db.execute<{ held: boolean }>(
      sql`select ${sponsorAddressUnconfirmedSql(agentId)} as held`,
    )
    return row?.held === true
  }

  it('opens one, as an ordinary agents row that arrived by web', async () => {
    const humanId = await aPerson()

    const result = await openSponsorIdentity(db, { humanId, name: 'a-sponsor' })

    expect(result.outcome).toBe('opened')
    const [row] = await db
      .select({ platform: agents.platform, path: agents.registrationPath })
      .from(agents)
      .where(eq(agents.name, 'a-sponsor'))
    // `other` + `web` is the pair `registerWebIdentity` writes and the one the
    // predicate reads. `#108` is not reopened: no flag, no fourth status.
    expect(row).toEqual({ platform: 'other', path: 'web' })
  })

  /**
   * The criterion `#430` put first: *the predicate is unchanged and its tests
   * pass*. This is the other half — that an identity opened the new way is one
   * the unchanged predicate recognises.
   *
   * `#458` renamed it to {@link outsideQuestAudienceSql} and left the expression
   * alone; what moved to a different predicate was the deletion guard, which
   * `human-erasure.test.ts` covers.
   */
  it('is recognised by the untouched audience predicate', async () => {
    const humanId = await aPerson()
    const opened = await openSponsorIdentity(db, { humanId, name: 'a-sponsor' })
    if (opened.outcome === 'name-taken') throw new Error('unexpected name collision')

    expect(await predicate(opened.identity.id)).toBe(true)
  })

  /**
   * *One is the thing being paid for; two is an org feature, and organisations
   * are not in this design.*
   */
  it('refuses a second by answering the first', async () => {
    const humanId = await aPerson()
    const first = await openSponsorIdentity(db, { humanId, name: 'a-sponsor' })
    const second = await openSponsorIdentity(db, { humanId, name: 'another-sponsor' })

    expect(second.outcome).toBe('already-held')
    if (first.outcome === 'name-taken' || second.outcome === 'name-taken') {
      throw new Error('unexpected name collision')
    }
    expect(second.identity.id).toBe(first.identity.id)
    // And nothing was written for the name that was asked for.
    expect(
      await db.select({ id: agents.id }).from(agents).where(eq(agents.name, 'another-sponsor')),
    ).toEqual([])
  })

  it('says so rather than throwing when the name belongs to somebody else', async () => {
    await db.insert(agents).values({ name: 'taken', platform: 'openclaw' })

    const result = await openSponsorIdentity(db, { humanId: await aPerson(), name: 'taken' })

    expect(result).toEqual({ outcome: 'name-taken', name: 'taken' })
  })

  /**
   * **The funding gate must not follow this path**, and the reason is the whole
   * difference between the two ways in. `registerWebIdentity` writes an
   * *unproved* mailbox because somebody typed an address into a public form and
   * it may be a stranger's; `sponsorAddressUnconfirmedSql` then holds funding
   * until mail sent there has been read. Here the address came from the identity
   * provider the person just authenticated against, which is the stronger proof
   * — so holding funding would be asking them to prove by a worse method what
   * they proved by a better one.
   */
  it('records the provider’s address as proved, so funding is not held', async () => {
    const humanId = await aPerson()
    const opened = await openSponsorIdentity(db, {
      humanId,
      name: 'a-sponsor',
      address: 'someone@example.test',
    })
    if (opened.outcome === 'name-taken') throw new Error('unexpected name collision')

    const [row] = await db
      .select({ proved: accounts.proved, identifier: accounts.identifier })
      .from(accounts)
      .where(eq(accounts.agentId, opened.identity.id))

    expect(row).toEqual({ proved: true, identifier: 'someone@example.test' })
    expect(await unconfirmed(opened.identity.id)).toBe(false)
  })

  /**
   * GitHub may keep an address private or return a `noreply` one, and
   * `governance/privacy.md` §3 already names that as the ordinary answer rather
   * than an error. No row means no unproved claim to be held against.
   */
  it('writes no mailbox at all when the provider returned no address', async () => {
    const humanId = await aPerson()
    const opened = await openSponsorIdentity(db, { humanId, name: 'a-sponsor' })
    if (opened.outcome === 'name-taken') throw new Error('unexpected name collision')

    expect(
      await db.select().from(accounts).where(eq(accounts.agentId, opened.identity.id)),
    ).toEqual([])
    expect(await unconfirmed(opened.identity.id)).toBe(false)
  })

  /**
   * **The one place resolution deliberately disagrees with the predicate.**
   * `outsideQuestAudienceSql` lapses once an identity climbs anything, so that
   * an identity that arrived by web cannot become a caste. Resolving on it would
   * mean one that passed a rung lost the deposit address it was using — a
   * demotion by achievement.
   */
  it('still resolves after the identity has climbed something, though the predicate lapses', async () => {
    const humanId = await aPerson()
    const opened = await openSponsorIdentity(db, { humanId, name: 'a-sponsor' })
    if (opened.outcome === 'name-taken') throw new Error('unexpected name collision')

    const [task] = await db
      .insert(tasks)
      .values({
        type: 'a-rung',
        grantsSkills: ['profile'],
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
        taskId: task!.id,
        agentId: opened.identity.id,
        payload: {},
        status: 'passed',
        verifiedAt: new Date().toISOString(),
      })
      .returning({ id: submissions.id })
    await db
      .insert(agentSkills)
      .values({ agentId: opened.identity.id, skill: 'profile', submissionId: submission!.id })

    // The predicate lapses, exactly as it is designed to.
    expect(await predicate(opened.identity.id)).toBe(false)
    // And the console still finds whom to act as.
    expect((await sponsorIdentityOf(db, humanId))?.id).toBe(opened.identity.id)
    expect((await sponsorAgentOf(db, humanId))?.skills).toEqual(['profile'])
  })

  it('answers nothing for a person who has opened none', async () => {
    const humanId = await aPerson()

    expect(await sponsorIdentityOf(db, humanId)).toBeUndefined()
    expect(await sponsorAgentOf(db, humanId)).toBeUndefined()
  })

  /**
   * A person who operates an agent that registered over MCP has not thereby
   * opened a sponsor account. The resolver asks `registration_path = 'web'`, so
   * an operated citizen is not silently acted as.
   */
  it('does not mistake an operated citizen for a sponsor identity', async () => {
    const humanId = await aPerson()
    const [citizen] = await db
      .insert(agents)
      .values({ name: 'canary', platform: 'openclaw' })
      .returning({ id: agents.id })
    await db.execute(
      sql`insert into human_agents (agent_id, human_id) values (${citizen!.id}, ${humanId})`,
    )

    expect(await sponsorIdentityOf(db, humanId)).toBeUndefined()
    expect(AgentIdSchema.parse(citizen!.id)).toBeDefined()
    expect(randomUUID()).toBeDefined()
  })
})
