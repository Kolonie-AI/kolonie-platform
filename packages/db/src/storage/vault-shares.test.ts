import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import {
  RegisterAgentRequestSchema,
  VAULT_SHARE_DEFAULT_DAYS,
  VAULT_SHARE_MAX_DAYS,
  type AgentId,
} from '@kolonie-ai/core'
import { generateApiKey } from '../api-key.js'
import type { Database } from '../client.js'
import { guestVaultHandoffs, vaultShares } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { sealVaultValue } from '../vault-crypto.js'
import { registerAgent } from './agents.js'
import { getVaultEntry, listVaultEntries, setVaultDescription, setVaultEntry } from './vault.js'
import {
  consumeGuestVaultHandoff,
  createGuestVaultHandoff,
  destroyExpiredGuestVaultHandoffs,
  destroyExpiredVaultShares,
  inspectGuestVaultHandoff,
  listGuestVaultHandoffs,
  openShareFor,
  revokeGuestVaultHandoff,
  shareLifecycleEvents,
  shareVaultEntry,
  unshareVaultEntry,
} from './vault-shares.js'

const target = databaseTestTarget()

/**
 * One entry handed to a person, for a bounded time (`#1439`).
 *
 * The properties asserted here are the ones `#1437` froze, and two of them are
 * the whole reason the channel is shaped this way rather than as a flag on
 * `agent_vault`: the vault row is never touched, and a citizen can always tell
 * by looking which of its entries a person can read.
 */
