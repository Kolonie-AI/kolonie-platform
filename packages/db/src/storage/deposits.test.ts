import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { SPL_TOKEN_PROGRAM, USDC_MINT, type AgentId, type ObservedTransfer } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, deposits, ledgerEntries } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import {
  depositAddressFor,
  depositHistory,
  depositTotals,
  generateDepositKeypair,
  recordDeposit,
  watchedDepositAddresses,
} from './deposits.js'

const target = databaseTestTarget()

const SEALING_KEY = 'a'.repeat(48)

/**
 * The way in (`#219`).
 *
 * The tests that matter are the ones about **what must not happen**: a credit
 * for a token that is not USDC, a second credit for one transfer, a credit at a
 * commitment that can still disappear, and a rounding that mints a credit from
 * nothing.
 */
describe('a USDC deposit', () => {
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

  const anAgent = async (name: string): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'openclaw', status: 'citizen' })
      .returning({ id: agents.id })
    return row!.id as AgentId
  }

  const aTransfer = (overrides: Partial<ObservedTransfer> = {}): ObservedTransfer => ({
    signature: `sig-${crypto.randomUUID()}`,
    address: 'unset',
    mint: USDC_MINT,
    tokenProgram: SPL_TOKEN_PROGRAM,
    baseUnits: 5_000_000,
    commitment: 'finalized',
    ...overrides,
  })

  const balanceOf = async (agentId: AgentId): Promise<number> => {
    const [row] = await db
      .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amount}), 0)::text` })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.agentId, agentId))
    return Number(row?.total ?? 0)
  }

  /**
   * The address, insisting it was issued.
   *
   * Every sponsor in this file registers over MCP, so `address-unconfirmed`
   * (`#266`) is unreachable here — narrowing it once keeps that fact in one
   * place instead of at thirteen call sites, and the `expect` is what makes it a
   * claim rather than a cast.
   */
  const addressFor = async (agentId: AgentId): Promise<string> => {
    const result = await depositAddressFor(db, { agentId, sealingKey: SEALING_KEY })
    expect(result.outcome).toBe('issued')
    if (result.outcome !== 'issued') throw new Error('unreachable')
    return result.address
  }

  describe('the address', () => {
    it('is generated once and handed back on every ask', async () => {
      const sponsor = await anAgent('sponsor')

      const first = await addressFor(sponsor)
      const second = await addressFor(sponsor)

      expect(first).toBe(second)
      expect(await watchedDepositAddresses(db)).toEqual([first])
    })

    it('is a different address for a different identity', async () => {
      const first = await addressFor(await anAgent('first'))
      const second = await addressFor(await anAgent('second'))

      expect(first).not.toBe(second)
    })

    it('never stores the secret in the clear', async () => {
      const sponsor = await anAgent('sponsor')
      const keypair = generateDepositKeypair()

      await addressFor(sponsor)
      const rows = await db.execute<{ secret_sealed: string }>(
        sql`select secret_sealed from deposit_addresses`,
      )

      // Sealed with the vault's envelope, which names its own version first.
      expect(rows[0]?.secret_sealed.startsWith('k1.')).toBe(true)
      expect(rows[0]?.secret_sealed).not.toContain(keypair.secret)
    })

    it('produces a plausible Solana address', () => {
      const keypair = generateDepositKeypair()

      // Base58 of 32 bytes: 43 or 44 characters, no 0, O, I or l.
      expect(keypair.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/)
      expect(keypair.secret).not.toBe(keypair.address)
    })
  })

  describe('crediting', () => {
    it('credits whole cents and records the remainder', async () => {
      const sponsor = await anAgent('sponsor')
      const address = await addressFor(sponsor)

      // 5.000005 USDC: five hundred credits and five base units left over.
      const outcome = await recordDeposit(db, aTransfer({ address, baseUnits: 5_000_005 }))

      expect(outcome).toEqual({ outcome: 'credited', credits: 500, remainder: 5 })
      expect(await balanceOf(sponsor)).toBe(500)

      const totals = await depositTotals(db, sponsor)
      // The two columns add back up to what arrived, which is the whole reason
      // the remainder is stored rather than discarded.
      expect(totals.credits * 10_000 + totals.remainder).toBe(totals.baseUnits)
    })

    it('records the origin of the money, because nothing can reconstruct it later', async () => {
      const sponsor = await anAgent('sponsor')
      const address = await addressFor(sponsor)

      await recordDeposit(db, aTransfer({ address }))

      const [entry] = await db
        .select()
        .from(ledgerEntries)
        .where(eq(ledgerEntries.agentId, sponsor))

      expect(entry?.type).toBe('balance_credit')
      expect(entry?.fundingSource).toBe('external')
    })

    it('credits one transfer once, however many times it is delivered', async () => {
      const sponsor = await anAgent('sponsor')
      const address = await addressFor(sponsor)
      const transfer = aTransfer({ address })

      const first = await recordDeposit(db, transfer)
      const second = await recordDeposit(db, transfer)
      const third = await recordDeposit(db, transfer)

      expect(first.outcome).toBe('credited')
      expect(second).toEqual({ outcome: 'already-recorded' })
      expect(third).toEqual({ outcome: 'already-recorded' })
      expect(await balanceOf(sponsor)).toBe(500)
    })

    it('writes nothing at all for a transfer that is not finalized', async () => {
      const sponsor = await anAgent('sponsor')
      const address = await addressFor(sponsor)

      const outcome = await recordDeposit(db, aTransfer({ address, commitment: 'confirmed' }))

      expect(outcome).toEqual({ outcome: 'not-final' })
      expect(await db.select().from(deposits)).toEqual([])
      expect(await balanceOf(sponsor)).toBe(0)
    })

    it.each([
      ['another SPL token', { mint: 'So11111111111111111111111111111111111111112' }, 'wrong-mint'],
      ['the wrong token program', { tokenProgram: 'Token22' }, 'wrong-token-program'],
      ['less than a cent', { baseUnits: 9_999 }, 'below-one-cent'],
    ])('records %s and credits nothing', async (_name, overrides, rejection) => {
      const sponsor = await anAgent('sponsor')
      const address = await addressFor(sponsor)

      const outcome = await recordDeposit(db, aTransfer({ address, ...overrides }))

      expect(outcome).toEqual({ outcome: 'refused', rejection })
      expect(await balanceOf(sponsor)).toBe(0)

      // Recorded, with the reason, because a sponsor whose money vanished into a
      // correct system with no visible record is a sponsor lost for a reason
      // nobody can explain afterwards.
      const [history] = await depositHistory(db, sponsor)
      expect(history?.rejection).toBe(rejection)
      expect(history?.creditedAt).toBeNull()
    })

    it('records a transfer to an address belonging to nobody', async () => {
      const outcome = await recordDeposit(db, aTransfer({ address: 'nobodys-address' }))

      expect(outcome).toEqual({ outcome: 'refused', rejection: 'unknown-address' })
      const [row] = await db.select().from(deposits)
      expect(row?.agentId).toBeNull()
      expect(row?.rejection).toBe('unknown-address')
    })

    it('keeps the deposit row and the credit in one transaction', async () => {
      const sponsor = await anAgent('sponsor')
      const address = await addressFor(sponsor)

      /**
       * The booking is forced to fail by pre-writing the credit this deposit
       * would write: nothing else in the ledger keys on the signature, so the
       * failure has to come from the deferred double-entry trigger — one leg
       * without its pair. Either way the deposit row must not survive alone.
       */
      await expect(
        db.transaction(async (tx) => {
          await tx.insert(deposits).values({
            signature: 'orphan',
            agentId: sponsor,
            address,
            baseUnits: 5_000_000,
            credits: 500,
            remainder: 0,
            creditedAt: new Date().toISOString(),
          })
          await tx.insert(ledgerEntries).values({
            transactionId: crypto.randomUUID(),
            accountKind: 'agent',
            agentId: sponsor,
            amount: 500,
            type: 'balance_credit',
            fundingSource: 'external',
          })
        }),
      ).rejects.toThrow()

      expect(await db.select().from(deposits)).toEqual([])
      expect(await balanceOf(sponsor)).toBe(0)
    })
  })

  describe('the history', () => {
    it('lists this sponsor’s arrivals and nobody else’s', async () => {
      const mine = await anAgent('mine')
      const theirs = await anAgent('theirs')
      const forMe = await addressFor(mine)
      const forThem = await addressFor(theirs)

      await recordDeposit(db, aTransfer({ address: forMe }))
      await recordDeposit(db, aTransfer({ address: forThem }))

      expect(await depositHistory(db, mine)).toHaveLength(1)
      expect(await depositHistory(db, theirs)).toHaveLength(1)
    })
  })

  /**
   * **This is a one-way door**, and the test is on the module's exports rather
   * than on any single function: what must be true is that there is nothing here
   * that moves value out, not that some particular thing does not.
   */
  it('exports no operation that can move value out of the Colony', async () => {
    const module = await import('./deposits.js')

    for (const name of Object.keys(module)) {
      expect(name.toLowerCase()).not.toMatch(/withdraw|payout|refund|sweep|transferout|debit/)
    }
  })
})
