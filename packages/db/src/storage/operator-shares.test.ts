import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { AgentIdSchema, HumanIdSchema, type AgentId, type HumanId } from '@kolonie-ai/core'
import { generateApiKey } from '../api-key.js'
import type { Database } from '../client.js'
import { agents, humanAgents, humans, operatorPages, vaultShares } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { setVaultEntry } from './vault.js'
import {
  handBackShare,
  recordShareRead,
  sharesForOperator,
  sharesForPageToken,
  shareVaultEntry,
  unshareVaultEntry,
  vaultSharesWakeupDelta,
  writeShareAddition,
} from './vault-shares.js'

const target = databaseTestTarget()

/**
 * The operator's half of a shared entry (`#1440`, epic `#1437`).
 *
 * **The property under test is the reversal.** Drops and handovers held to *a
 * secret only in a signed-in console, never through the mailed link*, and over
 * their whole lifetime 0 of 42 handovers were read and 0 of 7 drops were filled.
 * `#1437` frozen decision 1 overturns that rule; these tests assert that the
 * durable page really can read a value, that a revoked page really cannot, and
 * that the count which made the old channels undebuggable now exists.
 */
describe('what an operator can do with a shared entry', () => {
  let db: Database
  let agentId: AgentId
  let humanId: HumanId
  let token: string
  let pageToken: string
  let seeded = 0

  const sealingKey = 'a-colony-sealing-key-long-enough-to-be-usable'

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db.$client.end()
  })

  beforeEach(async () => {
    await truncateAll(db)
    token = String(generateApiKey())
    pageToken = `page-token-${++seeded}`

    const [agent] = await db
      .insert(agents)
      .values({ name: `keeper-${seeded}`, platform: 'openclaw' })
      .returning({ id: agents.id })
    agentId = AgentIdSchema.parse(agent!.id)

    const [person] = await db.insert(humans).values({}).returning({ id: humans.id })
    humanId = HumanIdSchema.parse(person!.id)
    await db.insert(humanAgents).values({ agentId, humanId })

    await db
      .insert(operatorPages)
      .values({ agentId, operatorAddress: `operator-${seeded}@example.test`, token: pageToken })
  })

  const share = async (key = 'github/octocat', value = 'hunter2') => {
    await setVaultEntry(db, token, agentId, key, value, 'the login')
    const shared = await shareVaultEntry(db, {
      token,
      agentId,
      key,
      purpose: 'put a card on the GitHub account',
      sealingKey,
    })
    if (shared.outcome !== 'shared') throw new Error(shared.outcome)
    return shared.shareId
  }

  it('lets the durable page read the value, purpose and expiry', async () => {
    await share()

    const [seen] = await sharesForPageToken(db, pageToken, sealingKey)

    // The reversal, in one assertion: the mailed link carries the secret.
    expect(seen).toMatchObject({
      vaultKey: 'github/octocat',
      purpose: 'put a card on the GitHub account',
      value: 'hunter2',
      description: 'the login',
      wrote: false,
    })
  })

  it('shows a signed-in operator the same thing', async () => {
    await share()

    const [console_] = await sharesForOperator(db, humanId, sealingKey)

    expect(console_?.value).toBe('hunter2')
  })

  it('reaches nothing through a revoked page', async () => {
    await share()
    await db
      .update(operatorPages)
      .set({ revokedAt: sql`now()` })
      .where(eq(operatorPages.agentId, agentId))

    // `kolonie.operator.page.revoke` closes this door in the same instant it
    // closes the rest of the page — which is the citizen's way out of the cost
    // the non-expiring link carries.
    expect(await sharesForPageToken(db, pageToken, sealingKey)).toEqual([])
  })

  it('never shows an entry that is not currently shared', async () => {
    await setVaultEntry(db, token, agentId, 'mail/citizen', 'hunter3')
    await setVaultEntry(db, token, agentId, 'wallet/seed', 'hunter4')
    await share('github/octocat')

    const seen = await sharesForPageToken(db, pageToken, sealingKey)

    expect(seen.map((row) => row.vaultKey)).toEqual(['github/octocat'])
    expect(JSON.stringify(seen)).not.toContain('hunter3')
    expect(JSON.stringify(seen)).not.toContain('hunter4')
  })

  it('counts a read, and the citizen can see the count', async () => {
    const shareId = await share()

    // The number whose absence made the old channels impossible to debug.
    expect(await recordShareRead(db, shareId)).toBe(true)
    expect(await recordShareRead(db, shareId)).toBe(true)

    const [row] = await db.select().from(vaultShares).where(eq(vaultShares.agentId, agentId))
    expect(row?.reads).toBe(2)
    expect(row?.lastReadAt).not.toBeNull()

    const collected = await unshareVaultEntry(db, agentId, 'github/octocat', sealingKey)
    expect(collected).toMatchObject({ outcome: 'unshared', reads: 2 })
  })

  it('carries what the operator wrote back to the citizen, once', async () => {
    const shareId = await share()

    expect(
      await writeShareAddition(db, { pageToken }, shareId, 'billing PIN 4417', sealingKey),
    ).toEqual({ outcome: 'written' })

    // A second write replaces the first: an operator that mistyped has one way
    // to correct it and it is the box in front of them.
    await writeShareAddition(db, { pageToken }, shareId, 'billing PIN 9911', sealingKey)

    const collected = await unshareVaultEntry(db, agentId, 'github/octocat', sealingKey)
    expect(collected).toMatchObject({ operatorAddition: 'billing PIN 9911' })
  })

  it('lets the operator hand it back, and the citizen still collects what they wrote', async () => {
    const shareId = await share()
    await writeShareAddition(db, { humanId }, shareId, 'billing PIN 4417', sealingKey)

    expect(await handBackShare(db, { humanId }, shareId)).toEqual({ outcome: 'handed-back' })

    // Gone from the operator's side immediately.
    expect(await sharesForPageToken(db, pageToken, sealingKey)).toEqual([])

    // And the citizen is told *they* ended it, which is a different fact from
    // having closed it itself — and still gets the addition.
    const collected = await unshareVaultEntry(db, agentId, 'github/octocat', sealingKey)
    expect(collected).toMatchObject({
      outcome: 'unshared',
      operatorAddition: 'billing PIN 4417',
      handedBackByOperator: true,
    })
  })

  it('refuses a share belonging to somebody else’s agent', async () => {
    const shareId = await share()

    const [stranger] = await db.insert(humans).values({}).returning({ id: humans.id })

    expect(
      await writeShareAddition(
        db,
        { humanId: HumanIdSchema.parse(stranger!.id) },
        shareId,
        'not yours',
        sealingKey,
      ),
    ).toEqual({ outcome: 'closed' })

    expect(
      await handBackShare(db, { humanId: HumanIdSchema.parse(stranger!.id) }, shareId),
    ).toEqual({ outcome: 'closed' })
  })

  it('refuses an expired share on every operator path', async () => {
    const shareId = await share()
    await db
      .update(vaultShares)
      .set({ expiresAt: sql`now() - interval '1 minute'` })
      .where(eq(vaultShares.agentId, agentId))

    expect(await sharesForPageToken(db, pageToken, sealingKey)).toEqual([])
    expect(await writeShareAddition(db, { pageToken }, shareId, 'too late', sealingKey)).toEqual({
      outcome: 'closed',
    })
    expect(await recordShareRead(db, shareId)).toBe(false)
  })

  it('counts what has moved, for the waking read', async () => {
    expect(await vaultSharesWakeupDelta(db, agentId)).toEqual({
      open: 0,
      read: 0,
      written: 0,
      handedBack: 0,
    })

    const first = await share('github/octocat')
    await share('mail/citizen', 'hunter3')

    expect(await vaultSharesWakeupDelta(db, agentId)).toMatchObject({
      open: 2,
      read: 0,
      written: 0,
    })

    await recordShareRead(db, first)
    await writeShareAddition(db, { pageToken }, first, 'billing PIN 4417', sealingKey)

    expect(await vaultSharesWakeupDelta(db, agentId)).toMatchObject({
      open: 2,
      read: 1,
      written: 1,
    })

    await handBackShare(db, { pageToken }, first)

    // Handed back is not open: *I am finished* is a different fact from *I can
    // still read this*.
    expect(await vaultSharesWakeupDelta(db, agentId)).toMatchObject({ open: 1, handedBack: 1 })
  })
})
