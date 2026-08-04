import { z } from 'zod'
import {
  AgentIdSchema,
  LedgerEntryIdSchema,
  LedgerTransactionIdSchema,
  type SubmissionId,
  type TaskId,
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
 * `escrow`   — a published quest's reward, held between publication and payout.
 *
 * **One `escrow` account, not one per quest** (`#174`). Per-quest separation
 * comes from `reference`, which every entry already carries and which this
 * file's own comment sets the pattern for: *"a transaction is the set of rows
 * sharing a `transaction_id`; `reference` and `created_at` are carried on every
 * entry of the set."* An account per quest would be a schema that grows a row
 * per sponsor decision, and the balance of any one of them is a `where` clause
 * either way.
 */
export const SystemAccountSchema = z.enum(['mint', 'treasury', 'faucet', 'escrow'])
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
  /**
   * Money entering the Colony and landing on a sponsor's balance (`#220`).
   *
   * Its own type rather than an `adjustment`, because it is the one entry class
   * that has to carry `funding_source` — whether the money originated with the
   * maintainer or with somebody else. `adjustment` is the vocabulary for
   * corrections, and a correction is not a deposit.
   */
  'balance_credit',
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

/**
 * What everything a quest's escrow ever does is referenced by (`#174`).
 *
 * **Every entry about one quest starts with `quest:<id>:`**, so *what did this
 * quest's money do* is a prefix scan rather than a join — the same property
 * `submission:` was introduced for, one level up.
 *
 * **The three events have three different references, and that is what makes
 * them bookable once each.** A single partial unique index on
 * `(reference, account_kind) where type = 'task_funding'` then refuses a second
 * publication *and* a second refund, because the two carry different references
 * and each is two rows told apart by `account_kind` — exactly the shape
 * `ledger_entries_task_reward_unique` already uses. Sharing one reference across
 * funding and refund would have made that index refuse the refund, and dropping
 * the index would have left "publish twice" to a `select` followed by an
 * `insert`, which is a race as wide as the transaction.
 */
export const QUEST_REFERENCE_PREFIX = 'quest:'

/** Sponsor → escrow, when a steward publishes the quest. */
export function questFundingReference(taskId: TaskId): string {
  return `${QUEST_REFERENCE_PREFIX}${taskId}:funding`
}

/** Escrow → sponsor, for capacity that expired unspent. */
export function questRefundReference(taskId: TaskId): string {
  return `${QUEST_REFERENCE_PREFIX}${taskId}:refund`
}

/**
 * Escrow → citizen, for one accepted report.
 *
 * Carries the submission as well as the quest, because a payout is per report
 * and there are as many as the capacity — the quest half is what keeps the
 * prefix scan above complete, and the submission half is what makes each payout
 * bookable exactly once.
 */
export function questPayoutReference(taskId: TaskId, submissionId: SubmissionId): string {
  return `${QUEST_REFERENCE_PREFIX}${taskId}:payout:${submissionId}`
}

/**
 * Whose money it was, recorded at the moment of the credit and never inferred
 * afterwards (`#220`).
 *
 * `governance/economy.md` §5 prices $KOL off **external** quest volume, and
 * `kolonie-docs#128` replaced a fixed bootstrap ceiling with this record —
 * because the number was never what kept founder funding honest. The record is.
 *
 * > Friendship is not the test; origin is. A friend who spends their own
 * > USD 500 because they want the quest run is an external sponsor. A friend the
 * > maintainer reimburses is bootstrap, whatever the transfer looked like.
 *
 * **This cannot be reconstructed later.** Chain data shows an address, not whose
 * money it was. Bank records show a transfer, not what it was for. A year from
 * now the only honest answer to *"how much of that volume was real"* is the one
 * written at the time — and the Colony would be deceiving itself first and its
 * holders second.
 *
 * `unclassified` exists so that a deposit is never refused over bookkeeping. An
 * account whose default was never set credits as `unclassified`, the money
 * lands, and the credit does not count toward the external figure until a
 * steward classifies it. A Colony that bounces a sponsor's first payment because
 * a field was missing has chosen the wrong failure.
 */
export const FundingSourceSchema = z.enum(['bootstrap', 'external', 'unclassified'])
export type FundingSource = z.infer<typeof FundingSourceSchema>

/**
 * What a credit booked by an operator at the command line is referenced by
 * (`#316`).
 *
 * A deposit carries its signature and a quest carries its task, because both
 * have something outside the ledger to point at. A hand credit has nothing —
 * so it carries an id of its own, and the prefix is what makes *which credits
 * were typed in by a person* a prefix scan rather than a `like` over prose.
 *
 * That question is not the same as `funding_source = 'bootstrap'`, which is
 * about **whose money** it was. Once the deposit path is the ordinary way in,
 * bootstrap money will arrive by it too, and the distinction stops being
 * academic.
 */
export const HAND_CREDIT_REFERENCE_PREFIX = 'hand-credit:'

/** The `reference` a credit booked by hand carries. */
export function handCreditReference(id: string): string {
  return `${HAND_CREDIT_REFERENCE_PREFIX}${id}`
}

/** Balance of a single account, given the entries that belong to it. */
export function balanceOf(entries: readonly Pick<LedgerEntry, 'amount'>[]): CreditAmount {
  return sumEntries(entries)
}
