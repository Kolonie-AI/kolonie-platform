import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { RegisterAgentRequestSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, agentSkills, humanLinkCodes, submissions, tasks } from '../schema/index.js'
import { operatorAddresses } from '../schema/operator-addresses.js'
import { connectForTests, databaseTestTarget, personOf, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { findOrCreateHuman } from './humans.js'
import {
  agentsOperatedBy,
  issueCodeForAgent,
  issueCodeForHuman,
  linkedOperator,
  liveCodeForHuman,
  mintLinkCode,
  operatesAgent,
  operatorOf,
  redeemCodeAsAgent,
  redeemCodeAsHuman,
} from './human-links.js'

const target = databaseTestTarget()

/**
 * Linking a person to an agent (`#426`).
 *
 * The two properties worth stating before the tests: the link **confirms the
 * operator relationship**, which is what opens `github-account` and
 * `social-account`; and it does so **only when the provider gave an address that
 * can receive mail**, because confirming on an address no mail reaches would
 * make the Colony's confirmation weaker than the form answer it replaces.
 */
describe('linking a person to an agent', () => {
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

  /** A granted skill, with the passed submission `agent_skills` insists on. */
  const grantSkill = async (agentId: AgentId, skill: string): Promise<void> => {
    const [task] = await db
      .insert(tasks)
      .values({
        type: `rung-${skill}`,
        title: 'A rung the Academy carries',
        description: 'What this task is.',
        instructions: 'What the agent must do.',
        rewardReputation: 1,
        timeoutHours: 24,
        status: 'active' as const,
      })
      .returning({ id: tasks.id })
    const [submission] = await db
      .insert(submissions)
      .values({
        taskId: task!.id,
        agentId,
        payload: {},
        attempt: 1,
        status: 'passed' as const,
        verifiedAt: sql`now()`,
      })
      .returning({ id: submissions.id })
    await db.insert(agentSkills).values({ agentId, skill, submissionId: submission!.id })
  }

  /**
   * **The address follows the subject unless a caller names one**, and it has to
   * since `#574`.
   *
   * An unknown identity carrying an address one person already holds now
   * attaches to them instead of creating a second account. This fixture gave
   * every caller `someone@example.com`, so two subjects came back as **one
   * person** — and the test asking whether a person sees only their own agents
   * saw both, correctly, because there was only one person. It failed loudly,
   * which is the good case; a fixture like this failing quietly is the whole
   * risk of the change.
   */
  const aPerson = async (over: { subject?: string; email?: string | null } = {}) => {
    const subject = over.subject ?? '4815162342'
    const human = personOf(
      await findOrCreateHuman(db, {
        provider: 'github',
        subject,
        email: over.email === undefined ? `${subject}@example.com` : over.email,
      }),
    )
    if (human === undefined) throw new Error('no person was created')
    return human
  }

  describe('the code itself', () => {
    it('carries no character a person can misread for another', () => {
      const code = mintLinkCode()

      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/)
      // I, O, 0 and 1 are the pairs a person typing off a screen conflates.
      expect(code).not.toMatch(/[IO01]/)
    })

    it('is not the same code twice', () => {
      const minted = new Set(Array.from({ length: 200 }, () => mintLinkCode()))

      expect(minted.size).toBe(200)
    })
  })

  describe('the person goes first', () => {
    it('links the agent that redeems it', async () => {
      const person = await aPerson()
      const agent = await anAgent()
      const { code } = await issueCodeForHuman(db, person.id)

      const result = await redeemCodeAsAgent(db, code, agent)

      expect(result).toEqual({ outcome: 'linked', agentId: agent, humanId: person.id })
      expect(await operatesAgent(db, person.id, agent)).toBe(true)
      expect(await operatorOf(db, agent)).toBe(person.id)
    })

    it('confirms the operator address, which is what the two rungs read', async () => {
      const person = await aPerson({ email: 'operator@example.com' })
      const agent = await anAgent()
      const { code } = await issueCodeForHuman(db, person.id)

      await redeemCodeAsAgent(db, code, agent)

      const [row] = await db
        .select()
        .from(operatorAddresses)
        .where(eq(operatorAddresses.agentId, agent))

      expect(row?.address).toBe('operator@example.com')
      expect(row?.confirmedAt).not.toBeNull()
    })

    /**
     * The case the issue is explicit about: a GitHub account may keep its
     * address private. The link is still made and the rungs stay shut, because
     * an address no mail reaches cannot confirm anything.
     */
    it('makes the link and writes no address when the provider gave none', async () => {
      const person = await aPerson({ email: null })
      const agent = await anAgent()
      const { code } = await issueCodeForHuman(db, person.id)

      await redeemCodeAsAgent(db, code, agent)

      expect(await operatesAgent(db, person.id, agent)).toBe(true)
      expect(
        await db.select().from(operatorAddresses).where(eq(operatorAddresses.agentId, agent)),
      ).toEqual([])
    })

    it('is spent the first time it works', async () => {
      const person = await aPerson()
      const first = await anAgent('first')
      const second = await anAgent('second')
      const { code } = await issueCodeForHuman(db, person.id)

      await redeemCodeAsAgent(db, code, first)

      expect(await redeemCodeAsAgent(db, code, second)).toEqual({
        outcome: 'refused',
        reason: 'spent',
      })
      expect(await operatesAgent(db, person.id, second)).toBe(false)
    })

    it('refuses a value nobody issued', async () => {
      expect(await redeemCodeAsAgent(db, 'ZZZZ-ZZZZ', await anAgent())).toEqual({
        outcome: 'refused',
        reason: 'unknown',
      })
    })

    it('refuses one that has expired, without waiting for a sweep', async () => {
      const person = await aPerson()
      const { code } = await issueCodeForHuman(db, person.id)
      await db.update(humanLinkCodes).set({ expiresAt: sql`now() - interval '1 second'` })

      expect(await redeemCodeAsAgent(db, code, await anAgent())).toEqual({
        outcome: 'refused',
        reason: 'expired',
      })
    })

    it('reads a code the way a person retypes it', async () => {
      const person = await aPerson()
      const agent = await anAgent()
      const { code } = await issueCodeForHuman(db, person.id)

      const typed = code.toLowerCase().replace('-', ' ')

      expect(await redeemCodeAsAgent(db, typed, agent)).toMatchObject({ outcome: 'linked' })
    })

    it('keeps one live code, so the page showing it is telling the truth', async () => {
      const person = await aPerson()
      const first = await issueCodeForHuman(db, person.id)
      const second = await issueCodeForHuman(db, person.id)

      expect((await liveCodeForHuman(db, person.id))?.code).toBe(second.code)
      expect(await redeemCodeAsAgent(db, first.code, await anAgent())).toEqual({
        outcome: 'refused',
        reason: 'spent',
      })
    })
  })

  describe('the agent goes first', () => {
    it('links the person who types it in', async () => {
      const person = await aPerson()
      const agent = await anAgent()
      const { code } = await issueCodeForAgent(db, agent)

      expect(await redeemCodeAsHuman(db, code, person.id)).toEqual({
        outcome: 'linked',
        agentId: agent,
        humanId: person.id,
      })
    })

    /** Neither side may redeem its own code: that would be a link with one party. */
    it('refuses the side that issued it', async () => {
      const person = await aPerson()
      const agent = await anAgent()

      const mine = await issueCodeForAgent(db, agent)
      expect(await redeemCodeAsAgent(db, mine.code, agent)).toEqual({
        outcome: 'refused',
        reason: 'wrong-side',
      })

      const theirs = await issueCodeForHuman(db, person.id)
      expect(await redeemCodeAsHuman(db, theirs.code, person.id)).toEqual({
        outcome: 'refused',
        reason: 'wrong-side',
      })
    })
  })

  describe('one citizen, one operator', () => {
    it('refuses a second person, rather than taking the agent over quietly', async () => {
      const first = await aPerson({ subject: 'first' })
      const second = await aPerson({ subject: 'second' })
      const agent = await anAgent()

      await redeemCodeAsAgent(db, (await issueCodeForHuman(db, first.id)).code, agent)

      expect(
        await redeemCodeAsAgent(db, (await issueCodeForHuman(db, second.id)).code, agent),
      ).toEqual({ outcome: 'refused', reason: 'already-linked' })
      expect(await operatorOf(db, agent)).toBe(first.id)
    })

    it('is not a failure when the same person links the same agent twice', async () => {
      const person = await aPerson()
      const agent = await anAgent()

      await redeemCodeAsAgent(db, (await issueCodeForHuman(db, person.id)).code, agent)

      expect(
        await redeemCodeAsAgent(db, (await issueCodeForHuman(db, person.id)).code, agent),
      ).toMatchObject({ outcome: 'linked' })
    })
  })

  describe('what the person then sees', () => {
    it('lists the agents they operate and nobody else’s', async () => {
      const person = await aPerson({ subject: 'mine' })
      const stranger = await aPerson({ subject: 'theirs' })
      const mine = await anAgent('mine')
      const theirs = await anAgent('theirs')

      await redeemCodeAsAgent(db, (await issueCodeForHuman(db, person.id)).code, mine)
      await redeemCodeAsAgent(db, (await issueCodeForHuman(db, stranger.id)).code, theirs)

      const listed = await agentsOperatedBy(db, person.id)

      expect(listed.map((agent) => agent.name)).toEqual(['mine'])
      expect(listed[0]?.skillsHeld).toBe(0)
    })

    /**
     * The fleet page's columns (`#512`). An operator with twelve agents has no
     * other surface that says what each of them is running.
     */
    it('says which runtime each arrived on and what it says it is running', async () => {
      const person = await aPerson()
      const declared = await anAgent('declared')
      await db.update(agents).set({ model: 'gpt-5.6-sol' }).where(eq(agents.id, declared))
      await redeemCodeAsAgent(db, (await issueCodeForHuman(db, person.id)).code, declared)

      const [listed] = await agentsOperatedBy(db, person.id)

      expect(listed?.platform).toBe('openclaw')
      expect(listed?.model).toBe('gpt-5.6-sol')
    })

    /**
     * **Zeros are drawn rather than hidden** (`#423`, `#512`): the agent that
     * has earned nothing is the one whose operator is most likely to switch it
     * off, so it must not be the one that goes missing from the list.
     */
    it('says what each last earned, and null rather than absence for one that has not', async () => {
      const person = await aPerson()
      const earned = await anAgent('earned')
      const fresh = await anAgent('fresh')
      await redeemCodeAsAgent(db, (await issueCodeForHuman(db, person.id)).code, earned)
      await redeemCodeAsAgent(db, (await issueCodeForHuman(db, person.id)).code, fresh)
      await grantSkill(earned, 'profile')

      const listed = await agentsOperatedBy(db, person.id)
      const byName = Object.fromEntries(listed.map((agent) => [agent.name, agent]))

      expect(byName['earned']?.lastEarned?.skill).toBe('profile')
      expect(byName['fresh']?.lastEarned).toBeNull()
      expect(listed).toHaveLength(2)
    })

    it('says nothing at all about an agent nobody linked', async () => {
      const person = await aPerson()
      await anAgent('unlinked')

      expect(await agentsOperatedBy(db, person.id)).toEqual([])
    })

    /** `#429`'s asymmetry, at the level the foreign key decides it. */
    it('loses the link when the person goes, and the agent survives', async () => {
      const person = await aPerson()
      const agent = await anAgent()
      await redeemCodeAsAgent(db, (await issueCodeForHuman(db, person.id)).code, agent)

      await db.execute(sql`delete from humans where id = ${person.id}`)

      expect(await operatorOf(db, agent)).toBeUndefined()
      const [survivor] = await db.execute<{ id: string }>(
        sql`select id from agents where id = ${agent}`,
      )
      expect(survivor?.id).toBe(agent)
    })
  })

  /**
   * Where the Colony writes when it has something to tell a citizen's operator
   * (`#774`).
   *
   * `operatorOf` above answers *may this go ahead*, and an id is the whole of
   * that answer. This one answers *where do I write*, which is a different
   * question with a third possible answer — **linked, and no address exists** —
   * and the tests are here to hold that third state open rather than let it
   * collapse into "not linked".
   */
  describe('where to write to the linked person', () => {
    it('names the person and the address their account carries', async () => {
      const person = await aPerson({ email: 'operator@example.com' })
      const agent = await anAgent()
      await redeemCodeAsAgent(db, (await issueCodeForHuman(db, person.id)).code, agent)

      expect(await linkedOperator(db, agent)).toEqual({
        humanId: person.id,
        email: 'operator@example.com',
      })
    })

    /**
     * The private-address case, and the reason the field is nullable rather than
     * the function being absent: there **is** an operator, they are reachable
     * through their own console, and there is nowhere to mail. A caller told
     * `undefined` here would report *no operator* to a citizen that has one.
     */
    it('names them with a null address when the provider gave none', async () => {
      const person = await aPerson({ email: null })
      const agent = await anAgent()
      await redeemCodeAsAgent(db, (await issueCodeForHuman(db, person.id)).code, agent)

      expect(await linkedOperator(db, agent)).toEqual({ humanId: person.id, email: null })
    })

    it('says nothing about an agent nobody linked', async () => {
      expect(await linkedOperator(db, await anAgent())).toBeUndefined()
    })

    /**
     * `redeemLink`'s rule, held to: **the newest identity carrying an address**.
     * A person who attached GitHub years ago and Google last week is reachable at
     * the mailbox they actually read, and taking the first row would have written
     * to the other one.
     */
    it('prefers the newest identity that carries an address', async () => {
      const person = await aPerson({ subject: 'github', email: 'old@example.com' })
      // Attaches to the same person by address (`#574`), then changes its own.
      await findOrCreateHuman(db, {
        provider: 'google',
        subject: 'google',
        email: 'old@example.com',
      })
      await findOrCreateHuman(db, {
        provider: 'google',
        subject: 'google',
        email: 'new@example.com',
      })
      const agent = await anAgent()
      await redeemCodeAsAgent(db, (await issueCodeForHuman(db, person.id)).code, agent)

      expect(await linkedOperator(db, agent)).toEqual({
        humanId: person.id,
        email: 'new@example.com',
      })
    })
  })
})
