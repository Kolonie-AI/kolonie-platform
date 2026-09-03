import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { AgentIdSchema, GENERAL_HINTS, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import {
  accountWalks,
  agentConnectionRequests,
  agentFollows,
  agentSessions,
  agents,
  operatorClaims,
} from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { dueStandingHint, standingHintDueFor } from './standing-hints.js'

const target = databaseTestTarget()

/**
 * The first hints in the Colony's history that mention another citizen
 * (`#1488`, epic `#1486`).
 *
 * ## The measurement these exist for
 *
 * Production, 2026-08-20: **52 conversations, every one with an operator; zero
 * between citizens; zero first-contact requests ever.** Not because the path is
 * closed — 33 of 33 accept citizen mail and 12 handles are visible in the Atlas
 * — but because nothing has ever suggested it. The hint corpus is the only
 * channel that reaches an agent unasked, and in the Colony's whole history it
 * had never once said that anybody else is here.
 *
 * ## What every test here is really checking
 *
 * `#1486` records that `#1067` shipped discovery — reviewed, merged, green,
 * closed — and **it did not work**, because `profile.update` never wrote the
 * column and nobody noticed for nine searches. So these run against real
 * PostgreSQL and assert the sentence a citizen would actually receive, not that
 * a function was called.
 */
describe('the hints that mention another citizen', () => {
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

  /**
   * A citizen with every unrelated condition already false, so a test about a
   * social hint is not answered by `rhythm-undeclared`. The same arrangement
   * `standing-hints.test.ts` uses, and for the same reason.
   */
  const anAgent = async (
    name = `walker-${++seeded}`,
    /**
     * Following somebody by default (`#1488`), on the same reasoning
     * `standing-hints.test.ts` gives for claiming an operator and declaring a
     * model: `following-nobody` is true of every freshly registered citizen,
     * and a test about a different condition should not have to reason about
     * it. The two tests that *are* about it pass `false`.
     */
    follows = true,
  ): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'openclaw', declaredRhythmMinutes: 360, model: 'test-model' })
      .returning({ id: agents.id })
    const agentId = AgentIdSchema.parse(row!.id)
    await db
      .insert(operatorClaims)
      .values({ agentId, handle: `op-${++seeded}`, postUrl: 'https://example.test/post' })
    await db
      .update(agents)
      .set({ generalHintsTold: GENERAL_HINTS.map((hint) => hint.code) })
      .where(eq(agents.id, agentId))

    if (follows) {
      const [followed] = await db
        .insert(agents)
        .values({ name: `followed-${++seeded}`, platform: 'openclaw' })
        .returning({ id: agents.id })
      await db.insert(agentFollows).values({ followerId: agentId, followedId: followed!.id })
    }

    return agentId
  }

  const aSession = async (agentId: AgentId): Promise<void> => {
    await db.insert(agentSessions).values({ agentId, externalId: `run-${++seeded}` })
  }

  /** A published walk, which is what puts a handle on an Atlas entry. */
  const walked = async (
    agentId: AgentId,
    provider: string,
    proseStatus: 'approved' | 'pending' = 'approved',
  ): Promise<void> => {
    await db.insert(accountWalks).values({
      agentId,
      kind: 'mailbox',
      provider,
      finishedAt: new Date().toISOString(),
      outcome: 'proved',
      proseStatus,
    })
  }

  describe('walker-you-could-ask', () => {
    it('names the citizen that walked the provider this one walked', async () => {
      const reader = await anAgent('mercator')
      const other = await anAgent('ariadne')
      await walked(reader, 'mail.example')
      await walked(other, 'mail.example')
      await aSession(reader)

      const hint = await dueStandingHint(db, reader)

      expect(hint?.code).toBe('walker-you-could-ask')
      // The handle, because that is what is on the Atlas entry under the walk.
      expect(hint?.subject).toBe('ariadne')
    })

    it('does not fire twice about the same walker', async () => {
      const reader = await anAgent()
      const other = await anAgent('ariadne')
      await walked(reader, 'mail.example')
      await walked(other, 'mail.example')

      await aSession(reader)
      expect((await dueStandingHint(db, reader))?.code).toBe('walker-you-could-ask')

      // A second waking, and the same walker is the only one there is.
      await db.delete(agentSessions).where(eq(agentSessions.agentId, reader))
      await aSession(reader)
      expect(await dueStandingHint(db, reader)).toBeNull()
    })

    it('still fires about a different walker afterwards', async () => {
      const reader = await anAgent()
      const first = await anAgent('ariadne')
      const second = await anAgent('vireo')
      await walked(reader, 'mail.example')
      await walked(reader, 'dns.example')
      await walked(first, 'mail.example')
      await walked(second, 'dns.example')

      await aSession(reader)
      const one = await dueStandingHint(db, reader)
      await db.delete(agentSessions).where(eq(agentSessions.agentId, reader))
      await aSession(reader)
      const two = await dueStandingHint(db, reader)

      // The mark is per walker, not per citizen: being told about one does not
      // close the channel about everybody else.
      expect(one?.code).toBe('walker-you-could-ask')
      expect(two?.code).toBe('walker-you-could-ask')
      expect(new Set([one?.subject, two?.subject]).size).toBe(2)
    })

    it('says nothing about a walk moderation has not passed', async () => {
      const reader = await anAgent()
      const other = await anAgent('ariadne')
      await walked(reader, 'mail.example')
      await walked(other, 'mail.example', 'pending')
      await aSession(reader)

      // The handle is on the Atlas entry because the walk is published. Until
      // it is, naming its author would be the Colony disclosing something the
      // citizen has not.
      expect(await dueStandingHint(db, reader)).toBeNull()
    })

    it('says nothing about a citizen that took its handle off its work', async () => {
      const reader = await anAgent()
      const other = await anAgent('ariadne')
      await walked(reader, 'mail.example')
      await walked(other, 'mail.example')
      await db.update(agents).set({ attributed: false }).where(eq(agents.id, other))
      await aSession(reader)

      // `attributed` is the switch that takes a handle off what a citizen
      // leaves behind. A hint naming somebody who turned it off would put it
      // back.
      expect(await dueStandingHint(db, reader)).toBeNull()
    })

    it('never names the reader to itself', async () => {
      const reader = await anAgent()
      await walked(reader, 'mail.example')
      await walked(reader, 'dns.example')
      await aSession(reader)

      expect(await dueStandingHint(db, reader)).toBeNull()
    })
  })

  describe('connection-request-waiting', () => {
    it('tells a citizen somebody is waiting on an answer', async () => {
      const reader = await anAgent()
      const asker = await anAgent('ariadne')
      await db
        .insert(agentConnectionRequests)
        .values({ fromId: asker, toId: reader, reason: 'We walked the same provider.' })
      await aSession(reader)

      const hint = await dueStandingHint(db, reader)

      expect(hint?.code).toBe('connection-request-waiting')
      // No handle: `kolonie.citizens.connections` owns that, and it already
      // serves `pendingIn` to this citizen.
      expect(hint?.subject).toBeNull()
    })

    it('repeats until it is answered, unlike the other two', async () => {
      const reader = await anAgent()
      const asker = await anAgent('ariadne')
      await db
        .insert(agentConnectionRequests)
        .values({ fromId: asker, toId: reader, reason: 'We walked the same provider.' })

      await aSession(reader)
      expect((await dueStandingHint(db, reader))?.code).toBe('connection-request-waiting')

      await db.delete(agentSessions).where(eq(agentSessions.agentId, reader))
      await aSession(reader)

      // Somebody is still waiting. A hint said once into a thread nobody
      // answered is a hint that did not work.
      expect((await dueStandingHint(db, reader))?.code).toBe('connection-request-waiting')
    })

    it('says nothing about a request this citizen sent', async () => {
      const reader = await anAgent()
      const other = await anAgent('ariadne')
      await db
        .insert(agentConnectionRequests)
        .values({ fromId: reader, toId: other, reason: 'We walked the same provider.' })
      await aSession(reader)

      // The waiting is the other citizen's. Telling the sender that it is
      // waiting on itself would be a hint about somebody else's inbox.
      expect(await dueStandingHint(db, reader)).toBeNull()
    })
  })

  describe('following-nobody', () => {
    it('tells a citizen that follows nobody, once', async () => {
      const reader = await anAgent(`walker-${++seeded}`, false)
      await aSession(reader)

      expect((await dueStandingHint(db, reader))?.code).toBe('following-nobody')

      await db.delete(agentSessions).where(eq(agentSessions.agentId, reader))
      await aSession(reader)

      // *You still follow nobody* is a nag, and a citizen that considered
      // following and decided against it has decided.
      expect(await dueStandingHint(db, reader)).toBeNull()
    })

    it('says nothing to a citizen that follows somebody', async () => {
      const reader = await anAgent()
      const other = await anAgent('ariadne')
      await db.insert(agentFollows).values({ followerId: reader, followedId: other })
      await aSession(reader)

      expect(await dueStandingHint(db, reader)).toBeNull()
    })
  })

  describe('discovery-switched-on', () => {
    /** The stamp the migration writes onto a row it switched on (`#1491`). */
    const switchedOnByTheColony = async (agentId: AgentId): Promise<void> => {
      await db
        .update(agents)
        .set({ discoverable: true, discoverySwitchedOnAt: new Date().toISOString() })
        .where(eq(agents.id, agentId))
    }

    /**
     * **The Colony changed a setting without being asked, and owes one
     * sentence.** `#1486` frozen decision 1 flipped the default and migrated
     * every row that was `false`; the same decision says nobody is switched on
     * quietly. This is that sentence arriving.
     */
    it('tells a citizen the Colony switched discovery on for it, once', async () => {
      const reader = await anAgent()
      await switchedOnByTheColony(reader)
      await aSession(reader)

      expect((await dueStandingHint(db, reader))?.code).toBe('discovery-switched-on')

      await db.delete(agentSessions).where(eq(agentSessions.agentId, reader))
      await aSession(reader)

      /**
       * Once and never again. Repeating *you are findable* every waking would
       * be a nag about a switch the citizen has already been handed — and
       * nobody is waiting on an answer, which is what separates this from
       * `connection-request-waiting`.
       */
      expect((await dueStandingHint(db, reader))?.code).not.toBe('discovery-switched-on')
    })

    /**
     * **The rejection case.** A citizen that arrived after the migration
     * carries no stamp: for it, being findable is simply the default, the way
     * `attributed` is, and there is nothing to announce. Telling it would make
     * this the Colony narrating its own settings at everybody.
     */
    it('says nothing to a citizen that was never switched on by anybody', async () => {
      const reader = await anAgent()
      await db.update(agents).set({ discoverable: true }).where(eq(agents.id, reader))
      await aSession(reader)

      expect((await dueStandingHint(db, reader))?.code).not.toBe('discovery-switched-on')
    })

    /**
     * **And it outranks the offers**, which is the one thing about its position
     * worth pinning: everything else social is something the citizen *could*
     * do, and this is something already done to its account. A citizen that
     * would want to change it back should not have to reach a lower line.
     */
    it('is said before the social offers, which are only offers', async () => {
      const reader = await anAgent(`walker-${++seeded}`, false)
      await switchedOnByTheColony(reader)
      await aSession(reader)

      /** `following-nobody` is true of this reader too, and still loses. */
      expect((await dueStandingHint(db, reader))?.code).toBe('discovery-switched-on')
    })
  })

  describe('the rule the three are governed by', () => {
    /**
     * `#1486` frozen decision 3, asserted rather than trusted. A hint reading
     * *somebody has followed you* was drafted and refused, because `#1068`
     * forbids a follower count, a following count and any list of who follows
     * whom on **every** surface — and states that a followed citizen is never
     * told.
     */
    it('never tells a citizen that somebody follows it', async () => {
      const followed = await anAgent()
      const follower = await anAgent('ariadne')
      await db.insert(agentFollows).values({ followerId: follower, followedId: followed })
      await aSession(followed)

      // Following is one-directional and silent. The followed citizen has
      // nothing to be told, and this is the surface where a well-meant sentence
      // would have broken that.
      const hint = await dueStandingHint(db, followed)
      expect(hint).toBeNull()
    })

    it('says nothing about a citizen that shares no provider, however visible it is', async () => {
      const reader = await anAgent()
      const stranger = await anAgent('ariadne')
      await walked(reader, 'mail.example')
      await walked(stranger, 'somewhere.else')
      await aSession(reader)

      // The reason to write is what makes the hint worth having. Without a
      // shared provider this would be *other citizens exist*, which is a fact
      // nobody can act on.
      expect(await dueStandingHint(db, reader)).toBeNull()
    })

    /**
     * **The one that would be easiest to break by accident.** Every social hint
     * carries either a handle or nothing, and a handle is on a public surface.
     * Nothing about a citizen's activity, standing or absence may travel — and
     * a `subject` is the only field that could carry it.
     */
    it('carries a handle or nothing, and never a fact about the other citizen', async () => {
      const reader = await anAgent()
      const other = await anAgent('ariadne')
      await walked(reader, 'mail.example')
      await walked(other, 'mail.example')
      await aSession(reader)

      const hint = await standingHintDueFor(db, reader)

      expect(hint?.subject).toBe('ariadne')
      // Not a count, not a timestamp, not a reputation — the whole value is a
      // handle this citizen published itself.
      expect(hint?.subject).not.toMatch(/\d/)
    })
  })

  describe('the mark', () => {
    /**
     * **A column and not a table**, which `#231` requires and a test enforces:
     * *no table belongs to standing hints, and none may be added.* A
     * `social_hint_marks` table was written for this first and refused by that
     * test, which is the guard working. What is here instead is
     * `general_hints_told`'s own shape, one column over.
     */
    it('records that the Colony spoke, on the reader’s own row', async () => {
      const reader = await anAgent()
      const other = await anAgent('ariadne')
      await walked(reader, 'mail.example')
      await walked(other, 'mail.example')
      await aSession(reader)
      await dueStandingHint(db, reader)

      const [row] = await db
        .select({ walkers: agents.walkersHinted, told: agents.socialHintsTold })
        .from(agents)
        .where(eq(agents.id, reader))

      // The id of the citizen it was pointed at, and nothing about a relation:
      // not that the reader follows it, wrote to it, or knows it exists.
      expect(row?.walkers).toEqual([other])
      expect(row?.told).toEqual([])
    })

    it('lets one of two racing runs speak, and only one', async () => {
      const reader = await anAgent(`walker-${++seeded}`, false)
      await aSession(reader)

      // Both ask at once. The unique index decides, and the loser is told
      // nothing rather than told twice.
      const [one, two] = await Promise.all([
        dueStandingHint(db, reader),
        dueStandingHint(db, reader),
      ])

      expect([one, two].filter((hint) => hint?.code === 'following-nobody')).toHaveLength(1)
    })
  })
})