describe('sharing a vault entry with an operator', () => {
  let db: Database
  let agentId: AgentId
  let token: string

  /** Not the citizen's key. This is the Colony's, and it is the point. */
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

    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name: 'keeper', platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    agentId = result.agent.id
  })

  const share = (key: string, purpose = 'put a card on the GitHub account', days?: number) =>
    shareVaultEntry(db, {
      token,
      agentId,
      key,
      purpose,
      ...(days === undefined ? {} : { days }),
      sealingKey,
    })

  it('totally orders tied lifecycle events before exposing them', () => {
    const at = '2026-08-24T12:00:00.000Z'
    const events = shareLifecycleEvents([
      {
        id: 'share-b',
        vaultKey: 'provider/second',
        sharedAt: at,
        lastReadAt: at,
        additionWrittenAt: at,
        takenBackAt: at,
      },
      {
        id: 'share-a',
        vaultKey: 'provider/first',
        sharedAt: at,
        lastReadAt: at,
        additionWrittenAt: at,
        takenBackAt: at,
      },
    ])

    expect(events.map((event) => `${event.kind}:${event.vaultKey}`)).toEqual([
      'shared:provider/first',
      'shared:provider/second',
      'read:provider/first',
      'read:provider/second',
      'written:provider/first',
      'written:provider/second',
      'handed-back:provider/first',
      'handed-back:provider/second',
    ])
  })

  it('takes the key and copies the value without it being sent', async () => {
    await setVaultEntry(db, token, agentId, 'github/octocat', 'hunter2', 'the login')

    const shared = await share('github/octocat')

    expect(shared).toMatchObject({ outcome: 'shared', extended: false })

    // The copy is sealed under the Colony's key, not the citizen's — which is
    // the one thing about this table that is not true of `agent_vault`.
    const [row] = await db.select().from(vaultShares).where(eq(vaultShares.agentId, agentId))

    expect(row?.sealedValue).toBeTruthy()
    expect(row?.sealedValue).not.toContain('hunter2')
    expect(row?.vaultKey).toBe('github/octocat')
  })

  it('leaves the vault row exactly as it was', async () => {
    const before = await setVaultEntry(db, token, agentId, 'github/octocat', 'hunter2', 'the login')
    if (before.outcome !== 'stored') throw new Error(before.outcome)

    await share('github/octocat')

    const read = await getVaultEntry(db, token, agentId, 'github/octocat')

    // `#1437` decision 3: the original is untouched throughout, so a share that
    // ends while the citizen is asleep cannot leave a row nobody can open.
    expect(read).toMatchObject({ outcome: 'found', value: 'hunter2' })
    expect(read.outcome === 'found' && read.entry.description).toBe('the login')
    expect(read.outcome === 'found' && read.entry.updatedAt).toBe(before.entry.updatedAt)
  })

  it('shows the share on the entry, in the listing and on a single read', async () => {
    await setVaultEntry(db, token, agentId, 'github/octocat', 'hunter2')
    await setVaultEntry(db, token, agentId, 'mail/citizen', 'hunter3')

    await share('github/octocat', 'they need the login to add a card')

    const listed = await listVaultEntries(db, token, agentId)
    const shared = listed.find((entry) => entry.key === 'github/octocat')
    const untouched = listed.find((entry) => entry.key === 'mail/citizen')

    expect(shared?.share).toMatchObject({
      purpose: 'they need the login to add a card',
      operatorWrote: false,
    })
    expect(untouched?.share).toBeNull()

    const read = await getVaultEntry(db, token, agentId, 'github/octocat')
    expect(read.outcome === 'found' && read.entry.share).not.toBeNull()
  })

  it('extends an existing share rather than opening a second one', async () => {
    await setVaultEntry(db, token, agentId, 'github/octocat', 'hunter2')

    const first = await share('github/octocat', 'add a card', 3)
    const second = await share('github/octocat', 'add a card, and check the billing address', 9)

    expect(first).toMatchObject({ outcome: 'shared', extended: false })
    expect(second).toMatchObject({ outcome: 'shared', extended: true })

    const rows = await db.select().from(vaultShares).where(eq(vaultShares.agentId, agentId))
    expect(rows).toHaveLength(1)

    if (first.outcome !== 'shared' || second.outcome !== 'shared') throw new Error('not shared')

    // The expiry moves and `sharedAt` does not: it means *when a person first
    // got this*, which is what a citizen weighing a take-back wants.
    expect(Date.parse(second.share.expiresAt)).toBeGreaterThan(Date.parse(first.share.expiresAt))
    expect(second.share.sharedAt).toBe(first.share.sharedAt)
    expect(second.share.purpose).toBe('add a card, and check the billing address')
  })

  it('caps the window at the maximum and defaults to a week', async () => {
    await setVaultEntry(db, token, agentId, 'github/octocat', 'hunter2')

    const capped = await share('github/octocat', 'a long one', VAULT_SHARE_MAX_DAYS + 60)
    if (capped.outcome !== 'shared') throw new Error(capped.outcome)

    const days = (Date.parse(capped.share.expiresAt) - Date.now()) / 86_400_000
    expect(days).toBeLessThanOrEqual(VAULT_SHARE_MAX_DAYS + 0.01)
    expect(days).toBeGreaterThan(VAULT_SHARE_MAX_DAYS - 0.01)

    await unshareVaultEntry(db, agentId, 'github/octocat', sealingKey)

    const defaulted = await share('github/octocat')
    if (defaulted.outcome !== 'shared') throw new Error(defaulted.outcome)

    const defaultDays = (Date.parse(defaulted.share.expiresAt) - Date.now()) / 86_400_000
    expect(Math.round(defaultDays)).toBe(VAULT_SHARE_DEFAULT_DAYS)
  })

  it('refuses a write while the entry is shared, and takes one again afterwards', async () => {
    await setVaultEntry(db, token, agentId, 'github/octocat', 'hunter2')
    await share('github/octocat')

    const refused = await setVaultEntry(db, token, agentId, 'github/octocat', 'hunter4')
    expect(refused.outcome).toBe('shared')

    // Refused rather than merged: the operator is reading a copy taken when the
    // share opened, and `#1437` decision 4 removes the conflict by refusing.
    const unchanged = await getVaultEntry(db, token, agentId, 'github/octocat')
    expect(unchanged).toMatchObject({ outcome: 'found', value: 'hunter2' })

    await unshareVaultEntry(db, agentId, 'github/octocat', sealingKey)

    const written = await setVaultEntry(db, token, agentId, 'github/octocat', 'hunter4')
    expect(written.outcome).toBe('stored')
  })

  it('lets the citizen go on reading and describing its own entry', async () => {
    await setVaultEntry(db, token, agentId, 'github/octocat', 'hunter2')
    await share('github/octocat')

    // Sharing hands over a copy; it does not take the original away, and a
    // vault that locked a citizen out while its operator looked would be one
    // that punished asking for help.
    const read = await getVaultEntry(db, token, agentId, 'github/octocat')
    expect(read).toMatchObject({ outcome: 'found', value: 'hunter2' })

    const described = await setVaultDescription(db, token, agentId, 'github/octocat', 'the login')
    expect(described.outcome).toBe('described')
    expect(described.outcome === 'described' && described.entry.share).not.toBeNull()
  })

  it('hands the operator’s addition back once, and destroys the copy', async () => {
    await setVaultEntry(db, token, agentId, 'github/octocat', 'hunter2')
    await share('github/octocat')

    // What #1440 will write from the operator's side, written directly here so
    // this file tests the mechanism rather than the surface above it.
    await db
      .update(vaultShares)
      .set({
        operatorAddition: sealVaultValue(
          sealingKey,
          String(agentId),
          'vault-share:github/octocat#addition',
          'billing PIN 4417',
        ),
      })
      .where(eq(vaultShares.agentId, agentId))

    const first = await unshareVaultEntry(db, agentId, 'github/octocat', sealingKey)
    expect(first).toMatchObject({ outcome: 'unshared', operatorAddition: 'billing PIN 4417' })

    const [row] = await db.select().from(vaultShares).where(eq(vaultShares.agentId, agentId))
    expect(row?.sealedValue).toBeNull()
    expect(row?.takenBackAt).not.toBeNull()

    // Once. A second take-back has nothing to end and says so, which is a fact
    // an agent unsure whether it already collected the addition can act on.
    const second = await unshareVaultEntry(db, agentId, 'github/octocat', sealingKey)
    expect(second.outcome).toBe('not-shared')
  })

  it('reads an expired share as no share, with nothing having swept it', async () => {
    await setVaultEntry(db, token, agentId, 'github/octocat', 'hunter2')
    await share('github/octocat')

    await db
      .update(vaultShares)
      .set({ expiresAt: sql`now() - interval '1 minute'` })
      .where(eq(vaultShares.agentId, agentId))

    expect(await openShareFor(db, agentId, 'github/octocat')).toBeNull()

    const listed = await listVaultEntries(db, token, agentId)
    expect(listed[0]?.share).toBeNull()

    // And the write it was blocking is allowed again the moment it passes,
    // rather than when a sweep gets round to it.
    expect((await setVaultEntry(db, token, agentId, 'github/octocat', 'hunter4')).outcome).toBe(
      'stored',
    )
  })

  it('destroys the copy behind an expired share, and keeps the row', async () => {
    await setVaultEntry(db, token, agentId, 'github/octocat', 'hunter2')
    await share('github/octocat')

    expect(await destroyExpiredVaultShares(db)).toBe(0)

    await db
      .update(vaultShares)
      .set({ expiresAt: sql`now() - interval '1 minute'` })
      .where(eq(vaultShares.agentId, agentId))

    expect(await destroyExpiredVaultShares(db)).toBe(1)

    const [row] = await db.select().from(vaultShares).where(eq(vaultShares.agentId, agentId))
    expect(row?.sealedValue).toBeNull()
    // The row survives, so *I shared this and it ran out* stays answerable and
    // an addition written before the window closed is still collectable.
    expect(row).toBeDefined()

    expect(await destroyExpiredVaultShares(db)).toBe(0)
  })

  it('refuses an entry that is not there, and one whose account moved', async () => {
    expect((await share('nothing/here')).outcome).toBe('unknown')

    await setVaultEntry(db, token, agentId, 'github/octocat', 'hunter2')
    await db.execute(sql`update agent_vault set spent_at = now() where agent_id = ${agentId}::uuid`)

    // Sharing a spent credential would not merely mislead the citizen — it
    // would send a person to go and use an account that is not its any more.
    expect((await share('github/octocat')).outcome).toBe('spent')
  })

  it('refuses an entry sealed with a key the caller no longer holds', async () => {
    await setVaultEntry(db, token, agentId, 'github/octocat', 'hunter2')

    token = String(generateApiKey())

    expect((await share('github/octocat')).outcome).toBe('unreadable')

    const rows = await db.select().from(vaultShares).where(eq(vaultShares.agentId, agentId))
    expect(rows).toHaveLength(0)
  })
})

