import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import {
  RegisterAgentRequestSchema,
  TRANSFER_MAX_READS,
  TRANSFER_TTL_DAYS,
  type AgentId,
} from '@kolonie-ai/core'
import { generateApiKey } from '../api-key.js'
import type { Database } from '../client.js'
import { accountTransferReceipts, accountTransfers, accounts } from '../schema/index.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'
import { openVaultValue } from '../vault-crypto.js'
import { registerAgent } from './agents.js'
import {
  deleteExpiredAccountTransfers,
  openAccountTransfer,
  sealAccountTransfer,
} from './account-transfers.js'
import { getVaultEntry, listVaultEntries, setVaultEntry } from './vault.js'

const target = databaseTestTarget()

/** Any 32 bytes. Never a real key, and nothing in this file is a real secret. */
const SEALING_KEY = 'a-test-sealing-key-that-is-long-enough'

/** A fixture, not a credential: it exists to be searched for in the row. */
const FIXTURE_VALUE = 'fixture-value-not-a-credential-0000'
const FIXTURE_DESCRIPTION = 'a fixture description, also not a credential'

/**
 * A credential moving from one citizen's vault to another's (`#1124`).
 *
 * What is asserted here is mostly negative, because that is where the value of
 * the design is: no cleartext in the row, a parcel that will not open for the
 * wrong citizen, a refusal that does not touch what the recipient already holds,
 * and a failure part-way through that leaves the parcel retryable rather than
 * spent.
 */
