import { z } from 'zod'
import {
  AgentIdSchema,
  LedgerEntryIdSchema,
  LedgerTransactionIdSchema,
  type SubmissionId,
} from '../common/ids.js'
import { TimestampSchema } from '../common/time.js'

/**
 * **One Quest Credit is one US cent.** That is the peg, and it is stated here so
 * that no later reader has to infer it from an amount.
 *
 * `governance/economy.md` §1 draws three layers and puts exactly one of them on a
 * chain: reputation and Quest Credits live in this Postgres ledger and are not
 * transferable, and **$KOL lives on Solana and is**. What this ledger holds is
 * therefore *not* the coin, and the two must not share a word — a reader seeing
 * `reward_coins` on a quest would reasonably conclude the ledger holds the
 * tradeable thing, which is the exact conflation §1 exists to prevent. So from
 * `kolonie-platform#218` onward **"coin" means $KOL and $KOL is not in this
 * database.**
 *
 * Credits are integers. Always. Floating point cannot represent money without
 * drift — 0.1 + 0.2 is famously not 0.3 — so the cent is the smallest unit and
 * there are no decimals below it. This is the subunit the previous comment here
 * anticipated when it said the Colony would introduce one "rather than a
 * decimal"; a USD-denominated credit whose smallest unit was one whole dollar
 * could not express fifty cents.
 *
 * Amounts are signed: a credit is positive, a debit is negative.
 */
export const CreditAmountSchema = z.int()
export type CreditAmount = z.infer<typeof CreditAmountSchema>

/**
 * Accounts that are not agents.
 *
 * `mint`     — origin of newly created credits (rewards). Always goes negative.
 * `treasury` — the Colony's own holdings, spent via governance.
 * `faucet`   — pre-funded pool for Level 4 wallet tasks.
 */
export const SystemAccountSchema = z.enum(['mint', 'treasury', 'faucet'])
export type SystemAccount = z.infer<typeof SystemAccountSchema>

/**
 * Either side of a booking is an agent or a system account. Modelling this as a
 * discriminated union rather than a nullable `agentId` means "reward paid from
 * the mint" and "transfer from an agent" cannot be confused, and the compiler
 * forces every consumer to handle both.
 */
export const AccountRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent'), agentId: AgentIdSchema }),
  z.object({ kind: z.literal('system'), account: SystemAccountSchema }),
])
export type AccountRef = z.infer<typeof AccountRefSchema>

export const agentAccount = (agentId: z.infer<typeof AgentIdSchema>): AccountRef => ({
  kind: 'agent',
  agentId,
})

export const systemAccount = (account: SystemAccount): AccountRef => ({
  kind: 'system',
  account,
})

/** Why a booking happened. Every entry in the ledger is attributable. */
export const LedgerEntryTypeSchema = z.enum([
  'task_reward',
  'review_reward',
  'contribution_reward',
  'referral_commission',
  'task_funding',
  'task_payout',
  'feature_purchase',
  'proposal_stake',
  'proposal_stake_refund',
  'faucet_grant',
  'transfer',
  'adjustment',
])
export type LedgerEntryType = z.infer<typeof LedgerEntryTypeSchema>

export const LedgerEntrySchema = z.object({
  id: LedgerEntryIdSchema,
  /** Groups the entries that must be applied together. */
  transactionId: LedgerTransactionIdSchema,
  account: AccountRefSchema,
  amount: CreditAmountSchema,
  type: LedgerEntryTypeSchema,
  memo: z.string().max(500).nullable(),
  createdAt: TimestampSchema,
})
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>

/**
 * A ledger transaction is double-entry: it moves credits between accounts and the
 * amounts must sum to exactly zero.
 *
 * Creating a reward is therefore not "add 50 to the agent" but "debit 50 from
 * the mint, credit 50 to the agent". The upside is that the Colony's total
 * supply is auditable at any moment by summing every entry ever written — it
 * must equal the negative of the mint balance. A single-entry ledger cannot
 * answer "how many credits exist?" without trusting a counter.
 */
export const LedgerTransactionSchema = z.object({
  id: LedgerTransactionIdSchema,
  entries: z.array(LedgerEntrySchema).min(2),
  /** Free-form link to what caused this, e.g. a submission or proposal id. */
  reference: z.string().max(200).nullable(),
  createdAt: TimestampSchema,
})
export type LedgerTransaction = z.infer<typeof LedgerTransactionSchema>

/** Sum of the amounts of the given entries. */
export function sumEntries(entries: readonly Pick<LedgerEntry, 'amount'>[]): CreditAmount {
  return entries.reduce((total, entry) => total + entry.amount, 0)
}

/**
 * Whether a transaction obeys the double-entry invariant.
 *
 * The backend must refuse to persist a transaction for which this returns
 * `false` — that check is the whole reason the ledger can be trusted.
 */
export function isBalanced(transaction: Pick<LedgerTransaction, 'entries'>): boolean {
  return sumEntries(transaction.entries) === 0
}

/**
 * What a booking caused, written into `reference` in a form anyone can parse.
 *
 * `reference` is free-form by schema, and free-form is how an audit trail turns
 * into prose nobody can query. Every entry the Colony books against a submission
 * carries this exact string, so "which entries paid for submission X" is an
 * index lookup rather than a `like` over a column of sentences — and so the
 * uniqueness that makes a reward bookable once can be enforced on it.
 */
export const SUBMISSION_REFERENCE_PREFIX = 'submission:'

/** The `reference` every entry booked on a submission carries. */
export function submissionReference(submissionId: SubmissionId): string {
  return `${SUBMISSION_REFERENCE_PREFIX}${submissionId}`
}

/** Balance of a single account, given the entries that belong to it. */
export function balanceOf(entries: readonly Pick<LedgerEntry, 'amount'>[]): CreditAmount {
  return sumEntries(entries)
}
