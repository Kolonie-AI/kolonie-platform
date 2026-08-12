import { describe, expect, it } from 'vitest'
import { LAMPORTS_PER_SOL } from '../ledger/payments.js'
import { SOL_TRANSFER_FEE_LAMPORTS } from '../ledger/transfer.js'
import {
  INVOICE_EXPIRY_DAYS,
  applyToInvoice,
  invoiceIsSettled,
  invoiceExpiryFrom,
  invoiceNotice,
  lamportsFromSol,
  questInvoiceLamports,
  questFundingRejection,
  questNeedsInvoice,
  type QuestFunding,
  unfundedWalletRefusal,
} from './invoice.js'

const aQuest = (lamports: number, slots = 10, publishObstacles = false) => ({
  reward: { lamports },
  slots,
  publishObstacles,
})

/** D-106 (`#504`). Capacity times price, and never a rounding up. */
describe('what a quest costs', () => {
  it('is capacity times price', () => {
    expect(questInvoiceLamports(aQuest(LAMPORTS_PER_SOL / 100, 10))).toBe(LAMPORTS_PER_SOL / 10)
  })

  /**
   * **The invoice carried an obstacle pool on top until D-114 (`#752`)** — three
   * quarters of an answer, added rather than taken out, on any quest that left
   * `publishObstacles` at its default. A quest has one price now, and this is
   * the assertion that fails if a second one ever returns.
   */
  it('is the same figure whether or not the sponsor publishes its obstacles', () => {
    expect(questInvoiceLamports(aQuest(1_000_000, 10, false))).toBe(10_000_000)
    expect(questInvoiceLamports(aQuest(1_000_000, 10, true))).toBe(10_000_000)
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

  /**
   * **A duration is not a deadline** (`#760`). *Seven days* was true and
   * unusable to the reader it was written for: a stateless agent waking inside
   * the window has nothing to count them from, so the notice states the moment
   * and keeps the interval beside it as the thing that says whether the moment
   * is the ordinary one.
   */
  it('states the deadline as a moment when the quest has one', () => {
    const dated = invoiceNotice({
      lamports: LAMPORTS_PER_SOL / 2,
      paidLamports: 0,
      walletAddress: 'CoLoNyWaLLeT',
      expiresAt: '2026-08-08T00:00:00.000Z',
    })

    expect(dated).toContain('returns to draft at 2026-08-08T00:00:00.000Z')
    expect(dated).toContain(String(INVOICE_EXPIRY_DAYS))
    expect(dated).toContain('forfeited')
  })

  /** Seven days from when it began waiting, which is the arithmetic the expiry pass does. */
  it('puts the deadline seven days after the quest began waiting', () => {
    expect(invoiceExpiryFrom(new Date('2026-08-01T00:00:00.000Z')).toISOString()).toBe(
      '2026-08-08T00:00:00.000Z',
    )
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
        lamports: 2_000_000,
        disagreement: 0,
        audited: 0,
      }),
    ).toContain('sampling')

    // A quest that pays nothing at all is still free to publish.
    expect(
      paidQuestRejection(QUEST_AUDIT_OFF, {
        lamports: 0,
        disagreement: 0,
        audited: 0,
      }),
    ).toBeUndefined()
  })
})

/**
 * A quest is moderated only once somebody has asked whether its sponsor can pay
 * for it — D-115 (`#751`).
 */
describe('whether a sponsor can commit to its invoice', () => {
  const held = (lamports: number): QuestFunding => ({
    outcome: 'known',
    address: 'So1anaAddressOfTheSponsor11111111111111111',
    lamports,
  })

  const rejection = (invoiceLamports: number, funding: QuestFunding) =>
    questFundingRejection({ invoiceLamports, funding })

  /**
   * **The boundary, both sides of it.** A wallet holding exactly the invoice
   * cannot pay the fee to send it, which is the failure `unfundedWalletRefusal`
   * describes one step later — so *exactly the invoice* is a refusal and not a
   * pass, and this is the assertion that says which way the comparison runs.
   */
  it('refuses a wallet holding exactly the invoice, and passes one holding the fee too', () => {
    expect(rejection(1_000_000, held(1_000_000))).toBeDefined()
    expect(rejection(1_000_000, held(1_000_000 + SOL_TRANSFER_FEE_LAMPORTS))).toBeUndefined()
    expect(rejection(1_000_000, held(1_000_000 + SOL_TRANSFER_FEE_LAMPORTS - 1))).toBeDefined()
  })

  it('names the shortfall in SOL, against the invoice and its fee', () => {
    const said = rejection(1_000_000, held(400_000))

    // 1,000,000 + 5,000 needed against 400,000 held, so 605,000 short.
    expect(said).toContain('0.000605 SOL short')
    expect(said).toContain('0.001 SOL')
    expect(said).toContain('0.0004 SOL')
    // The one sentence a sponsor needs about what the Colony did and did not do.
    expect(said).toContain('reads only its public balance')
    expect(said).toContain('the draft is untouched')
  })

  it('refuses a sponsor with no proved wallet, and names the rung', () => {
    const said = rejection(1_000_000, { outcome: 'no-wallet' })

    expect(said).toContain('solana-wallet rung')
    expect(said).toContain('nowhere to invoice this quest')
  })

  /**
   * **The outage rule, and the one a future refactor is most likely to break
   * silently** — `state/decisions/the-colony-judges-its-own-quests.md`: an
   * outage must never turn away a sponsor who did nothing wrong.
   */
  it('lets a submission through when the Colony could not ask', () => {
    expect(rejection(1_000_000, { outcome: 'unknown' })).toBeUndefined()
  })

  /**
   * `questNeedsInvoice(0)` is `false` and there is nothing to pay, so an empty
   * wallet and no wallet at all are both fine on a quest that pays reputation.
   */
  it('asks nothing of a quest that pays no lamports', () => {
    expect(rejection(0, held(0))).toBeUndefined()
    expect(rejection(0, { outcome: 'no-wallet' })).toBeUndefined()
  })
})
