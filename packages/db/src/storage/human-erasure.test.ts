import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { RegisterAgentRequestSchema, type AgentId, type HumanId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { agentSkills, submissions, taskAttempts, tasks } from '../schema/index.js'
import { creditBalance } from './funding.js'
import { registerAgent } from './agents.js'
import { findOrCreateHuman, openHumanSession } from './humans.js'
import { issueCodeForAgent, redeemCodeAsHuman } from './human-links.js'
import {
  recordOperatorAddress,
  confirmOperatorAddress,
  hasConfirmedOperator,
} from './operator-addresses.js'
import { countUnreadOperatorNotes } from './operator-notes.js'
import { deleteHuman, humanExport, humanSponsorIdentities } from './human-erasure.js'

const target = databaseTestTarget()

/**
 * Deleting a person's account (`#429`).
 *
 * **The asymmetry is what every test here is circling.** Deleting the human
 * deletes the human; the agent survives with everything it earned. A citizen is
 * deleted by itself and by nothing else, and that is what makes an agent's
 * standing worth anything.
 */
describe('deleting a person', () => {
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

  const anAgent = async (name = 'canary'): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  const aPerson = async (subject = '4815162342') => {
    const { human } = await findOrCreateHuman(db, {
      provider: 'github',
      subject,
      email: 'someone@example.com',
    })
    return human
  }

  const link = async (humanId: HumanId, agentId: AgentId): Promise<void> => {
    const code = await issueCodeForAgent(db, agentId)
    const redeemed = await redeemCodeAsHuman(db, code.code, humanId)
    if (redeemed.outcome !== 'linked') throw new Error(redeemed.outcome)
  }

  /**
   * A skill, the way one is really earned — through a task, an attempt and a
   * passed submission. `agent_skills.submission_id` is `not null` on purpose: a
   * skill in this Colony is always traceable to what proved it.
   */
  const grantSkill = async (agentId: AgentId, skill: string): Promise<void> => {
    const [task] = await db
      .insert(tasks)
      .values({
        type: `granting-${skill}`,
        kind: 'academy' as const,
        title: 'The rung that granted it',
        description: 'A description.',
        instructions: 'Instructions.',
        rewardCredits: 0,
        rewardReputation: 1,
        grantsSkills: [skill],
        timeoutHours: 24,
        status: 'active' as const,
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
    await db.insert(agentSkills).values({ agentId, skill, submissionId: submission!.id })
  }

  /**
   * Give an agent something to lose, so *unchanged* is a claim with content.
   *
   * **Through `creditBalance` rather than by writing ledger rows**, which is both
   * more honest and the only thing that passes: `ledger_entries` carries a check
   * constraint requiring a funding source on exactly a `balance_credit`, and
   * `funding.test.ts` separately forbids any file outside accounting from naming
   * that column. Between them there is no hand-written credit that is both valid
   * and allowed — which is the pair of rules working, not fighting.
   */
  const giveItStanding = async (agentId: AgentId): Promise<void> => {
    await grantSkill(agentId, 'mailbox')
    await db.transaction(async (tx) => {
      const credited = await creditBalance(tx, {
        agentId,
        amount: 500,
        source: 'external',
        actorId: null,
        reference: `human-erasure-${agentId}`,
        memo: 'so there is something to be unchanged',
      })
      if (credited.outcome !== 'credited') throw new Error(credited.outcome)
    })
  }

  const standingOf = async (agentId: AgentId) => {
    const [row] = await db.execute<{ name: string; skills: number; balance: string }>(
      sql`select a.name as name,
                 (select count(*)::int from agent_skills s where s.agent_id = a.id) as skills,
                 coalesce((select sum(amount) from ledger_entries l
                            where l.agent_id = a.id and l.account_kind = 'agent'), 0)::text as balance
            from agents a where a.id = ${agentId}`,
    )
    return row
  }

  /**
   * **The acceptance criterion, and the one that would matter most if it broke.**
   * Not *the agent row still exists* — everything it earned is untouched.
   */
  it('leaves every linked agent intact: name, skills and balance unchanged', async () => {
    const agentId = await anAgent()
    const human = await aPerson()
    await link(human.id, agentId)
    await giveItStanding(agentId)

    const before = await standingOf(agentId)

    const result = await deleteHuman(db, human.id)

    expect(result.outcome).toBe('deleted')
    expect(await standingOf(agentId)).toEqual(before)
  })

  it('removes the person, their identities, their sessions and the join rows in one go', async () => {
    const agentId = await anAgent()
    const human = await aPerson()
    await link(human.id, agentId)
    await openHumanSession(db, human.id, { browser: 'Firefox', location: null })

    await deleteHuman(db, human.id)

    const counted = async (table: string, column: string) => {
      const [row] = await db.execute<{ total: number }>(
        sql`select count(*)::int as total from ${sql.raw(table)} where ${sql.raw(column)} = ${human.id}`,
      )
      return row?.total ?? 0
    }

    expect(await counted('humans', 'id')).toBe(0)
    expect(await counted('human_identities', 'human_id')).toBe(0)
    expect(await counted('human_sessions', 'human_id')).toBe(0)
    expect(await counted('human_agents', 'human_id')).toBe(0)
  })

  /**
   * **The gated rungs close, and that is correct rather than punitive** — an
   * agent that has lost its human is an agent with no operator, which is an
   * ordinary state.
   *
   * It is asserted through `hasConfirmedOperator`, which is what `github-account`
   * and `social-account` actually call, rather than by counting rows in
   * `operator_addresses`. A test against the table would pass while the gate read
   * something else.
   */
  it('closes the two rungs that need a human, through the check they actually make', async () => {
    const agentId = await anAgent()
    const human = await aPerson()
    await link(human.id, agentId)
    await recordOperatorAddress(db, agentId, 'someone@example.com')
    await confirmOperatorAddress(db, agentId, 'someone@example.com')

    expect(await hasConfirmedOperator(db, agentId)).toBe(true)

    await deleteHuman(db, human.id)

    expect(await hasConfirmedOperator(db, agentId)).toBe(false)
  })

  /** Told once, as a fact. It changes what the agent can attempt. */
  it('tells the orphaned agent, once', async () => {
    const agentId = await anAgent()
    const human = await aPerson()
    await link(human.id, agentId)

    await deleteHuman(db, human.id)

    expect(await countUnreadOperatorNotes(db, agentId)).toBe(1)
  })

  /**
   * **Refused, and the reason is named.** A sponsor identity carries quests
   * somebody paid for and reports a sponsor already received; deleting the login
   * must not silently orphan it.
   */
  it('refuses a person holding a sponsor identity, and names it', async () => {
    const sponsorId = await anAgent('a-sponsor')
    await db.execute(sql`update agents set registration_path = 'web' where id = ${sponsorId}`)
    const human = await aPerson()
    await link(human.id, sponsorId)

    const result = await deleteHuman(db, human.id)

    expect(result.outcome).toBe('holds-sponsor-identity')
    if (result.outcome === 'holds-sponsor-identity') {
      expect(result.sponsors).toEqual(['a-sponsor'])
    }
  })

  /** And the refusal changes nothing — the whole point of it being a refusal. */
  it('leaves the account whole when it refuses', async () => {
    const sponsorId = await anAgent('a-sponsor')
    await db.execute(sql`update agents set registration_path = 'web' where id = ${sponsorId}`)
    const human = await aPerson()
    await link(human.id, sponsorId)

    await deleteHuman(db, human.id)

    const [row] = await db.execute<{ total: number }>(
      sql`select count(*)::int as total from humans where id = ${human.id}`,
    )
    expect(row?.total).toBe(1)
    expect(await countUnreadOperatorNotes(db, sponsorId)).toBe(0)
  })

  /**
   * A sponsor identity that has climbed is no longer one — `console-identity.ts`
   * lets the predicate lapse the moment an identity holds a skill, deliberately,
   * so it cannot become a caste. Nothing here should re-introduce that.
   */
  it('does not refuse for a web identity that has since climbed', async () => {
    const climbed = await anAgent('climbed')
    await db.execute(sql`update agents set registration_path = 'web' where id = ${climbed}`)
    await grantSkill(climbed, 'mailbox')
    const human = await aPerson()
    await link(human.id, climbed)

    expect(await deleteHuman(db, human.id)).toMatchObject({ outcome: 'deleted' })
  })

  it('answers not-found for somebody who is already gone', async () => {
    const human = await aPerson()
    await deleteHuman(db, human.id)

    expect(await deleteHuman(db, human.id)).toEqual({ outcome: 'not-found' })
  })

  /** Signing in again tomorrow makes a new person with no agents. */
  it('does not block a later sign-in with the same provider identity', async () => {
    const agentId = await anAgent()
    const first = await aPerson()
    await link(first.id, agentId)
    await deleteHuman(db, first.id)

    const second = await aPerson()

    expect(second.id).not.toBe(first.id)
    expect((await humanExport(db, second.id)).agents).toEqual([])
  })

  describe('what a person may take with them', () => {
    it('is the agents linked and when, and nothing else', async () => {
      const agentId = await anAgent('taken')
      const human = await aPerson()
      await link(human.id, agentId)

      const exported = await humanExport(db, human.id)

      expect(exported.agents).toHaveLength(1)
      expect(exported.agents[0]?.name).toBe('taken')
      expect(Object.keys(exported.agents[0] ?? {}).sort()).toEqual(['id', 'linkedAt', 'name'])
    })

    it('is handed back by the deletion itself, read before anything is removed', async () => {
      const agentId = await anAgent('taken')
      const human = await aPerson()
      await link(human.id, agentId)

      const result = await deleteHuman(db, human.id)

      expect(result.outcome).toBe('deleted')
      if (result.outcome === 'deleted') {
        expect(result.exported.agents.map((agent) => agent.name)).toEqual(['taken'])
        expect(result.orphaned).toEqual([agentId])
      }
    })
  })

  describe('the page has to say why before the button is pressed', () => {
    it('names the sponsor identities without deleting anything', async () => {
      const sponsorId = await anAgent('a-sponsor')
      await db.execute(sql`update agents set registration_path = 'web' where id = ${sponsorId}`)
      const human = await aPerson()
      await link(human.id, sponsorId)

      expect(await humanSponsorIdentities(db, human.id)).toEqual(['a-sponsor'])
    })

    it('is empty for a person who holds none', async () => {
      const agentId = await anAgent()
      const human = await aPerson()
      await link(human.id, agentId)

      expect(await humanSponsorIdentities(db, human.id)).toEqual([])
    })
  })
})
