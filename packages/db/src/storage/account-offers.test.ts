import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { AccountKindSchema, RegisterAgentRequestSchema, type AgentId } from '@kolonie-ai/core'
import { generateApiKey } from '../api-key.js'
import type { Database } from '../client.js'
import {
  accountOffers,
  accountThreads,
  accountTransfers,
  accounts,
  agentVault,
  agents,
  emailChallenges,
} from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { declareAccount } from './accounts.js'
import { registerAgent } from './agents.js'
import {
  acceptAccountOffer,
  declineAccountOffer,
  deleteExpiredAccountOffers,
  giveAccount,
  offersTo,
  withdrawAccountOffer,
  type AcceptAccountOfferOutcome,
  type GiveAccountOutcome,
} from './account-offers.js'
import { getVaultEntry, listVaultEntries, setVaultEntry } from './vault.js'

const target = databaseTestTarget()

/** Any 32 bytes. Never a real key, and nothing in this file is a real secret. */
const SEALING_KEY = 'a-test-sealing-key-that-is-long-enough'

/** The branded kind `declareAccount` takes, from the string a reader can see. */
const kind = (value: string) => AccountKindSchema.parse(value)

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

  /**
   * `#1213`, and the reversal of what decision 3 used to say here. A declared
   * row with a credential behind it is an account the recipient can open, which
   * is the whole of what a transfer moves.
   */
  it('offers a declared account that names a vault entry the giver holds', async () => {
    // Its own entry, not the one `accountId` names: a key two accounts share is
    // the pause of decision 8, and it would answer before proof was even read.
    await setVaultEntry(db, giverToken, giver, 'provider/declared', FIXTURE_VALUE)
    const declared = await anAccount({
      proved: false,
      identifier: 'declared-with-a-credential',
      vaultKey: 'provider/declared',
    })

    const offered = await give({ accountId: declared })
    if (offered.outcome !== 'offered') throw new Error(offered.outcome)

    // The parcel is the point: an offer with no credential in it would be the
    // note-to-self the old refusal was worried about.
    const [row] = await db.select().from(accountOffers).where(eq(accountOffers.id, offered.offerId))
    expect(row?.transferId).not.toBeNull()
    expect(row?.toAgentId).toBe(recipient)
  })

  /**
   * Decision 4, and after `#1213` it is the only thing standing in the way of a
   * declared account: what is refused is the missing credential rather than the
   * missing proof, and a proved row with no vault entry is refused identically.
   */
  it('refuses an account that names no vault entry, proved or declared', async () => {
    const unlinked = await anAccount({ vaultKey: null, identifier: 'no-key' })
    expect(await give({ accountId: unlinked })).toEqual({ outcome: 'no-vault-key' })

    const declared = await anAccount({ proved: false, vaultKey: null, identifier: 'declared-bare' })
    expect(await give({ accountId: declared })).toEqual({ outcome: 'no-vault-key' })
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

  /**
   * Taking it (`#1126`) — the only call in this file that moves anything.
   *
   * Two assertions here carry the design and the rest support them: what
   * arrives is indistinguishable from a row the recipient declared for itself,
   * and every refusal is answered before the parcel is opened, so a refusal
   * costs the recipient nothing but the call.
   */
  describe('accepting', () => {
    /** The recipient's own key. Seals its new entry, and opens nothing else. */
    let recipientToken: string
    let offerId: string

    beforeEach(async () => {
      recipientToken = String(generateApiKey())

      const offered = await give()
      if (offered.outcome !== 'offered') throw new Error(offered.outcome)
      offerId = offered.offerId
    })

    const accept = async (
      over: {
        readonly offerId?: string
        readonly toAgentId?: AgentId
        readonly vaultKey?: string
        readonly token?: string
      } = {},
    ): Promise<AcceptAccountOfferOutcome> =>
      await acceptAccountOffer(
        db,
        {
          offerId: over.offerId ?? offerId,
          toAgentId: over.toAgentId ?? recipient,
          vaultKey: over.vaultKey ?? 'mine/the-account',
        },
        over.token ?? recipientToken,
        SEALING_KEY,
      )

    it('moves the account, opens the parcel into the recipient’s vault, and deletes the giver’s row', async () => {
      const taken = await accept()
      if (taken.outcome !== 'accepted') throw new Error(taken.outcome)

      // The receipt names both parties and what moved (decision 15).
      expect(taken).toMatchObject({
        fromHandle: 'giver',
        accountKind: 'github',
        accountIdentifier: 'a-spare-handle',
        accountProvider: 'example.test',
        vaultKey: 'mine/the-account',
      })
      expect(taken.accountId).not.toBe(accountId)

      // The giver's row is gone rather than retired (decision 10), and the
      // recipient's is the only one left.
      expect(await db.select().from(accounts).where(eq(accounts.id, accountId))).toEqual([])
      const [arrived] = await db.select().from(accounts).where(eq(accounts.id, taken.accountId))
      expect(arrived).toMatchObject({
        agentId: recipient,
        kind: 'github',
        identifier: 'a-spare-handle',
        provider: 'example.test',
        vaultKey: 'mine/the-account',
      })

      // The credential arrived, under the recipient's name and its own key.
      const opened = await getVaultEntry(db, recipientToken, recipient, 'mine/the-account')
      expect(opened).toMatchObject({ outcome: 'found', value: FIXTURE_VALUE })

      // And the giver's own entry is still there, no longer opening (decision
      // 12 as `#1214` corrects it). Its own tests are below.
      expect(await getVaultEntry(db, giverToken, giver, 'provider/handle')).toMatchObject({
        outcome: 'spent',
      })

      // Nothing of the handover survives it.
      expect(await db.select().from(accountOffers)).toEqual([])
      expect(await db.select().from(accountTransfers)).toEqual([])
    })

    /**
     * What happens to the giver's own entry (`#1214`).
     *
     * The account moved and the credential went with it, so the name the giver
     * knows it by has to stop handing back a secret: a citizen reading its own
     * password out of that entry is being told it still holds an account that
     * is somebody else's now. **Nothing is deleted for it.** A vault another
     * citizen's act can empty is not the vault D-043 describes, and those bytes
     * are the giver's only copy of something it may still have to reason about.
     */
    describe('the giver’s own vault entry', () => {
      it('keeps its bytes and stops opening', async () => {
        const taken = await accept()
        if (taken.outcome !== 'accepted') throw new Error(taken.outcome)

        const held = await getVaultEntry(db, giverToken, giver, 'provider/handle')
        if (held.outcome !== 'spent') throw new Error(held.outcome)
        expect(held.entry.spentAt).not.toBeNull()

        // The row is untouched apart from that mark, and the listing carries
        // it exactly as before — a spent entry is still the giver's to see.
        const [row] = await db.select().from(agentVault).where(eq(agentVault.agentId, giver))
        expect(row?.encryptedValue).toBeTruthy()
        expect(await listVaultEntries(db, giverToken, giver)).toMatchObject([
          { key: 'provider/handle', description: FIXTURE_DESCRIPTION },
        ])
      })

      /** The name is the giver's again the moment it means something again. */
      it('opens again once the giver writes something new under the name', async () => {
        const taken = await accept()
        if (taken.outcome !== 'accepted') throw new Error(taken.outcome)

        const stored = await setVaultEntry(
          db,
          giverToken,
          giver,
          'provider/handle',
          'another-fixture-value-not-a-credential',
        )
        expect(stored).toMatchObject({ outcome: 'stored', created: false })

        expect(await getVaultEntry(db, giverToken, giver, 'provider/handle')).toMatchObject({
          outcome: 'found',
          value: 'another-fixture-value-not-a-credential',
        })
      })

      /**
       * The guard decision 8 makes necessary. One entry can open several
       * accounts, and the giver was asked about that at the offer and went
       * ahead — for *this* account. Marking the name spent would take a live
       * credential away from the sibling, which nobody gave to anybody.
       */
      it('stays live while another account of the giver’s still names it', async () => {
        await withdrawAccountOffer(db, { offerId, fromAgentId: giver })
        await anAccount({ identifier: 'the-sibling' })

        const paused = await give()
        if (paused.outcome !== 'confirm') throw new Error(paused.outcome)
        const offered = await give({ confirm: paused.token })
        if (offered.outcome !== 'offered') throw new Error(offered.outcome)

        const taken = await accept({ offerId: offered.offerId })
        if (taken.outcome !== 'accepted') throw new Error(taken.outcome)

        expect(await getVaultEntry(db, giverToken, giver, 'provider/handle')).toMatchObject({
          outcome: 'found',
          value: FIXTURE_VALUE,
        })
      })
    })

    /**
     * Decisions 6 and 7, and the criterion an implementation is likeliest to
     * erode: what arrives is the row the recipient would have written for
     * itself, compared column by column against one it actually did.
     *
     * `forWork` is the single deliberate departure — it defaults true and a
     * choice is not transferable — so it is asserted as *the* difference rather
     * than excluded from the comparison and forgotten about.
     */
    it('arrives as a row the recipient could have declared for itself', async () => {
      const taken = await accept()
      if (taken.outcome !== 'accepted') throw new Error(taken.outcome)

      const declared = await declareAccount(db, recipient, {
        kind: kind('github'),
        identifier: 'declared-for-comparison',
        provider: 'example.test',
        vaultKey: 'mine/the-account',
      })
      if (declared.outcome !== 'declared') throw new Error(declared.outcome)

      const [arrived] = await db.select().from(accounts).where(eq(accounts.id, taken.accountId))
      const [written] = await db.select().from(accounts).where(eq(accounts.id, declared.account.id))
      if (arrived === undefined || written === undefined) throw new Error('a row went missing')

      // Nobody added a column saying *this one was handed over*. The two rows
      // have the same shape or this comparison is not measuring what it says.
      expect(Object.keys(arrived).sort()).toEqual(Object.keys(written).sort())

      const differing = (Object.keys(written) as (keyof typeof written)[]).filter((column) => {
        // Its own identity, its own dates, and the identifier that had to differ
        // for the second row to be insertable at all.
        if (column === 'id' || column === 'identifier') return false
        if (column === 'createdAt' || column === 'updatedAt') return false
        return JSON.stringify(arrived[column]) !== JSON.stringify(written[column])
      })
      expect(differing).toEqual(['forWork'])
      expect(arrived.forWork).toBe(false)
      expect(written.forWork).toBe(true)

      // Spelled out, because the comparison above would also pass if both rows
      // were wrong together: proof is something the Colony checked about a
      // citizen, and it has not checked it about this one.
      expect(arrived).toMatchObject({ proved: false, provedAt: null, provedBy: null })
    })

    /**
     * `#1213` from the receiving end. The credential is what travels, so a
     * declared account arrives openable; the register says `proved: false`
     * because that is what it said before the move, and a transfer is not a
     * thing the Colony checked about anybody.
     */
    it('opens a declared account for the recipient without inventing a proof', async () => {
      await setVaultEntry(db, giverToken, giver, 'provider/declared', FIXTURE_VALUE)
      const declaredId = await anAccount({
        proved: false,
        identifier: 'declared-and-given',
        vaultKey: 'provider/declared',
      })

      const offered = await give({ accountId: declaredId })
      if (offered.outcome !== 'offered') throw new Error(offered.outcome)

      const taken = await accept({ offerId: offered.offerId, vaultKey: 'mine/the-declared-one' })
      if (taken.outcome !== 'accepted') throw new Error(taken.outcome)

      const [arrived] = await db.select().from(accounts).where(eq(accounts.id, taken.accountId))
      expect(arrived).toMatchObject({
        agentId: recipient,
        identifier: 'declared-and-given',
        proved: false,
        provedAt: null,
        provedBy: null,
      })

      expect(
        await getVaultEntry(db, recipientToken, recipient, 'mine/the-declared-one'),
      ).toMatchObject({ outcome: 'found', value: FIXTURE_VALUE })

      expect(await db.select().from(accounts).where(eq(accounts.id, declaredId))).toEqual([])
    })

    /**
     * The parcel is bound to the citizen it was sealed for, and the offer is
     * filtered on the same citizen — so a stranger is refused before anything is
     * unsealed, and the recipient's own call afterwards still works.
     */
    it('refuses an offer addressed to somebody else, with the parcel unread', async () => {
      const stranger = await register('stranger')

      expect(await accept({ toAgentId: stranger })).toEqual({ outcome: 'unknown' })
      expect(await db.select().from(accountOffers)).toHaveLength(1)
      expect(await db.select().from(accountTransfers)).toHaveLength(1)
      expect(await db.select().from(accounts).where(eq(accounts.id, accountId))).toHaveLength(1)

      expect(await accept()).toMatchObject({ outcome: 'accepted' })
    })

    it('answers unknown for an offer nobody ever made, and for a lapsed one', async () => {
      expect(await accept({ offerId: '00000000-0000-4000-8000-000000000000' })).toEqual({
        outcome: 'unknown',
      })

      await db.update(accountOffers).set({
        createdAt: sql`now() - interval '8 days'`,
        expiresAt: sql`now() - interval '1 hour'`,
      })
      expect(await accept()).toEqual({ outcome: 'unknown' })
    })

    /** The giver erased itself; the account went with it. One answer (decision 5). */
    it('answers unknown once the giver is gone', async () => {
      await db.delete(agents).where(eq(agents.id, giver))
      expect(await accept()).toEqual({ outcome: 'unknown' })
    })

    it('refuses a vault name the recipient already holds, and leaves that entry alone', async () => {
      const mine = 'a-different-fixture-value-0000000000'
      await setVaultEntry(db, recipientToken, recipient, 'mine/the-account', mine)

      expect(await accept()).toEqual({ outcome: 'key-taken' })

      // Untouched, and the offer is still there to be taken under another name.
      expect(await getVaultEntry(db, recipientToken, recipient, 'mine/the-account')).toMatchObject({
        outcome: 'found',
        value: mine,
      })
      expect(await db.select().from(accountOffers)).toHaveLength(1)
      expect(await accept({ vaultKey: 'mine/the-other-one' })).toMatchObject({
        outcome: 'accepted',
      })
    })

    /**
     * `accounts_identifier_per_agent_unique`. Not in the issue's list of
     * refusals, and it has to be one: without it the insert would raise inside a
     * transaction that has already unsealed the parcel.
     *
     * Reachable on `website` and awkward to reach on anything else, because
     * every other kind identifies globally — so a recipient that declared the
     * giver's github handle would have been refused at the declaration. That is
     * a reason to check it here rather than not to: the refusal has to hold for
     * the one kind two citizens may legitimately both name.
     */
    it('refuses an account the recipient already holds under that identifier', async () => {
      await setVaultEntry(db, giverToken, giver, 'provider/site', FIXTURE_VALUE)
      const site = await anAccount({
        kind: 'website',
        identifier: 'https://spare.example.test/',
        vaultKey: 'provider/site',
      })
      const offered = await give({ accountId: site })
      if (offered.outcome !== 'offered') throw new Error(offered.outcome)

      // Cased differently, because *the same account* is not a question of case.
      const declared = await declareAccount(db, recipient, {
        kind: kind('website'),
        identifier: 'HTTPS://Spare.Example.Test/',
      })
      expect(declared.outcome).toBe('declared')

      expect(await accept({ offerId: offered.offerId })).toEqual({ outcome: 'already-held' })
      // Refused before the parcel was opened, so the offer survives the refusal.
      expect(
        await db.select().from(accountOffers).where(eq(accountOffers.id, offered.offerId)),
      ).toHaveLength(1)
      expect(await db.select().from(accounts).where(eq(accounts.id, site))).toHaveLength(1)
    })

    /**
     * Decision 11: what was said about how the giver got it goes with the row.
     *
     * There is a thread on every account already — `0242_a_thread_on_every_account`
     * puts one there on insert — so this asserts the giver's is gone rather than
     * putting one there to watch it go, and that the arrived row has its own.
     */
    it('takes the giver’s thread with the account', async () => {
      const before = await db
        .select()
        .from(accountThreads)
        .where(eq(accountThreads.accountId, accountId))
      expect(before).toHaveLength(1)

      const taken = await accept()
      if (taken.outcome !== 'accepted') throw new Error(taken.outcome)

      expect(
        await db.select().from(accountThreads).where(eq(accountThreads.accountId, accountId)),
      ).toEqual([])
      // A thread of its own, and not the giver's carried across.
      const [mine] = await db
        .select()
        .from(accountThreads)
        .where(eq(accountThreads.accountId, taken.accountId))
      expect(mine?.id).not.toBe(before[0]?.id)
    })

    it('stops being held out to the recipient once it is taken', async () => {
      expect(await offersTo(db, recipient)).toMatchObject([{ offerId, fromHandle: 'giver' }])

      expect(await accept()).toMatchObject({ outcome: 'accepted' })
      expect(await offersTo(db, recipient)).toEqual([])
    })
  })

  /** Decision 2: saying no, which costs nothing and records nothing. */
  describe('declining', () => {
    let offerId: string

    beforeEach(async () => {
      const offered = await give()
      if (offered.outcome !== 'offered') throw new Error(offered.outcome)
      offerId = offered.offerId
    })

    it('takes the offer and its parcel, and leaves the giver’s row exactly as it was', async () => {
      const [before] = await db.select().from(accounts).where(eq(accounts.id, accountId))

      expect(await declineAccountOffer(db, { offerId, toAgentId: recipient })).toEqual({
        outcome: 'declined',
      })

      expect(await db.select().from(accountOffers)).toEqual([])
      expect(await db.select().from(accountTransfers)).toEqual([])
      const [after] = await db.select().from(accounts).where(eq(accounts.id, accountId))
      expect(after).toEqual(before)
      expect(await getVaultEntry(db, giverToken, giver, 'provider/handle')).toMatchObject({
        outcome: 'found',
        value: FIXTURE_VALUE,
      })
    })

    it('lets the giver offer the account to somebody else afterwards', async () => {
      await declineAccountOffer(db, { offerId, toAgentId: recipient })
      expect(await give({ to: 'stranger' })).toMatchObject({ outcome: 'offered' })
    })

    it('refuses another citizen’s offer, and an offer nobody has, alike', async () => {
      const stranger = await register('stranger')

      expect(await declineAccountOffer(db, { offerId, toAgentId: stranger })).toEqual({
        outcome: 'unknown',
      })
      expect(
        await declineAccountOffer(db, {
          offerId: '00000000-0000-4000-8000-000000000000',
          toAgentId: recipient,
        }),
      ).toEqual({ outcome: 'unknown' })
      expect(await db.select().from(accountOffers)).toHaveLength(1)
    })
  })
})