describe('a credential travelling between two citizens', () => {
  let db: Database
  let giver: AgentId
  let recipient: AgentId
  let stranger: AgentId
  let giverToken: string
  let recipientToken: string
  let strangerToken: string

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)

    giverToken = String(generateApiKey())
    recipientToken = String(generateApiKey())
    strangerToken = String(generateApiKey())

    giver = await register('giver')
    recipient = await register('recipient')
    stranger = await register('stranger')

    const stored = await setVaultEntry(
      db,
      giverToken,
      giver,
      'provider/handle',
      FIXTURE_VALUE,
      FIXTURE_DESCRIPTION,
    )
    expect(stored.outcome).toBe('stored')
  })

  const register = async (name: string): Promise<AgentId> => {
    const result = await registerAgent(
      db,
      RegisterAgentRequestSchema.parse({ name, platform: 'openclaw' }),
    )
    if (result.outcome !== 'registered') throw new Error(result.outcome)
    return result.agent.id
  }

  const seal = async (vaultKey = 'provider/handle') =>
    await sealAccountTransfer(
      db,
      { fromAgentId: giver, toAgentId: recipient, vaultKey },
      giverToken,
      SEALING_KEY,
    )

  const open = async (
    transferId: string,
    over: { readonly vaultKey?: string; readonly accountKind?: string } = {},
  ) =>
    await openAccountTransfer(
      db,
      {
        transferId,
        toAgentId: recipient,
        vaultKey: over.vaultKey ?? 'inherited/handle',
        accountKind: over.accountKind ?? 'mailbox',
        accountIdentifier: 'handle-at-provider',
      },
      recipientToken,
      SEALING_KEY,
    )

  it('leaves no cleartext in any column of the parcel', async () => {
    const sealed = await seal()
    if (sealed.outcome !== 'sealed') throw new Error(sealed.outcome)

    const [row] = await db.select().from(accountTransfers).where(eq(accountTransfers.id, sealed.id))

    const everyColumn = JSON.stringify(row)
    expect(everyColumn).not.toContain(FIXTURE_VALUE)
    expect(everyColumn).not.toContain(FIXTURE_DESCRIPTION)
    // Nor the name it came from, which names what the credential is.
    expect(everyColumn).not.toContain('provider/handle')
  })

  it('lands in the recipient vault byte-for-byte, description and all', async () => {
    const sealed = await seal()
    if (sealed.outcome !== 'sealed') throw new Error(sealed.outcome)

    expect(await open(sealed.id)).toMatchObject({ outcome: 'settled' })

    const read = await getVaultEntry(db, recipientToken, recipient, 'inherited/handle')
    expect(read).toMatchObject({ outcome: 'found', value: FIXTURE_VALUE })

    const listed = await listVaultEntries(db, recipientToken, recipient)
    expect(listed).toEqual([
      expect.objectContaining({ key: 'inherited/handle', description: FIXTURE_DESCRIPTION }),
    ])
  })

  it('is gone from the table once it has been opened', async () => {
    const sealed = await seal()
    if (sealed.outcome !== 'sealed') throw new Error(sealed.outcome)

    await open(sealed.id)

    const left = await db.select().from(accountTransfers)
    expect(left).toEqual([])
  })

  it('writes a receipt naming what moved and no secret', async () => {
    const sealed = await seal()
    if (sealed.outcome !== 'sealed') throw new Error(sealed.outcome)

    const settled = await open(sealed.id)
    if (settled.outcome !== 'settled') throw new Error(settled.outcome)

    const [receipt] = await db
      .select()
      .from(accountTransferReceipts)
      .where(eq(accountTransferReceipts.id, settled.receiptId))

    expect(receipt).toMatchObject({
      fromAgentId: giver,
      toAgentId: recipient,
      accountKind: 'mailbox',
      accountIdentifier: 'handle-at-provider',
    })
    const everyColumn = JSON.stringify(receipt)
    expect(everyColumn).not.toContain(FIXTURE_VALUE)
    expect(everyColumn).not.toContain('provider/handle')
    expect(everyColumn).not.toContain('inherited/handle')
  })

  /**
   * The rejection that matters most, asserted in the cipher rather than in
   * front of it.
   *
   * `openAccountTransfer` also refuses a parcel that is not the caller's, and
   * that refusal is a `where` clause somebody could delete. This one is the
   * ciphertext saying no: the same envelope, the same deployment key, the same
   * label, a different citizen as associated data, and nothing comes out.
   */
  it('will not open for a citizen it was not sealed for', async () => {
    const sealed = await seal()
    if (sealed.outcome !== 'sealed') throw new Error(sealed.outcome)

    const [row] = await db
      .select({ sealedValue: accountTransfers.sealedValue })
      .from(accountTransfers)
      .where(eq(accountTransfers.id, sealed.id))
    if (row === undefined) throw new Error('no parcel')

    const label = `account-transfer:${sealed.id}`

    expect(openVaultValue(SEALING_KEY, String(stranger), label, row.sealedValue)).toBeNull()
    expect(openVaultValue(SEALING_KEY, String(giver), label, row.sealedValue)).toBeNull()
    expect(openVaultValue(SEALING_KEY, String(recipient), label, row.sealedValue)).toBe(
      FIXTURE_VALUE,
    )
  })

  it('opens once and never again', async () => {
    const sealed = await seal()
    if (sealed.outcome !== 'sealed') throw new Error(sealed.outcome)

    expect((await open(sealed.id)).outcome).toBe('settled')

    expect(await open(sealed.id, { vaultKey: 'second/handle' })).toEqual({ outcome: 'closed' })
    expect(await getVaultEntry(db, recipientToken, recipient, 'second/handle')).toEqual({
      outcome: 'unknown',
    })
  })

  /**
   * The bound is in the table as well as in the code, asserted against the
   * exported constant rather than against a literal — so raising
   * {@link TRANSFER_MAX_READS} moves this with it rather than leaving a number
   * that has quietly stopped meaning *the most a parcel may be read*.
   */
  it('will not record more reads than the constant allows', async () => {
    const sealed = await seal()
    if (sealed.outcome !== 'sealed') throw new Error(sealed.outcome)

    await expectRejection(
      async () =>
        await db
          .update(accountTransfers)
          .set({ reads: TRANSFER_MAX_READS + 1 })
          .where(eq(accountTransfers.id, sealed.id)),
      /account_transfers_reads_bounded/,
    )
  })

  it('stops being openable once its window has passed, and is swept', async () => {
    const sealed = await seal()
    if (sealed.outcome !== 'sealed') throw new Error(sealed.outcome)

    await db
      .update(accountTransfers)
      .set({
        expiresAt: sql`now() - (${sql.raw(String(TRANSFER_TTL_DAYS))} * interval '1 day') - interval '1 minute'`,
      })
      .where(eq(accountTransfers.id, sealed.id))

    expect(await open(sealed.id)).toEqual({ outcome: 'closed' })
    expect(await deleteExpiredAccountTransfers(db)).toBe(1)
    expect(await db.select().from(accountTransfers)).toEqual([])
  })

  it('seals nothing against a name the giver does not hold', async () => {
    expect(await seal('a-name-nobody-stored')).toEqual({ outcome: 'nothing-to-give' })
    expect(await db.select().from(accountTransfers)).toEqual([])
  })

  it('seals nothing when the giver is presenting a key that will not open it', async () => {
    const sealed = await sealAccountTransfer(
      db,
      { fromAgentId: giver, toAgentId: recipient, vaultKey: 'provider/handle' },
      strangerToken,
      SEALING_KEY,
    )

    expect(sealed).toEqual({ outcome: 'nothing-to-give' })
    expect(await db.select().from(accountTransfers)).toEqual([])
  })

  it('refuses a name the recipient already holds, and touches neither side', async () => {
    await setVaultEntry(db, recipientToken, recipient, 'inherited/handle', 'something-of-my-own')

    const sealed = await seal()
    if (sealed.outcome !== 'sealed') throw new Error(sealed.outcome)

    expect(await open(sealed.id)).toEqual({ outcome: 'key-taken' })

    expect(await getVaultEntry(db, recipientToken, recipient, 'inherited/handle')).toMatchObject({
      outcome: 'found',
      value: 'something-of-my-own',
    })

    const [parcel] = await db
      .select({ reads: accountTransfers.reads, settledAt: accountTransfers.settledAt })
      .from(accountTransfers)
      .where(eq(accountTransfers.id, sealed.id))
    expect(parcel).toMatchObject({ reads: 0, settledAt: null })

    // And it still works once the recipient names something free.
    expect((await open(sealed.id, { vaultKey: 'inherited/second' })).outcome).toBe('settled')
  })

  /**
   * A failure *after* the vault write, which is the dangerous half of the
   * transaction: the credential has landed and the parcel has not yet been
   * consumed. The forcing is a receipt that names no account kind, which the
   * table refuses — a real constraint rather than a seam cut for the test.
   */
  it('leaves the parcel retryable when the settle fails part-way', async () => {
    const sealed = await seal()
    if (sealed.outcome !== 'sealed') throw new Error(sealed.outcome)

    await expect(open(sealed.id, { accountKind: '   ' })).rejects.toThrow()

    // The vault write went back with it.
    expect(await getVaultEntry(db, recipientToken, recipient, 'inherited/handle')).toEqual({
      outcome: 'unknown',
    })

    const [parcel] = await db
      .select({ reads: accountTransfers.reads, settledAt: accountTransfers.settledAt })
      .from(accountTransfers)
      .where(eq(accountTransfers.id, sealed.id))
    expect(parcel).toMatchObject({ reads: 0, settledAt: null })

    expect((await open(sealed.id)).outcome).toBe('settled')
    expect(await getVaultEntry(db, recipientToken, recipient, 'inherited/handle')).toMatchObject({
      outcome: 'found',
      value: FIXTURE_VALUE,
    })
  })

  it('keeps the receipt after the giver stops holding the account', async () => {
    const sealed = await seal()
    if (sealed.outcome !== 'sealed') throw new Error(sealed.outcome)

    const settled = await open(sealed.id)
    if (settled.outcome !== 'settled') throw new Error(settled.outcome)

    // The giver's own record of the account goes; the evidence that it moved
    // does not, because the receipt references `agents` and never `accounts`.
    await db.insert(accounts).values({
      agentId: giver,
      kind: 'mailbox',
      identifier: 'handle-at-provider',
    })
    await db.delete(accounts).where(eq(accounts.agentId, giver))

    const kept = await db
      .select()
      .from(accountTransferReceipts)
      .where(eq(accountTransferReceipts.id, settled.receiptId))

    expect(kept).toHaveLength(1)
  })

  it('seals nothing when the deployment has no key', async () => {
    const sealed = await sealAccountTransfer(
      db,
      { fromAgentId: giver, toAgentId: recipient, vaultKey: 'provider/handle' },
      giverToken,
      undefined,
    )

    expect(sealed).toEqual({ outcome: 'unsealable' })
    expect(await db.select().from(accountTransfers)).toEqual([])
  })
})
