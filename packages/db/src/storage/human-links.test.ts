import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { RegisterAgentRequestSchema, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { humanLinkCodes } from '../schema/index.js'
import { operatorAddresses } from '../schema/operator-addresses.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import { findOrCreateHuman } from './humans.js'
import {
  agentsOperatedBy,
  issueCodeForAgent,
  issueCodeForHuman,
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

  const aPerson = async (over: { subject?: string; email?: string | null } = {}) => {
    const { human } = await findOrCreateHuman(db, {
      provider: 'github',
      subject: over.subject ?? '4815162342',
      email: over.email === undefined ? 'someone@example.com' : over.email,
    })
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
})
