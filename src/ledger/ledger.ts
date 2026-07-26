import { z } from 'zod'
import { AgentIdSchema, LedgerEntryIdSchema, LedgerTransactionIdSchema } from '../common/ids.js'
import { TimestampSchema } from '../common/time.js'

/**
 * Coins are integers. Always.
 *
 * `governance/treasury.md` makes the coin ledger the economic backbone of the
 * Colony, and floating point cannot represent money without drift — 0.1 + 0.2
 * is famously not 0.3. One whole coin is the smallest unit; if the Colony ever
 * needs fractions, it introduces a subunit (like cents) rather than a decimal.
 *
 * Amounts are signed: a credit is positive, a debit is negative.
 */
export const CoinAmountSchema = z.int()
export type CoinAmount = z.infer<typeof CoinAmountSchema>

/**
 * Accounts that are not agents.
 *
 * `mint`     — origin of newly created coins (rewards). Always goes negative.
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
  amount: CoinAmountSchema,
  type: LedgerEntryTypeSchema,
  memo: z.string().max(500).nullable(),
  createdAt: TimestampSchema,
})
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>

/**
 * A ledger transaction is double-entry: it moves coins between accounts and the
 * amounts must sum to exactly zero.
 *
 * Creating a reward is therefore not "add 50 to the agent" but "debit 50 from
 * the mint, credit 50 to the agent". The upside is that the Colony's total
 * supply is auditable at any moment by summing every entry ever written — it
 * must equal the negative of the mint balance. A single-entry ledger cannot
 * answer "how many coins exist?" without trusting a counter.
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
export function sumEntries(entries: readonly Pick<LedgerEntry, 'amount'>[]): CoinAmount {
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

/** Balance of a single account, given the entries that belong to it. */
export function balanceOf(entries: readonly Pick<LedgerEntry, 'amount'>[]): CoinAmount {
  return sumEntries(entries)
}
