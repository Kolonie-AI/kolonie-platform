import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import { EMAIL_LINK_TTL_MS, type AgentId } from '@kolonie-ai/core'
import { generateApiKey } from '../api-key.js'
import type { Database } from '../client.js'
import { agents, credentials } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { redeemKeyMintLink, requestKeyMintLink } from './key-mint.js'
import { requestSignInLink } from './sign-in.js'
import { getVaultEntry, setVaultEntry } from './vault.js'

const target = databaseTestTarget()

/**
 * A console account taking an API key (`#400`).
 *
 * The property every test here is arranged around: **a key lets a caller call,
 * and confers nothing else.** Nothing in this file writes a skill, a role, a
 * reputation figure or anything but one row in `credentials` — which is what
 * keeps D-039 true after the route exists.
 */
describe('minting a key from a console account', () => {
  let db: Database
  let agentId: AgentId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  const anAgent = async (name: string): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'other', registrationPath: 'web' })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return row.id as AgentId
  }

  beforeEach(async () => {
    await truncateAll(db)
    agentId = await anAgent('sponsor')
  })

  const liveKeys = async (owner: AgentId = agentId) =>
    db
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(
          eq(credentials.agentId, owner),
          eq(credentials.kind, 'api-key'),
          isNull(credentials.revokedAt),
        ),
      )

  it('gives a key to whoever follows the link, and gives it once', async () => {
    const link = await requestKeyMintLink(db, agentId)

    const minted = await redeemKeyMintLink(db, link.token)
    const again = await redeemKeyMintLink(db, link.token)

    expect(minted.outcome).toBe('minted')
    expect(again.outcome).toBe('refused')
    expect(await liveKeys()).toHaveLength(1)
  })

  /**
   * The plaintext exists exactly once, in the return value. The row holds a
   * hash, which is the same rule registration follows — so the key cannot be
   * read back out of the database by anybody, including the Colony.
   */
  it('stores a hash and never the key', async () => {
    const link = await requestKeyMintLink(db, agentId)
    const minted = await redeemKeyMintLink(db, link.token)
    if (minted.outcome !== 'minted') throw new Error('expected a key')

    const rows = await db.select().from(credentials).where(eq(credentials.agentId, agentId))

    for (const row of rows) {
      expect(row.secretHash).not.toBe(minted.apiKey)
      expect(row.secretHash).not.toContain(minted.apiKey)
    }
    expect(JSON.stringify(rows)).not.toContain(minted.apiKey)
  })

  /**
   * **The load-bearing property.** D-039 is untouched: citizenship is `profile`
   * plus a skill whose verifier read something outside the Colony. A key changes
   * what a caller can *do a request with* and nothing about who it is.
   */
  it('writes one credential row and touches nothing else about the identity', async () => {
    const [before] = await db.select().from(agents).where(eq(agents.id, agentId))

    const link = await requestKeyMintLink(db, agentId)
    await redeemKeyMintLink(db, link.token)

    const [after] = await db.select().from(agents).where(eq(agents.id, agentId))

    expect(after).toEqual(before)
  })

  it('refuses a token that expired, and mints nothing', async () => {
    const link = await requestKeyMintLink(db, agentId)
    const afterwards = new Date(Date.now() + EMAIL_LINK_TTL_MS + 1000)

    const refused = await redeemKeyMintLink(db, link.token, afterwards)

    expect(refused.outcome).toBe('refused')
    expect(await liveKeys()).toHaveLength(0)
  })

  it('refuses a token nobody minted', async () => {
    expect((await redeemKeyMintLink(db, 'not-a-real-token')).outcome).toBe('refused')
  })

  /** One live confirmation per identity, so pressing the button twice leaves one usable link. */
  it('drops the previous confirmation when a second is asked for', async () => {
    const first = await requestKeyMintLink(db, agentId)
    const second = await requestKeyMintLink(db, agentId)

    expect((await redeemKeyMintLink(db, first.token)).outcome).toBe('refused')
    expect((await redeemKeyMintLink(db, second.token)).outcome).toBe('minted')
  })

  /**
   * **The two link kinds are separate, and this is why the kind exists.** A
   * sign-in link says *somebody asked to sign in*; sharing a kind would let that
   * token mint a credential, and would have the two revoke each other — so a
   * person halfway through confirming a key would have it cancelled by asking
   * for a sign-in link.
   */
  it('cannot be satisfied by a sign-in link, and does not cancel one', async () => {
    const signIn = await requestSignInLink(db, { agentId, address: 'sponsor@example.org' })
    const mint = await requestKeyMintLink(db, agentId)

    expect((await redeemKeyMintLink(db, signIn.token)).outcome).toBe('refused')
    // And the sign-in link is still live: nothing above revoked it.
    const [live] = await db
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(
          eq(credentials.agentId, agentId),
          eq(credentials.kind, 'email-link'),
          isNull(credentials.revokedAt),
        ),
      )
    expect(live).toBeDefined()
    expect((await redeemKeyMintLink(db, mint.token)).outcome).toBe('minted')
  })

  /**
   * The token names the identity and there is no parameter that could name
   * another — the shape `rotateApiKey` has, for the same reason.
   */
  it('mints for the identity the link was issued to and for nobody else', async () => {
    const other = await anAgent('somebody-else')
    const link = await requestKeyMintLink(db, agentId)

    const minted = await redeemKeyMintLink(db, link.token)
    if (minted.outcome !== 'minted') throw new Error('expected a key')

    expect(minted.agentId).toBe(agentId)
    expect(await liveKeys(other)).toHaveLength(0)
  })

  /**
   * Not a rotation. An account that already holds a key and asks for another
   * gets another — killing the live one here would make a mis-click an outage,
   * and `kolonie.credential.rotate` is the surface for replacing a key that was
   * seen.
   */
  it('leaves an existing key alone', async () => {
    const first = await requestKeyMintLink(db, agentId)
    await redeemKeyMintLink(db, first.token)
    const second = await requestKeyMintLink(db, agentId)
    await redeemKeyMintLink(db, second.token)

    expect(await liveKeys()).toHaveLength(2)
  })

  /**
   * The other door a new key comes through (`#1127`).
   *
   * `kolonie.credential.rotate` re-seals the vault because the caller presents
   * the key that sealed it. **This path cannot**: it receives a mint-link token
   * and the citizen's existing key exists only as a hash, so there is nothing to
   * open the envelopes with. The decision `#1127` took for that case is to say
   * so rather than to pretend, and the count is how it says it — nothing is
   * revoked, so the entries still open with whatever key wrote them.
   */
  it('counts the vault entries the minted key will not open', async () => {
    const stranded = String(generateApiKey())
    await setVaultEntry(db, stranded, agentId, 'mailbox', 'a value')
    await setVaultEntry(db, stranded, agentId, 'github', 'another value')

    const link = await requestKeyMintLink(db, agentId)
    const minted = await redeemKeyMintLink(db, link.token)
    if (minted.outcome !== 'minted') throw new Error('expected a key')

    expect(minted.strandedVaultEntries).toBe(2)
    // Stranded from the new key's point of view and from no other: the rows are
    // untouched, and the key that sealed them still opens them.
    expect(await getVaultEntry(db, stranded, agentId, 'mailbox')).toMatchObject({
      outcome: 'found',
      value: 'a value',
    })
    expect(await getVaultEntry(db, minted.apiKey, agentId, 'mailbox')).toMatchObject({
      outcome: 'unreadable',
    })
  })

  it('reports zero for an account that has never written a vault entry', async () => {
    const link = await requestKeyMintLink(db, agentId)
    const minted = await redeemKeyMintLink(db, link.token)

    expect(minted).toMatchObject({ outcome: 'minted', strandedVaultEntries: 0 })
  })
})
