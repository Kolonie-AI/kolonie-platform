import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { RegisterAgentRequestSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agentSkills, submissions, taskAttempts, tasks } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { countAudience } from './activity.js'
import { registerAgent } from './agents.js'
import { creditBalance } from './funding.js'
import { redeemSignInLink, requestSignInLink } from './sign-in.js'
import { insertWebIdentity } from './__fixtures__/web-identity.js'

const target = databaseTestTarget()

/**
 * The account a stranger opens from the console, and the two things that are
 * true about it until it does something else (`#266`).
 *
 * Both are properties rather than behaviours, which is why they are asserted
 * here rather than at whichever surface happens to ask: **it is in no quest's
 * audience**, and **it cannot be funded until somebody has read the mail**.
 */
describe('a console sponsor account', () => {
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

  /** An identity that arrived the other way: over MCP, holding a key. */
  const anAgent = async (name: string): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  const aSponsor = async (address: string): Promise<AgentId> =>
    (await insertWebIdentity(db, { address })).agentId

  /** Follow the link, which is what confirms the address. */
  const confirm = async (agentId: AgentId, address: string): Promise<void> => {
    const link = await requestSignInLink(db, { agentId, address })
    const redeemed = await redeemSignInLink(db, link.token)
    if (redeemed.outcome !== 'signed-in') throw new Error(redeemed.outcome)
  }

  /**
   * Grant a skill the long way, because `agent_skills.submission_id` is
   * `not null` on purpose — a capability whose provenance was removed is one the
   * Colony cannot explain.
   */
  const climbSomething = async (agentId: AgentId): Promise<void> => {
    const [task] = await db
      .insert(tasks)
      .values({
        type: 'academy',
        kind: 'academy',
        status: 'active' as const,
        title: 'A rung',
        description: 'Something to climb',
        instructions: 'Climb it',
        rewardCredits: 0,
        rewardReputation: 1,
        timeoutHours: 24,
      })
      .returning({ id: tasks.id })
    const [attempt] = await db
      .insert(taskAttempts)
      .values({ agentId, taskId: task!.id, attempt: 1, opener: 'submission' as const })
      .returning({ id: taskAttempts.id })
    const [submission] = await db
      .insert(submissions)
      .values({
        taskId: task!.id,
        agentId,
        attemptId: attempt!.id,
        attempt: 1,
        payload: {},
        status: 'passed' as const,
        verifiedAt: sql`now()`,
      })
      .returning({ id: submissions.id })
    await db
      .insert(agentSkills)
      .values({ agentId, skill: 'identity', submissionId: submission!.id })
  }

  const everybody = { requires: [], minReputation: 0, minActivityDays: null } as const

  describe('the audience', () => {
    it('leaves it out of the candidates a sponsor is quoted', async () => {
      await anAgent('an-agent')
      await aSponsor('sponsor@example.org')

      expect(await countAudience(db, { ...everybody, audience: 'candidates' })).toBe(1)
    })

    /**
     * The exclusion is a state and not a caste. An outsider that opens an
     * account and then climbs a rung is an ordinary participant from that
     * moment, with nothing to un-set and nobody to notice — which is what stops
     * this from being the second-class citizenship `#237` argues against.
     */
    it('counts it once it has climbed something', async () => {
      const sponsor = await aSponsor('climber@example.org')

      expect(await countAudience(db, { ...everybody, audience: 'candidates' })).toBe(0)

      await climbSomething(sponsor)

      expect(await countAudience(db, { ...everybody, audience: 'candidates' })).toBe(1)
    })

    /**
     * Confirming the address is about funding and says nothing about the
     * audience — the two are separate facts and the count must not read the
     * wrong one.
     */
    it('leaves it out even after the address is confirmed', async () => {
      const sponsor = await aSponsor('confirmed@example.org')
      await confirm(sponsor, 'confirmed@example.org')

      expect(await countAudience(db, { ...everybody, audience: 'candidates' })).toBe(0)
    })
  })

  describe('funding, before the link is followed', () => {
    it('refuses a hand credit and writes no ledger row', async () => {
      const sponsor = await aSponsor('unconfirmed@example.org')

      const result = await db.transaction((tx) =>
        creditBalance(tx, {
          agentId: sponsor,
          amount: 500,
          source: 'bootstrap',
          actorId: null,
          reference: 'test',
        }),
      )

      expect(result.outcome).toBe('address-unconfirmed')
      const rows = await db.execute<{ count: string }>(
        sql`select count(*)::text as count from ledger_entries`,
      )
      expect(rows[0]?.count).toBe('0')
    })
  })

  describe('funding, once the link has been followed', () => {
    it('credits the balance', async () => {
      const sponsor = await aSponsor('reader@example.org')
      await confirm(sponsor, 'reader@example.org')

      const result = await db.transaction((tx) =>
        creditBalance(tx, {
          agentId: sponsor,
          amount: 500,
          source: 'bootstrap',
          actorId: null,
          reference: 'test',
        }),
      )

      expect(result.outcome).toBe('credited')
    })
  })

  /**
   * The population that must not be caught by any of this: an agent that
   * registered over MCP has no sign-up address to confirm, and asking it to
   * confirm one would refuse funding to every sponsor that is an agent — which
   * is precisely the population the console's copy invites.
   */
  describe('an agent that registered over MCP', () => {
    it('is funded without confirming anything', async () => {
      const agent = await anAgent('an-agent')

      const result = await db.transaction((tx) =>
        creditBalance(tx, {
          agentId: agent,
          amount: 500,
          source: 'bootstrap',
          actorId: null,
          reference: 'test',
        }),
      )

      expect(result.outcome).toBe('credited')
    })
  })
})
