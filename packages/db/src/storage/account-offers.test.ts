import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { RegisterAgentRequestSchema, type AgentId } from '@kolonie-ai/core'
import { generateApiKey } from '../api-key.js'
import type { Database } from '../client.js'
import { accountOffers, accountTransfers, accounts, emailChallenges } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { registerAgent } from './agents.js'
import {
  deleteExpiredAccountOffers,
  giveAccount,
  withdrawAccountOffer,
  type GiveAccountOutcome,
} from './account-offers.js'
import { setVaultEntry } from './vault.js'

const target = databaseTestTarget()

/** Any 32 bytes. Never a real key, and nothing in this file is a real secret. */
const SEALING_KEY = 'a-test-sealing-key-that-is-long-enough'

/** A fixture, not a credential: it exists to be searched for in the row. */
const FIXTURE_VALUE = 'fixture-value-not-a-credential-0000'
const FIXTURE_DESCRIPTION = 'a fixture description, also not a credential'

/**
 * Offering a spare account to another citizen (`#1125`).
 *
 * The assertion this file exists for is the last one: giving to a handle
 * somebody holds and giving to a handle nobody holds answer identically, field
 * by field. Everything above it is a refusal that had to happen *before* the
 * handle was looked at for that to be true.
 */
describe('an account offered to another citizen', () => {
  let db: Database
  let giver: AgentId
  let recipient: AgentId
  let giverToken: string
  let accountId: string

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)

    giverToken = String(generateApiKey())
    giver = await register('giver')
    recipient = await register('recipient')

    const stored = await setVaultEntry(
      db,
      giverToken,
      giver,
      'provider/handle',
      FIXTURE_VALUE,
      FIXTURE_DESCRIPTION,
    )
    expect(stored.outcome).toBe('stored')

    accountId = await anAccount({ vaultKey: 'provider/handle', proved: true })
  })

  const register = async (name: string): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  const anAccount = async (over: {
    readonly vaultKey?: string | null
    readonly proved?: boolean
    readonly kind?: string
    readonly identifier?: string
    readonly agentId?: AgentId
  }): Promise<string> => {
    const proved = over.proved ?? true
    const [row] = await db
      .insert(accounts)
      .values({
        agentId: over.agentId ?? giver,
        kind: over.kind ?? 'github',
        identifier: over.identifier ?? 'a-spare-handle',
        provider: 'example.test',
        proved,
        // `accounts_proved_has_a_date`: a proof is an event and carries its date.
        provedAt: proved ? sql`now()` : null,
        vaultKey: over.vaultKey === undefined ? 'provider/handle' : over.vaultKey,
      })
      .returning({ id: accounts.id })
    if (row === undefined) throw new Error('inserting an account returned no row')
    return row.id
  }

  /** A proved inbox row, which is what `provedMailbox` reads (D-047). */
  const aProvedMailbox = async (address: string, primary: boolean) => {
    await db.insert(emailChallenges).values({
      agentId: giver,
      address,
      token: `token-${address}`,
      expiresAt: sql`now() + interval '1 day'`,
      // `email_challenges_verdict_needs_its_evidence` and
      // `email_challenges_code_belongs_to_inbox`: an inbox rung is passed by
      // reading a code out of mail the Colony sent, so a pass without a
      // despatch, or a despatch without a code, is a row the database refuses.
      sentAt: sql`now()`,
      code: 'AAAAAAAAAAAA',
      verifiedAt: sql`now()`,
      primaryAt: primary ? sql`now()` : null,
    })
  }

  const give = async (
    over: { readonly accountId?: string; readonly to?: string; readonly confirm?: string } = {},
  ): Promise<GiveAccountOutcome> =>
    await giveAccount(
      db,
      {
        fromAgentId: giver,
        accountId: over.accountId ?? accountId,
        toHandle: over.to ?? 'recipient',
        confirm: over.confirm,
      },
      giverToken,
      SEALING_KEY,
    )

  it('writes the offer and seals a parcel for the recipient', async () => {
    const offered = await give()
    if (offered.outcome !== 'offered') throw new Error(offered.outcome)

    const [row] = await db.select().from(accountOffers).where(eq(accountOffers.id, offered.offerId))
    expect(row).toMatchObject({
      fromAgentId: giver,
      accountId,
      toAgentId: recipient,
      toHandle: 'recipient',
      accountKind: 'github',
      accountIdentifier: 'a-spare-handle',
    })
    expect(row?.transferId).not.toBeNull()

    // Decision 12: one clock, and it is the parcel's.
    const [parcel] = await db
      .select()
      .from(accountTransfers)
      .where(eq(accountTransfers.id, row?.transferId ?? ''))
    expect(parcel?.expiresAt).toBe(offered.expiresAt)

    // Decision 13, and its limit: the offer names the account in the clear and
    // carries nothing that opens it.
    const everyColumn = JSON.stringify(row)
    expect(everyColumn).not.toContain(FIXTURE_VALUE)
    expect(everyColumn).not.toContain(FIXTURE_DESCRIPTION)
    expect(everyColumn).not.toContain('provider/handle')
  })

  /** Decision 14: giving says something, and only accepting moves anything. */
  it('changes nothing about the account or the vault', async () => {
    await give()

    const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId))
    expect(account).toMatchObject({ agentId: giver, proved: true, vaultKey: 'provider/handle' })
    expect(account?.status).toBe('in-use')
  })

  it('echoes the handle as the giver typed it', async () => {
    const offered = await give({ to: '  ReCiPiEnT  ' })
    if (offered.outcome !== 'offered') throw new Error(offered.outcome)

    expect(offered.toHandle).toBe('  ReCiPiEnT  ')
    // Resolved case-insensitively all the same, so the parcel found its citizen.
    const [row] = await db.select().from(accountOffers).where(eq(accountOffers.id, offered.offerId))
    expect(row?.toAgentId).toBe(recipient)
  })

  it('refuses an account that is not this citizen’s, and one that is nobody’s alike', async () => {
    const stranger = await register('stranger')
    const theirs = await anAccount({ agentId: stranger, identifier: 'not-mine' })

    expect(await give({ accountId: theirs })).toEqual({ outcome: 'unknown-account' })
    expect(await give({ accountId: '00000000-0000-4000-8000-000000000000' })).toEqual({
      outcome: 'unknown-account',
    })
  })

  /** Decision 3. */
  it('refuses a declared account', async () => {
    const declared = await anAccount({ proved: false, identifier: 'declared-only' })
    expect(await give({ accountId: declared })).toEqual({ outcome: 'not-proved' })
  })

  /** Decision 4. */
  it('refuses an account that names no vault entry', async () => {
    const unlinked = await anAccount({ vaultKey: null, identifier: 'no-key' })
    expect(await give({ accountId: unlinked })).toEqual({ outcome: 'no-vault-key' })
  })

  it('refuses an account naming an entry the giver does not hold', async () => {
    const dangling = await anAccount({ vaultKey: 'provider/never-stored', identifier: 'dangling' })
    expect(await give({ accountId: dangling })).toEqual({ outcome: 'nothing-to-give' })
  })

  /** Decision 6, and the one refusal exempt from decision 5. */
  it('refuses giving to yourself, however you spell it', async () => {
    expect(await give({ to: 'GIVER' })).toEqual({ outcome: 'self' })
  })

  /** Decision 9, naming the offer so the giver knows what to withdraw. */
  it('refuses a second offer on the same account', async () => {
    const first = await give()
    if (first.outcome !== 'offered') throw new Error(first.outcome)

    const second = await give({ to: 'stranger' })
    expect(second).toEqual({
      outcome: 'already-offered',
      offerId: first.offerId,
      toHandle: 'recipient',
      expiresAt: first.expiresAt,
    })
  })

  /** Decision 7: the address the Colony writes to, with nowhere else to write. */
  describe('the reach mailbox', () => {
    let mailbox: string

    beforeEach(async () => {
      // Its own entry, so that decision 8's pause is not what these measure.
      await setVaultEntry(db, giverToken, giver, 'provider/mailbox', FIXTURE_VALUE)
      mailbox = await anAccount({
        kind: 'mailbox',
        // Recorded with a capital the proved address does not have: reachability
        // is not a property an address loses on a capital letter.
        identifier: 'Reach@example.test',
        vaultKey: 'provider/mailbox',
      })
      await aProvedMailbox('reach@example.test', true)
    })

    it('is refused while it is the only proved one', async () => {
      expect(await give({ accountId: mailbox })).toEqual({ outcome: 'reach-mailbox' })
    })

    it('is givable once a second mailbox is proved', async () => {
      await aProvedMailbox('second@example.test', false)
      expect(await give({ accountId: mailbox })).toMatchObject({ outcome: 'offered' })
    })

    it('does not stand in the way of a mailbox that is not the reach address', async () => {
      await setVaultEntry(db, giverToken, giver, 'provider/spare', FIXTURE_VALUE)
      const spare = await anAccount({
        kind: 'mailbox',
        identifier: 'spare@example.test',
        vaultKey: 'provider/spare',
      })
      expect(await give({ accountId: spare })).toMatchObject({ outcome: 'offered' })
    })
  })

  /** Decision 8: one vault entry behind two accounts is a pause, not a refusal. */
  describe('a vault key two accounts share', () => {
    let sibling: string

    beforeEach(async () => {
      sibling = await anAccount({ identifier: 'the-sibling' })
    })

    it('refuses the first call and names what else the entry opens', async () => {
      const paused = await give()
      if (paused.outcome !== 'confirm') throw new Error(paused.outcome)

      expect(paused.sharedWith).toEqual([{ kind: 'github', identifier: 'the-sibling' }])
      expect(paused.token).toMatch(/^[\w-]{20,}$/)
      expect(await db.select().from(accountOffers)).toEqual([])
    })

    it('proceeds on the second call carrying the token', async () => {
      const paused = await give()
      if (paused.outcome !== 'confirm') throw new Error(paused.outcome)

      expect(await give({ confirm: paused.token })).toMatchObject({ outcome: 'offered' })
    })

    it('will not spend one token twice', async () => {
      const paused = await give()
      if (paused.outcome !== 'confirm') throw new Error(paused.outcome)
      const first = await give({ confirm: paused.token })
      if (first.outcome !== 'offered') throw new Error(first.outcome)

      await withdrawAccountOffer(db, { offerId: first.offerId, fromAgentId: giver })
      expect(await give({ confirm: paused.token })).toMatchObject({ outcome: 'confirm' })
    })

    /**
     * A token belongs to the call it was minted for. Presenting the sibling's
     * token for this account is treated exactly as presenting none — refused,
     * with a fresh token, which is the same repair either way.
     */
    it('will not take a token minted for a different account', async () => {
      const other = await give({ accountId: sibling })
      if (other.outcome !== 'confirm') throw new Error(other.outcome)

      expect(await give({ confirm: other.token })).toMatchObject({ outcome: 'confirm' })
    })

    it('will not take a token minted for a different handle', async () => {
      const other = await give({ to: 'stranger' })
      if (other.outcome !== 'confirm') throw new Error(other.outcome)

      expect(await give({ confirm: other.token })).toMatchObject({ outcome: 'confirm' })
    })

    it('takes a token minted for the same handle spelled differently', async () => {
      const paused = await give({ to: 'RECIPIENT' })
      if (paused.outcome !== 'confirm') throw new Error(paused.outcome)

      expect(await give({ to: 'recipient', confirm: paused.token })).toMatchObject({
        outcome: 'offered',
      })
    })
  })

  /** Decision 11: the withdrawal, which costs nothing and leaves nothing. */
  describe('withdrawing', () => {
    it('takes the offer and its parcel away', async () => {
      const offered = await give()
      if (offered.outcome !== 'offered') throw new Error(offered.outcome)

      expect(
        await withdrawAccountOffer(db, { offerId: offered.offerId, fromAgentId: giver }),
      ).toEqual({ outcome: 'withdrawn' })
      expect(await db.select().from(accountOffers)).toEqual([])
      expect(await db.select().from(accountTransfers)).toEqual([])
    })

    it('lets the account be given again afterwards', async () => {
      const offered = await give()
      if (offered.outcome !== 'offered') throw new Error(offered.outcome)
      await withdrawAccountOffer(db, { offerId: offered.offerId, fromAgentId: giver })

      expect(await give({ to: 'stranger' })).toMatchObject({ outcome: 'offered' })
    })

    it('refuses another citizen’s offer, and an offer nobody has, alike', async () => {
      const stranger = await register('stranger')
      const offered = await give()
      if (offered.outcome !== 'offered') throw new Error(offered.outcome)

      expect(
        await withdrawAccountOffer(db, { offerId: offered.offerId, fromAgentId: stranger }),
      ).toEqual({ outcome: 'unknown' })
      expect(
        await withdrawAccountOffer(db, {
          offerId: '00000000-0000-4000-8000-000000000000',
          fromAgentId: giver,
        }),
      ).toEqual({ outcome: 'unknown' })
      expect(await db.select().from(accountOffers)).toHaveLength(1)
    })
  })

  describe('expiry', () => {
    /**
     * The window heals by the passage of a week, which no surface can produce.
     * Both dates move: `account_offers_expiry_after_creation` refuses a row that
     * lapsed before it was written, and a helper producing an illegal row would
     * be testing something the database cannot hold.
     */
    const ageOut = async () => {
      await db.update(accountOffers).set({
        createdAt: sql`now() - interval '8 days'`,
        expiresAt: sql`now() - interval '1 hour'`,
      })
      await db.update(accountTransfers).set({
        createdAt: sql`now() - interval '8 days'`,
        expiresAt: sql`now() - interval '1 hour'`,
      })
    }

    it('sweeps the offer and the parcel together', async () => {
      await give()
      await ageOut()

      expect(await deleteExpiredAccountOffers(db)).toBe(1)
      expect(await db.select().from(accountOffers)).toEqual([])
      expect(await db.select().from(accountTransfers)).toEqual([])
    })

    /**
     * The unique index is plain rather than partial — a partial one cannot be
     * predicated on `now()` — so what keeps *one open offer per account* from
     * meaning *one offer ever* is `give` sweeping the account's expired rows in
     * its own transaction.
     */
    it('lets a lapsed offer be replaced without waiting for the sweep', async () => {
      await give()
      await ageOut()

      expect(await give({ to: 'stranger' })).toMatchObject({ outcome: 'offered' })
      expect(await db.select().from(accountOffers)).toHaveLength(1)
    })
  })

  /** No sealing key, no credential can travel — and nothing is written. */
  it('refuses when the deployment cannot seal', async () => {
    expect(
      await giveAccount(
        db,
        { fromAgentId: giver, accountId, toHandle: 'recipient' },
        giverToken,
        undefined,
      ),
    ).toEqual({ outcome: 'unsealable' })
    expect(await db.select().from(accountOffers)).toEqual([])
  })

  /**
   * Decision 5, and the reason the check order in `giveAccount` is what it is.
   *
   * Compared field by field rather than by shape, because the shape was never
   * the risk: a helpful *no such citizen* in one branch, or an `expiresAt`
   * computed differently when there is no parcel to take one from, would turn
   * this surface into a scanner for which handles are held.
   */
  it('answers identically for a handle nobody holds', async () => {
    const held = await give({ to: 'recipient' })
    if (held.outcome !== 'offered') throw new Error(held.outcome)
    await withdrawAccountOffer(db, { offerId: held.offerId, fromAgentId: giver })

    const nobody = await give({ to: 'nobody-answers-to-this' })
    if (nobody.outcome !== 'offered') throw new Error(nobody.outcome)

    expect(Object.keys(nobody).sort()).toEqual(Object.keys(held).sort())
    for (const key of Object.keys(held) as (keyof typeof held)[]) {
      // The two that are *supposed* to differ: the id of the row just written,
      // and the handle each call was given, echoed back.
      if (key === 'offerId' || key === 'toHandle') continue
      if (key === 'expiresAt') {
        // Both windows are the parcel's seven days; only the second one has no
        // parcel to read it from, so they are compared as durations.
        const drift = Math.abs(Date.parse(nobody.expiresAt) - Date.parse(held.expiresAt))
        expect(drift).toBeLessThan(60_000)
        continue
      }
      expect(nobody[key]).toEqual(held[key])
    }

    // The row is real: listable, withdrawable, and carrying no parcel to open.
    const [row] = await db.select().from(accountOffers).where(eq(accountOffers.id, nobody.offerId))
    expect(row).toMatchObject({ toAgentId: null, transferId: null })
    expect(await withdrawAccountOffer(db, { offerId: nobody.offerId, fromAgentId: giver })).toEqual(
      { outcome: 'withdrawn' },
    )
  })
})
