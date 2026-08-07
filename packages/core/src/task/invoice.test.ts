import { describe, expect, it } from 'vitest'
import { LAMPORTS_PER_SOL } from '../ledger/payments.js'
import {
  INVOICE_EXPIRY_DAYS,
  applyToInvoice,
  invoiceIsSettled,
  invoiceNotice,
  lamportsFromSol,
  questInvoiceLamports,
  questNeedsInvoice,
  unfundedWalletRefusal,
} from './invoice.js'

const aQuest = (lamports: number, slots = 10, publishObstacles = false) => ({
  reward: { lamports },
  slots,
  publishObstacles,
})

/** D-106 (`#504`). Capacity times price, plus the pool, and never a rounding up. */
describe('what a quest costs', () => {
  it('is capacity times price', () => {
    expect(questInvoiceLamports(aQuest(LAMPORTS_PER_SOL / 100, 10))).toBe(LAMPORTS_PER_SOL / 10)
  })

  /** The pool is added to the commitment rather than taken out of it (`#371`). */
  it('adds the obstacle pool rather than taking it out of the answers', () => {
    const withoutPool = questInvoiceLamports(aQuest(1_000_000, 10, false))
    const withPool = questInvoiceLamports(aQuest(1_000_000, 10, true))

    expect(withoutPool).toBe(10_000_000)
    expect(withPool).toBe(10_000_000 + 3 * 500_000)
  })

  /** A quest that pays reputation needs no invoice and goes live at publication. */
  it('is zero for a quest that pays no lamports, which needs no invoice', () => {
    expect(questInvoiceLamports(aQuest(0, 10, true))).toBe(0)
    expect(questNeedsInvoice(0)).toBe(false)
    expect(questNeedsInvoice(1)).toBe(true)
  })
})

describe('paying an invoice', () => {
  /** A transfer of at least the amount starts the quest. */
  it('is settled by the exact amount and by more', () => {
    expect(invoiceIsSettled(100, 100)).toBe(true)
    expect(invoiceIsSettled(101, 100)).toBe(true)
    expect(invoiceIsSettled(99, 100)).toBe(false)
  })

  /** Part payments accumulate: a sponsor that cannot pay in one go is not stuck. */
  it('accumulates a part payment and leaves the quest waiting', () => {
    const first = applyToInvoice(0, 100, 40)
    expect(first).toEqual({ applied: 40, surplus: 0 })
    expect(invoiceIsSettled(40, 100)).toBe(false)

    const second = applyToInvoice(40, 100, 60)
    expect(second).toEqual({ applied: 60, surplus: 0 })
    expect(invoiceIsSettled(100, 100)).toBe(true)
  })

  /**
   * Anything above the invoice is kept and does not extend the quest — said on
   * the invoice before the sponsor pays, because it is money it will not get
   * back.
   */
  it('keeps an over-payment rather than putting it on the quest', () => {
    expect(applyToInvoice(0, 100, 250)).toEqual({ applied: 100, surplus: 150 })
    expect(applyToInvoice(100, 100, 50)).toEqual({ applied: 0, surplus: 50 })
  })
})

describe('what the invoice says before anybody pays', () => {
  const notice = invoiceNotice({
    lamports: LAMPORTS_PER_SOL / 2,
    paidLamports: 0,
    walletAddress: 'CoLoNyWaLLeT',
  })

  it('names the amount and the address', () => {
    expect(notice).toContain('0.5 SOL')
    expect(notice).toContain('CoLoNyWaLLeT')
  })

  /** The four facts `#504` requires, each of which is otherwise found out late. */
  it('says payment must come from the sponsor own verified wallet', () => {
    expect(notice).toContain('solana-wallet')
  })

  it('says nothing is refundable and that unfilled capacity is not returned', () => {
    expect(notice).toContain('refundable')
    expect(notice).toContain('not returned at expiry')
  })

  it('says an over-payment is kept', () => {
    expect(notice).toContain('kept and does not extend the quest')
  })

  it('says how long it waits and what is forfeited', () => {
    expect(notice).toContain(String(INVOICE_EXPIRY_DAYS))
    expect(notice).toContain('forfeited')
  })

  it('shows what is outstanding once part of it is paid', () => {
    const part = invoiceNotice({
      lamports: LAMPORTS_PER_SOL,
      paidLamports: LAMPORTS_PER_SOL / 4,
      walletAddress: 'CoLoNyWaLLeT',
    })

    expect(part).toContain('0.25 SOL of it')
    expect(part).toContain('0.75 SOL is outstanding')
  })
})

/**
 * The commonest way this flow fails, and it fails silently from the agent's
 * side: an address that has never held SOL has no account on chain.
 */
describe('the refusal an unfunded wallet gets', () => {
  it('names the cause rather than reporting a payment that did not arrive', () => {
    const refusal = unfundedWalletRefusal('AnEmptyWallet')

    expect(refusal).toContain('AnEmptyWallet')
    expect(refusal).toContain('holds nothing')
    expect(refusal).toContain('fee')
    expect(refusal).toContain('never held SOL')
  })
})

describe('a price entered as SOL', () => {
  it('becomes integer lamports', () => {
    expect(lamportsFromSol('1')).toBe(LAMPORTS_PER_SOL)
    expect(lamportsFromSol('0.5')).toBe(LAMPORTS_PER_SOL / 2)
    expect(lamportsFromSol('0.00089088')).toBe(890_880)
  })

  /** Anything this cannot state exactly is refused rather than rounded. */
  it('refuses what it cannot state exactly', () => {
    expect(lamportsFromSol('0.0000000001')).toBeNull()
    expect(lamportsFromSol('1.2.3')).toBeNull()
    expect(lamportsFromSol('-1')).toBeNull()
    expect(lamportsFromSol('a lot')).toBeNull()
  })
})

/**
 * The two defects the first mainnet run found, each pinned by a test so the
 * next change has to break the test rather than the money (`#504`).
 */
describe('what the first real payment found', () => {
  /**
   * `paidQuestRejection` opened with `if (input.credits === 0) return undefined`,
   * which was true of every SOL-priced quest — so the precondition D-061 exists
   * for was skipped by the price moving to a different column.
   */
  it('does not let a quest escape the audit brake by paying in lamports', async () => {
    const { QUEST_AUDIT_OFF, paidQuestRejection } = await import('./quest-audit.js')

    expect(
      paidQuestRejection(QUEST_AUDIT_OFF, {
        credits: 0,
        lamports: 2_000_000,
        disagreement: 0,
        audited: 0,
      }),
    ).toContain('sampling')

    // A quest that pays nothing at all is still free to publish.
    expect(
      paidQuestRejection(QUEST_AUDIT_OFF, {
        credits: 0,
        lamports: 0,
        disagreement: 0,
        audited: 0,
      }),
    ).toBeUndefined()
  })
})
