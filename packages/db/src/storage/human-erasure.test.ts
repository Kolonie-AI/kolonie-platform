import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { RegisterAgentRequestSchema, type AgentId, type HumanId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, personOf, truncateAll } from '../testing.js'
import { agentSkills, submissions, taskAttempts, tasks } from '../schema/index.js'
import { creditBalance } from './funding.js'
import { registerAgent } from './agents.js'
import { connectIdentity, findOrCreateHuman, openHumanSession } from './humans.js'
import { openSponsorIdentity } from './sponsor-identity.js'
import { issueCodeForAgent, redeemCodeAsHuman } from './human-links.js'
import {
  recordOperatorAddress,
  confirmOperatorAddress,
  hasConfirmedOperator,
} from './operator-addresses.js'
import { countUnreadOperatorNotes } from './operator-notes.js'
import { deleteHuman, humanExport, humanUnreachableIdentities } from './human-erasure.js'

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

  /**
   * **The address varies with the subject, and it has to since `#574`.**
   *
   * An unknown identity carrying an address one person already holds now
   * attaches to them rather than creating a second account. A fixture that gave
   * every caller one address would hand back the *same* person for two
   * subjects, and every test here asking about two people would be asking about
   * one — silently, and while passing.
   */
  const aPerson = async (subject = '4815162342') => {
    const human = personOf(
      await findOrCreateHuman(db, {
        provider: 'github',
        subject,
        email: `${subject}@example.com`,
      }),
    )
    if (human === undefined) throw new Error('no person was created')
    return human
  }

  const link = async (humanId: HumanId, agentId: AgentId): Promise<void> => {
    const code = await issueCodeForAgent(db, agentId)
    const redeemed = await redeemCodeAsHuman(db, code.code, humanId)
    if (redeemed.outcome !== 'linked') throw new Error(redeemed.outcome)
  }

  /**
   * An identity with no way in of its own, made the way the console really makes
   * one (`#430`): `openSponsorIdentity` writes an `agents` row and links it, and
   * issues no credential — which is precisely why the login is the only door to
   * it.
   *
   * **Not `anAgent()` with `registration_path` patched to `web`**, which is what
   * these tests used to do. `registerAgent` issues an API key, so an agent
   * doctored that way holds a credential of its own and would be *reachable* —
   * the fixture would have been asserting against a state the product cannot
   * produce.
   */
  const anUnreachableIdentity = async (humanId: HumanId, name: string): Promise<AgentId> => {
    const opened = await openSponsorIdentity(db, { humanId, name })
    if (opened.outcome !== 'opened') throw new Error(opened.outcome)
    return opened.identity.id
  }

  /** And the credential that ends that, as `#459`'s adoption will mint it. */
  const giveOwnKey = async (agentId: AgentId): Promise<void> => {
    await db.execute(
      sql`insert into credentials (agent_id, kind, secret_hash)
          values (${agentId}, 'api-key', ${`hash-${agentId}`})`,
    )
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

  /**
   * **A person holding two identities loses both** (`#574`), and the guard that
   * decides whether they may go at all is unchanged by the second.
   *
   * `#458`'s refusal is about *agents* this login is the only way to reach, and
   * an extra door onto the person changes nothing about that — but *changes
   * nothing* is the sort of claim that is true until somebody makes the guard
   * read the identity table, so it is asserted rather than reasoned about.
   */
  it('removes both identities of a person who attached a second door', async () => {
    const human = await aPerson()
    await connectIdentity(db, human.id, {
      provider: 'google',
      subject: 'g-1',
      email: 'elsewhere@example.com',
    })

    const agentId = await anAgent()
    await link(human.id, agentId)

    // The guard answers the same with two identities as with one.
    expect(await humanUnreachableIdentities(db, human.id)).toEqual([])

    expect((await deleteHuman(db, human.id)).outcome).toBe('deleted')

    const [row] = await db.execute<{ total: number }>(
      sql`select count(*)::int as total from human_identities where human_id = ${human.id}`,
    )
    expect(row?.total).toBe(0)
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
   * **Refused, and the reason is named.** Such an identity carries quests
   * somebody paid for and reports somebody already received; deleting the login
   * must not silently orphan it.
   */
  it('refuses a person holding an identity nothing else can reach, and names it', async () => {
    const human = await aPerson()
    await anUnreachableIdentity(human.id, 'a-sponsor')

    const result = await deleteHuman(db, human.id)

    expect(result.outcome).toBe('holds-unreachable-identity')
    if (result.outcome === 'holds-unreachable-identity') {
      expect(result.unreachable).toEqual(['a-sponsor'])
    }
  })

  /**
   * **The latent bug `#458` names, in the direction that loses the guard.**
   *
   * The old predicate was *arrived by web and holds no skill*, so an identity
   * that climbed a rung fell out of it and the refusal stopped firing — while
   * the identity still owned paid quests and still had no key of its own. The
   * question was never about skills, and this is the test that says so.
   */
  it('still refuses once that identity has climbed a rung', async () => {
    const human = await aPerson()
    const identity = await anUnreachableIdentity(human.id, 'a-climber')
    await grantSkill(identity, 'identity')

    const result = await deleteHuman(db, human.id)

    expect(result.outcome).toBe('holds-unreachable-identity')
  })

  /**
   * **And the direction that keeps it too long**, which is the state `#459`
   * puts an identity into: once it holds a key of its own, the login is not the
   * only way in and there is nothing left to strand.
   */
  it('allows the deletion once that identity holds a key of its own', async () => {
    const human = await aPerson()
    const identity = await anUnreachableIdentity(human.id, 'an-adoptee')
    await giveOwnKey(identity)

    const result = await deleteHuman(db, human.id)

    expect(result.outcome).toBe('deleted')
  })

  /** A revoked key is not a way in, and the refusal comes back. */
  it('refuses again once that key is revoked', async () => {
    const human = await aPerson()
    const identity = await anUnreachableIdentity(human.id, 'a-revoked')
    await giveOwnKey(identity)
    await db.execute(sql`update credentials set revoked_at = now() where agent_id = ${identity}`)

    const result = await deleteHuman(db, human.id)

    expect(result.outcome).toBe('holds-unreachable-identity')
  })

  /** And the refusal changes nothing — the whole point of it being a refusal. */
  it('leaves the account whole when it refuses', async () => {
    const human = await aPerson()
    const identity = await anUnreachableIdentity(human.id, 'a-sponsor')

    await deleteHuman(db, human.id)

    const [row] = await db.execute<{ total: number }>(
      sql`select count(*)::int as total from humans where id = ${human.id}`,
    )
    expect(row?.total).toBe(1)
    expect(await countUnreadOperatorNotes(db, identity)).toBe(0)
  })

  /**
   * **How an identity arrived is no longer part of the question** (`#458`).
   *
   * This test used to assert the opposite of the one above it: that a `web`
   * identity which had climbed a rung was *not* refused, because the predicate
   * lapsed on the skill. That was the proxy breaking, and the pair now reads the
   * way it should — a skill changes nothing, and a key of its own changes
   * everything.
   */
  it('does not refuse for a web identity that holds a key of its own', async () => {
    const human = await aPerson()
    const identity = await anUnreachableIdentity(human.id, 'by-web-with-a-key')
    await grantSkill(identity, 'mailbox')
    await giveOwnKey(identity)

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
    it('names the unreachable identities without deleting anything', async () => {
      const human = await aPerson()
      await anUnreachableIdentity(human.id, 'a-sponsor')

      expect(await humanUnreachableIdentities(db, human.id)).toEqual(['a-sponsor'])
    })

    it('is empty for a person who holds none', async () => {
      const agentId = await anAgent()
      const human = await aPerson()
      await link(human.id, agentId)

      expect(await humanUnreachableIdentities(db, human.id)).toEqual([])
    })

    /**
     * **The page and the route cannot disagree**, which is the reason this
     * function exists at all: it names what the refusal would refuse for, so a
     * person is told before pressing rather than after.
     */
    it('names exactly what the refusal names', async () => {
      const human = await aPerson()
      await anUnreachableIdentity(human.id, 'a-sponsor')
      await link(human.id, await anAgent('has-a-key'))

      const named = await humanUnreachableIdentities(db, human.id)
      const result = await deleteHuman(db, human.id)

      expect(result.outcome).toBe('holds-unreachable-identity')
      if (result.outcome === 'holds-unreachable-identity') {
        expect([...result.unreachable].sort()).toEqual([...named].sort())
      }
    })
  })
})
