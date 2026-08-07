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
   * `#491`. `accounts_proved_identifier_unique` is unique on
   * `(kind, lower(identifier))` across **every agent in the Colony**, so the
   * insert above raised `23505` for anyone whose address was already proved
   * somewhere — a test citizen, an early registration. `isNameTakenError` did
   * not recognise that constraint, so it surfaced as an unhandled 500 on
   * `POST /funding/identity`, identically on every retry, with no other route to
   * a funding address.
   *
   * The population most likely to press that button is the one most likely to
   * have proved the address already, which is what made it worth a p1.
   */
  describe('when the provider’s address is already proved elsewhere', () => {
    /** Somebody else's agent, holding that address as a proved mailbox. */
    const anotherAgentProving = async (address: string): Promise<AgentId> => {
      const [row] = await db
        .insert(agents)
        .values({ name: `holder-${randomUUID().slice(0, 8)}`, platform: 'other' })
        .returning({ id: agents.id })
      if (row === undefined) throw new Error('inserting an agent returned no row')
      const agentId = AgentIdSchema.parse(row.id)

      await db.insert(accounts).values({
        agentId,
        kind: 'mailbox',
        identifier: address,
        proved: true,
        provedAt: sql`now()`,
        provenance: 'self-acquired',
      })
      return agentId
    }

    it('opens the identity anyway, writing no accounts row', async () => {
      const address = 'already@example.test'
      const holder = await anotherAgentProving(address)
      const humanId = await aPerson()

      const opened = await openSponsorIdentity(db, { humanId, name: 'a-sponsor', address })

      expect(opened.outcome).toBe('opened')
      if (opened.outcome === 'name-taken') throw new Error('unexpected name collision')

      // No row for the new identity…
      expect(
        await db.select().from(accounts).where(eq(accounts.agentId, opened.identity.id)),
      ).toEqual([])
      // …and the existing one is exactly as it was.
      const [held] = await db
        .select({ identifier: accounts.identifier, proved: accounts.proved })
        .from(accounts)
        .where(eq(accounts.agentId, holder))
      expect(held).toEqual({ identifier: address, proved: true })
    })

    /**
     * No row means no *unproved* claim, which is what the gate asks about. The
     * person pressed a button to get a funding address and they get one.
     */
    it('does not hold funding for the identity it opened', async () => {
      const address = 'already@example.test'
      await anotherAgentProving(address)
      const humanId = await aPerson()

      const opened = await openSponsorIdentity(db, { humanId, name: 'a-sponsor', address })
      if (opened.outcome === 'name-taken') throw new Error('unexpected name collision')

      expect(await unconfirmed(opened.identity.id)).toBe(false)
      expect(await predicate(opened.identity.id)).toBe(true)
    })

    /** Case-insensitively, because the index is on `lower(identifier)`. */
    it('recognises the same address in a different case', async () => {
      await anotherAgentProving('Already@Example.test')
      const humanId = await aPerson()

      const opened = await openSponsorIdentity(db, {
        humanId,
        name: 'a-sponsor',
        address: 'already@EXAMPLE.TEST',
      })

      expect(opened.outcome).toBe('opened')
      if (opened.outcome === 'name-taken') throw new Error('unexpected name collision')
      expect(
        await db.select().from(accounts).where(eq(accounts.agentId, opened.identity.id)),
      ).toEqual([])
    })

    /**
     * An *unproved* row does not reserve the address — the index is partial on
     * `proved = true` — so this one still writes, and skipping it would be a
     * different defect wearing this fix's clothes.
     */
    it('still writes the row when the existing hold is unproved', async () => {
      const address = 'unproved@example.test'
      const [row] = await db
        .insert(agents)
        .values({ name: 'a-claimant', platform: 'other' })
        .returning({ id: agents.id })
      if (row === undefined) throw new Error('inserting an agent returned no row')
      await db.insert(accounts).values({
        agentId: AgentIdSchema.parse(row.id),
        kind: 'mailbox',
        identifier: address,
        proved: false,
        provenance: 'self-acquired',
      })

      const humanId = await aPerson()
      const opened = await openSponsorIdentity(db, { humanId, name: 'a-sponsor', address })
      if (opened.outcome === 'name-taken') throw new Error('unexpected name collision')

      const [written] = await db
        .select({ identifier: accounts.identifier, proved: accounts.proved })
        .from(accounts)
        .where(eq(accounts.agentId, opened.identity.id))
      expect(written).toEqual({ identifier: address, proved: true })
    })

    /**
     * The skip must not become a catch-all. A collision on a *different*
     * constraint is the next defect, and it has to keep raising.
     */
    it('still reports a taken name rather than swallowing it', async () => {
      const address = 'already@example.test'
      await anotherAgentProving(address)
      const first = await openSponsorIdentity(db, {
        humanId: await aPerson(),
        name: 'the-one-name',
        address,
      })
      expect(first.outcome).toBe('opened')

      const second = await openSponsorIdentity(db, {
        humanId: await aPerson(),
        name: 'the-one-name',
        address,
      })

      expect(second).toEqual({ outcome: 'name-taken', name: 'the-one-name' })
    })
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
