import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { CONSOLE_SESSION_TTL_MS, EMAIL_LINK_TTL_MS, type AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { accounts, agents, credentials, emailChallenges } from '../schema/index.js'
import {
  redeemSignInLink,
  registerWebIdentity,
  requestSignInLink,
  resolveSignInAddress,
  revokeSession,
} from './sign-in.js'
import { authenticateSession } from './authentication.js'
import { registerAgent } from './agents.js'

const target = databaseTestTarget()

describe('browser sign-in', () => {
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

  /** An MCP citizen with a proved reach address, which is what D-047 calls one. */
  const citizenReachableAt = async (name: string, address: string): Promise<AgentId> => {
    const registered = await registerAgent(db, { name, platform: 'openclaw', operator: null })
    if (registered.outcome !== 'registered') throw new Error(registered.outcome)

    await db.insert(emailChallenges).values({
      agentId: registered.agent.id,
      address,
      purpose: 'inbox',
      token: `t${Math.random().toString(16).slice(2, 14)}`,
      code: '123456',
      sentAt: sql`now()`,
      verifiedAt: sql`now()`,
      primaryAt: sql`now()`,
      expiresAt: sql`now() + interval '1 day'`,
    })

    return registered.agent.id
  }

  describe('resolving an address', () => {
    it('finds the citizen whose reach address it is', async () => {
      const agentId = await citizenReachableAt('reachable', 'reach@example.org')

      const resolved = await resolveSignInAddress(db, 'reach@example.org')

      expect(resolved?.agentId).toBe(agentId)
    })

    it('answers nothing for an address nobody holds', async () => {
      expect(await resolveSignInAddress(db, 'stranger@example.org')).toBeUndefined()
    })

    /**
     * The reach address is the *primary* one. A second proved mailbox is a
     * mailbox the citizen holds and not a place the Colony writes to, so a
     * sign-in link must not go there — D-047's whole point.
     */
    it('ignores a proved mailbox that is not the reach address', async () => {
      const agentId = await citizenReachableAt('two-boxes', 'primary@example.org')

      await db.insert(emailChallenges).values({
        agentId,
        address: 'secondary@example.org',
        purpose: 'inbox',
        token: 'tsecondary0001',
        code: '654321',
        sentAt: sql`now()`,
        verifiedAt: sql`now()`,
        expiresAt: sql`now() + interval '1 day'`,
      })

      expect(await resolveSignInAddress(db, 'secondary@example.org')).toBeUndefined()
    })

    it('finds a web identity by the address it signed up with', async () => {
      const created = await registerWebIdentity(db, {
        name: 'sponsor-one',
        address: 'sponsor@example.org',
      })
      if (created.outcome !== 'registered') throw new Error(created.outcome)

      const resolved = await resolveSignInAddress(db, 'sponsor@example.org')

      expect(resolved?.agentId).toBe(created.identity.agentId)
    })

    /**
     * The address is compared as a mailbox, not as a string, which is what
     * `mailboxIdentity` is for — otherwise a caller could ask for a link to
     * `Reach@example.org` and be told the address is unknown.
     */
    it('compares case-insensitively and through plus-addressing', async () => {
      await citizenReachableAt('folded', 'reach@example.org')

      expect(await resolveSignInAddress(db, 'REACH@Example.ORG')).toBeDefined()
      expect(await resolveSignInAddress(db, 'reach+console@example.org')).toBeDefined()
    })
  })

  describe('requesting a link', () => {
    it('returns the stored address rather than anything a caller supplied', async () => {
      const agentId = await citizenReachableAt('stored', 'reach@example.org')

      const link = await requestSignInLink(db, { agentId, address: 'reach@example.org' })

      expect(link.address).toBe('reach@example.org')
    })

    it('stores a hash and never the token', async () => {
      const agentId = await citizenReachableAt('hashed', 'reach@example.org')

      const link = await requestSignInLink(db, { agentId, address: 'reach@example.org' })

      const [row] = await db
        .select({ secretHash: credentials.secretHash })
        .from(credentials)
        .where(and(eq(credentials.agentId, agentId), eq(credentials.kind, 'email-link')))

      expect(row?.secretHash).not.toBe(link.token)
      expect(row?.secretHash).toMatch(/^[0-9a-f]{64}$/)
    })

    /** A user who clicks "send it again" leaves one key in its mailbox, not two. */
    it('invalidates the previous link', async () => {
      const agentId = await citizenReachableAt('resend', 'reach@example.org')

      const first = await requestSignInLink(db, { agentId, address: 'reach@example.org' })
      await requestSignInLink(db, { agentId, address: 'reach@example.org' })

      expect((await redeemSignInLink(db, first.token)).outcome).toBe('refused')
    })

    it('expires fifteen minutes out', async () => {
      const agentId = await citizenReachableAt('timed', 'reach@example.org')
      const now = new Date('2026-08-02T12:00:00.000Z')

      const link = await requestSignInLink(db, { agentId, address: 'reach@example.org' }, now)

      expect(Date.parse(link.expiresAt) - now.getTime()).toBe(EMAIL_LINK_TTL_MS)
    })
  })

  describe('redeeming a link', () => {
    it('exchanges a live token for a session', async () => {
      const agentId = await citizenReachableAt('redeemer', 'reach@example.org')
      const link = await requestSignInLink(db, { agentId, address: 'reach@example.org' })

      const redeemed = await redeemSignInLink(db, link.token)

      expect(redeemed.outcome).toBe('signed-in')
      if (redeemed.outcome !== 'signed-in') return
      expect(redeemed.agentId).toBe(agentId)
    })

    it('refuses the same token a second time', async () => {
      const agentId = await citizenReachableAt('once', 'reach@example.org')
      const link = await requestSignInLink(db, { agentId, address: 'reach@example.org' })

      expect((await redeemSignInLink(db, link.token)).outcome).toBe('signed-in')
      expect((await redeemSignInLink(db, link.token)).outcome).toBe('refused')
    })

    /** The boundary, not a comfortable distance from it. */
    it('refuses a token one millisecond past its expiry and accepts one before', async () => {
      const agentId = await citizenReachableAt('boundary', 'reach@example.org')
      const minted = new Date('2026-08-02T12:00:00.000Z')

      const early = await requestSignInLink(db, { agentId, address: 'reach@example.org' }, minted)
      const justInside = new Date(minted.getTime() + EMAIL_LINK_TTL_MS - 1)
      expect((await redeemSignInLink(db, early.token, justInside)).outcome).toBe('signed-in')

      const late = await requestSignInLink(db, { agentId, address: 'reach@example.org' }, minted)
      const justOutside = new Date(minted.getTime() + EMAIL_LINK_TTL_MS + 1)
      expect((await redeemSignInLink(db, late.token, justOutside)).outcome).toBe('refused')
    })

    it('refuses a token nobody ever minted', async () => {
      expect((await redeemSignInLink(db, 'not-a-token')).outcome).toBe('refused')
    })

    it('proves a web identity’s sign-up address on the first link it follows', async () => {
      const created = await registerWebIdentity(db, {
        name: 'first-link',
        address: 'sponsor@example.org',
      })
      if (created.outcome !== 'registered') throw new Error(created.outcome)

      const link = await requestSignInLink(db, created.identity)
      await redeemSignInLink(db, link.token)

      const [row] = await db
        .select({ proved: accounts.proved, capabilities: accounts.capabilities })
        .from(accounts)
        .where(eq(accounts.agentId, created.identity.agentId))

      expect(row?.proved).toBe(true)
      // Reachability is not the rung. Nothing here grants `mailbox`.
      expect(row?.capabilities).toEqual([])
    })

    /**
     * `#153` records that the email challenge cap counts a citizen's whole life.
     * A sponsor signing in must not spend that budget.
     */
    it('books nothing against the email challenge budget', async () => {
      const agentId = await citizenReachableAt('budget', 'reach@example.org')

      const before = await db
        .select({ count: sql<string>`count(*)::text` })
        .from(emailChallenges)
        .where(eq(emailChallenges.agentId, agentId))

      for (let i = 0; i < 12; i += 1) {
        const link = await requestSignInLink(db, { agentId, address: 'reach@example.org' })
        await redeemSignInLink(db, link.token)
      }

      const after = await db
        .select({ count: sql<string>`count(*)::text` })
        .from(emailChallenges)
        .where(eq(emailChallenges.agentId, agentId))

      expect(after[0]?.count).toBe(before[0]?.count)
    })
  })

  describe('the session it produces', () => {
    it('authenticates as the same identity an API key would', async () => {
      const agentId = await citizenReachableAt('same-identity', 'reach@example.org')
      const link = await requestSignInLink(db, { agentId, address: 'reach@example.org' })
      const redeemed = await redeemSignInLink(db, link.token)
      if (redeemed.outcome !== 'signed-in') throw new Error('expected a session')

      const authenticated = await authenticateSession(db, redeemed.session)

      expect(authenticated.outcome).toBe('authenticated')
      if (authenticated.outcome !== 'authenticated') return
      expect(authenticated.agent.id).toBe(agentId)
    })

    it('stops authenticating once revoked', async () => {
      const agentId = await citizenReachableAt('revoked', 'reach@example.org')
      const link = await requestSignInLink(db, { agentId, address: 'reach@example.org' })
      const redeemed = await redeemSignInLink(db, link.token)
      if (redeemed.outcome !== 'signed-in') throw new Error('expected a session')

      await revokeSession(db, agentId, redeemed.credentialId)

      expect((await authenticateSession(db, redeemed.session)).outcome).toBe('revoked')
    })

    it('stops authenticating once its absolute expiry has passed', async () => {
      const agentId = await citizenReachableAt('expiring', 'reach@example.org')
      const link = await requestSignInLink(db, { agentId, address: 'reach@example.org' })
      const redeemed = await redeemSignInLink(db, link.token)
      if (redeemed.outcome !== 'signed-in') throw new Error('expected a session')

      // Reach past the expiry rather than waiting twelve hours for it.
      await db
        .update(credentials)
        .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
        .where(eq(credentials.id, redeemed.credentialId))

      expect((await authenticateSession(db, redeemed.session)).outcome).toBe('expired')
    })

    it('lasts the absolute session lifetime and no longer', async () => {
      const agentId = await citizenReachableAt('twelve-hours', 'reach@example.org')
      const now = new Date('2026-08-02T12:00:00.000Z')
      const link = await requestSignInLink(db, { agentId, address: 'reach@example.org' }, now)
      const redeemed = await redeemSignInLink(db, link.token, now)
      if (redeemed.outcome !== 'signed-in') throw new Error('expected a session')

      expect(Date.parse(redeemed.expiresAt) - now.getTime()).toBe(CONSOLE_SESSION_TTL_MS)
    })

    it('is listed with the identity’s other credentials', async () => {
      const agentId = await citizenReachableAt('listed', 'reach@example.org')
      const link = await requestSignInLink(db, { agentId, address: 'reach@example.org' })
      await redeemSignInLink(db, link.token)

      const rows = await db
        .select({ kind: credentials.kind })
        .from(credentials)
        .where(eq(credentials.agentId, agentId))

      expect(rows.map((row) => row.kind).sort()).toEqual([
        'api-key',
        'console-session',
        'email-link',
      ])
    })
  })

  describe('signing up from the console', () => {
    it('creates an identity holding nothing', async () => {
      const created = await registerWebIdentity(db, {
        name: 'thin-account',
        address: 'thin@example.org',
      })
      if (created.outcome !== 'registered') throw new Error(created.outcome)

      const [row] = await db
        .select({
          status: agents.status,
          roles: agents.roles,
          registrationPath: agents.registrationPath,
          platform: agents.platform,
        })
        .from(agents)
        .where(eq(agents.id, created.identity.agentId))

      expect(row?.status).toBe('candidate')
      expect(row?.roles).toEqual([])
      expect(row?.registrationPath).toBe('web')
      expect(row?.platform).toBe('other')
    })

    /** No bearer credential exists before anybody has proved they can read the mail. */
    it('issues no API key', async () => {
      const created = await registerWebIdentity(db, {
        name: 'no-key',
        address: 'nokey@example.org',
      })
      if (created.outcome !== 'registered') throw new Error(created.outcome)

      const rows = await db
        .select({ kind: credentials.kind })
        .from(credentials)
        .where(eq(credentials.agentId, created.identity.agentId))

      expect(rows).toEqual([])
    })

    it('refuses an address that already names a citizen', async () => {
      await citizenReachableAt('already-here', 'taken@example.org')

      const created = await registerWebIdentity(db, {
        name: 'second-comer',
        address: 'taken@example.org',
      })

      expect(created.outcome).toBe('address-taken')
    })

    it('refuses an address that already names a web identity', async () => {
      await registerWebIdentity(db, { name: 'first-web', address: 'once@example.org' })

      const second = await registerWebIdentity(db, {
        name: 'second-web',
        address: 'once@example.org',
      })

      expect(second.outcome).toBe('address-taken')
    })

    it('reports a taken name as a taken name', async () => {
      await registerAgent(db, { name: 'collision', platform: 'openclaw', operator: null })

      const created = await registerWebIdentity(db, {
        name: 'collision',
        address: 'fresh@example.org',
      })

      expect(created).toEqual({ outcome: 'name-taken', name: 'collision' })
    })
  })

  describe('what registration path records', () => {
    it('says `mcp` for an agent that came through the front door', async () => {
      const registered = await registerAgent(db, {
        name: 'over-mcp',
        platform: 'openclaw',
        operator: null,
      })
      if (registered.outcome !== 'registered') throw new Error(registered.outcome)

      const [row] = await db
        .select({ registrationPath: agents.registrationPath })
        .from(agents)
        .where(eq(agents.id, registered.agent.id))

      expect(row?.registrationPath).toBe('mcp')
    })
  })
})