describe('portable one-time guest vault handoffs', () => {
  let db: Database
  let agentId: AgentId
  let otherId: AgentId
  let token: string
  let otherToken: string
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
    otherToken = String(generateApiKey())

    const owner = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name: 'guest-owner', platform: 'openclaw' }),
    )
    const other = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name: 'guest-other', platform: 'openclaw' }),
    )
    if (owner.outcome !== 'registered' || other.outcome !== 'registered') {
      throw new Error('registration failed')
    }
    agentId = owner.agent.id
    otherId = other.agent.id
  })

  const create = (over: Partial<Parameters<typeof createGuestVaultHandoff>[1]> = {}) =>
    createGuestVaultHandoff(db, {
      token,
      agentId,
      key: 'github/octocat',
      purpose: 'use this machine account credential',
      minutes: 15,
      sealingKey,
      ...over,
    })

  it('stores a separately sealed copy and only a hash of a high-entropy bearer token', async () => {
    await setVaultEntry(db, token, agentId, 'github/octocat', 'sentinel-secret', 'machine login')

    const created = await create()
    expect(created.outcome).toBe('created')
    if (created.outcome !== 'created') return
    expect(Buffer.from(created.bearerToken, 'base64url')).toHaveLength(32)

    const [row] = await db.select().from(guestVaultHandoffs)
    expect(row).toBeDefined()
    expect(row?.tokenHash).not.toBe(created.bearerToken)
    expect(JSON.stringify(row)).not.toContain(created.bearerToken)
    expect(JSON.stringify(row)).not.toContain('sentinel-secret')
    expect(JSON.stringify(row)).not.toContain('machine login')

    expect(await getVaultEntry(db, token, agentId, 'github/octocat')).toMatchObject({
      outcome: 'found',
      value: 'sentinel-secret',
    })
    expect((await setVaultEntry(db, token, agentId, 'github/octocat', 'replacement')).outcome).toBe(
      'stored',
    )
  })

  it('keeps each copy immutable when the source vault value is replaced or deleted', async () => {
    await setVaultEntry(db, token, agentId, 'github/octocat', 'first-secret')
    const first = await create()
    if (first.outcome !== 'created') throw new Error(first.outcome)

    await setVaultEntry(db, token, agentId, 'github/octocat', 'second-secret')
    const second = await create()
    if (second.outcome !== 'created') throw new Error(second.outcome)
    await db.execute(
      sql`delete from agent_vault where agent_id = ${agentId}::uuid and key = 'github/octocat'`,
    )

    expect(
      await consumeGuestVaultHandoff(db, first.bearerToken, undefined, sealingKey),
    ).toMatchObject({ outcome: 'revealed', value: 'first-secret' })
    expect(
      await consumeGuestVaultHandoff(db, second.bearerToken, undefined, sealingKey),
    ).toMatchObject({ outcome: 'revealed', value: 'second-secret' })
  })

  it('atomically discloses exactly once across concurrent attempts', async () => {
    await setVaultEntry(db, token, agentId, 'github/octocat', 'sentinel-secret')
    const created = await create()
    if (created.outcome !== 'created') throw new Error(created.outcome)

    const attempts = await Promise.all([
      consumeGuestVaultHandoff(db, created.bearerToken, undefined, sealingKey),
      consumeGuestVaultHandoff(db, created.bearerToken, undefined, sealingKey),
    ])

    expect(attempts.filter((attempt) => attempt.outcome === 'revealed')).toHaveLength(1)
    expect(attempts.filter((attempt) => attempt.outcome === 'closed')).toHaveLength(1)
    expect(attempts.find((attempt) => attempt.outcome === 'revealed')).toMatchObject({
      value: 'sentinel-secret',
    })

    const [row] = await db.select().from(guestVaultHandoffs)
    expect(row?.sealedValue).toBeNull()
    expect(row?.sealedDescription).toBeNull()
    expect(row?.consumedAt).not.toBeNull()
  })

  it('locks an optional passphrase out by token fingerprint and source bucket', async () => {
    await setVaultEntry(db, token, agentId, 'github/octocat', 'sentinel-secret')
    const created = await create({ passphrase: 'separate phrase' })
    if (created.outcome !== 'created') throw new Error(created.outcome)

    const [stored] = await db.select().from(guestVaultHandoffs)
    expect(stored?.passphraseHash).toMatch(/^scrypt\$/)
    expect(stored?.passphraseHash).not.toContain('separate phrase')

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(
        await consumeGuestVaultHandoff(
          db,
          created.bearerToken,
          'wrong phrase',
          sealingKey,
          'source-a',
        ),
      ).toMatchObject({ outcome: attempt < 5 ? 'wrong-passphrase' : 'rate-limited' })
    }

    expect(
      await consumeGuestVaultHandoff(
        db,
        created.bearerToken,
        'separate phrase',
        sealingKey,
        'source-a',
      ),
    ).toEqual({ outcome: 'rate-limited' })
    expect(
      await consumeGuestVaultHandoff(
        db,
        created.bearerToken,
        'separate phrase',
        sealingKey,
        'source-b',
      ),
    ).toMatchObject({ outcome: 'revealed', value: 'sentinel-secret' })
  })

  it('derives terminal state, keeps inspection creator-only, and never reissues capability data', async () => {
    await setVaultEntry(db, token, agentId, 'github/octocat', 'sentinel-secret')
    const created = await create()
    if (created.outcome !== 'created') throw new Error(created.outcome)

    expect(await inspectGuestVaultHandoff(db, agentId, created.handoff.id)).toMatchObject({
      outcome: 'found',
      handoff: { state: 'active' },
    })
    expect(await inspectGuestVaultHandoff(db, otherId, created.handoff.id)).toEqual({
      outcome: 'unknown',
    })
    expect(JSON.stringify(await listGuestVaultHandoffs(db, agentId))).not.toContain(
      created.bearerToken,
    )

    expect(await revokeGuestVaultHandoff(db, agentId, created.handoff.id)).toMatchObject({
      outcome: 'revoked',
      handoff: { state: 'revoked' },
    })
    expect(await revokeGuestVaultHandoff(db, agentId, created.handoff.id)).toMatchObject({
      outcome: 'revoked',
      handoff: { state: 'revoked' },
    })
    expect(await revokeGuestVaultHandoff(db, otherId, created.handoff.id)).toEqual({
      outcome: 'unknown',
    })
    expect(await consumeGuestVaultHandoff(db, created.bearerToken, undefined, sealingKey)).toEqual({
      outcome: 'closed',
    })
  })

  it('treats a revoked handoff as the same closed capability as every other terminal state', async () => {
    await setVaultEntry(db, token, agentId, 'github/octocat', 'sentinel-secret')
    const created = await create()
    if (created.outcome !== 'created') throw new Error(created.outcome)

    expect(await revokeGuestVaultHandoff(db, agentId, created.handoff.id)).toMatchObject({
      outcome: 'revoked',
    })
    expect(await consumeGuestVaultHandoff(db, created.bearerToken, undefined, sealingKey)).toEqual({
      outcome: 'closed',
    })
  })

  it('fails closed for malformed, unknown, expired, revoked, and unreadable capability data', async () => {
    expect(await consumeGuestVaultHandoff(db, 'malformed', undefined, sealingKey)).toEqual({
      outcome: 'closed',
    })

    await setVaultEntry(db, token, agentId, 'github/octocat', 'sentinel-secret')
    const created = await create()
    if (created.outcome !== 'created') throw new Error(created.outcome)

    await db
      .update(guestVaultHandoffs)
      .set({ sealedValue: 'unreadable-envelope' })
      .where(eq(guestVaultHandoffs.id, created.handoff.id))
    expect(await consumeGuestVaultHandoff(db, created.bearerToken, undefined, sealingKey)).toEqual({
      outcome: 'closed',
    })
    const [unreadable] = await db
      .select()
      .from(guestVaultHandoffs)
      .where(eq(guestVaultHandoffs.id, created.handoff.id))
    expect(unreadable?.sealedValue).toBeNull()

    await setVaultEntry(db, token, agentId, 'github/octocat', 'replacement')
    const expired = await create()
    if (expired.outcome !== 'created') throw new Error(expired.outcome)

    await db
      .update(guestVaultHandoffs)
      .set({
        createdAt: sql`now() - interval '2 minutes'`,
        expiresAt: sql`now() - interval '1 minute'`,
      })
      .where(eq(guestVaultHandoffs.id, expired.handoff.id))

    expect(await consumeGuestVaultHandoff(db, expired.bearerToken, undefined, sealingKey)).toEqual({
      outcome: 'closed',
    })
    const inspected = await inspectGuestVaultHandoff(db, agentId, expired.handoff.id)
    expect(inspected.outcome === 'found' && inspected.handoff).toMatchObject({ state: 'expired' })
    expect(await destroyExpiredGuestVaultHandoffs(db)).toBe(1)
    expect(await destroyExpiredGuestVaultHandoffs(db)).toBe(0)

    const [row] = await db
      .select()
      .from(guestVaultHandoffs)
      .where(eq(guestVaultHandoffs.id, expired.handoff.id))
    expect(row?.sealedValue).toBeNull()
  })

  it('rejects another citizen, spent and unreadable vault entries without writing a handoff', async () => {
    await setVaultEntry(db, token, agentId, 'github/octocat', 'sentinel-secret')
    expect((await create({ agentId: otherId, token: otherToken })).outcome).toBe('unknown')

    await db.execute(sql`update agent_vault set spent_at = now() where agent_id = ${agentId}::uuid`)
    expect((await create()).outcome).toBe('spent')
    await db.execute(sql`update agent_vault set spent_at = null where agent_id = ${agentId}::uuid`)
    expect((await create({ token: otherToken })).outcome).toBe('unreadable')

    expect(await db.select().from(guestVaultHandoffs)).toHaveLength(0)
  })
})
