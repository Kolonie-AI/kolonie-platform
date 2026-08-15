import { and, eq, sql } from 'drizzle-orm'
import type { AgentId, FundingSource } from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { agents, authorityEvents, ledgerEntries } from '../schema/index.js'

/**
 * Whose money it was, recorded at the moment of the credit (`#220`).
 *
 * `governance/economy.md` §5 prices $KOL off **external** quest volume, and this
 * is the only place that number can honestly come from. It cannot be
 * reconstructed later: chain data shows an address, not whose money it was, and
 * bank records show a transfer, not what it was for.
 *
 * It is also the measurement of `kolonie-docs#16` — the first quest funded by a
 * credit whose source is `external` is the milestone that ends bootstrapping,
 * and it stops being a judgement call.
 */

/**
 * **`creditBalance` stood here and is gone** (`#945`), with `CreditOutcome` and
 * `FUNDING_SOURCE_REQUIRED`, which were its return type and its refusal text.
 *
 * It credited a sponsor's balance by hand and was described as *"the only way in
 * that exists today"*. That stopped being true and then stopped being reachable:
 * by the time this was read it had **no caller outside its own tests** — no
 * console form, no tool, no runner — so what the tests proved was that a function
 * nobody could invoke still worked.
 *
 * **Nothing about the rules it carried is lost, because none of them were its.**
 * *A credit says whose money it was* is a database constraint,
 * `ledger_entries_funding_source_iff_credit`, and `funding.test.ts` still asserts
 * it in both directions. *A console-opened account is not funded before its
 * address is confirmed* is `sponsorAddressUnconfirmedSql` (`#266`), which stays
 * exported and is now tested against directly in `console-identity.test.ts`
 * rather than through this — the rule outlives the one caller that happened to
 * apply it, and the rail `fundingSourceForDeposit` (`#219`) is written for will
 * have to apply it too.
 *
 * The readers below — `overrideCreditFundingSource`, `externalVolume` — are not
 * dead with it. They read `balance_credit` rows, which is what an automated
 * deposit writes; what has gone is the hand that wrote them one at a time.
 */

/**
 * Set what an account's deposits are classified as, and record who decided.
 *
 * The audit row carries the old value as well as the new one, in its own words —
 * `authority_events` has no free-text column by design, so the change is
 * readable from the pair of rows an account accumulates rather than from prose.
 */
export async function setAccountFundingSource(
  tx: Transaction,
  command: {
    readonly agentId: AgentId
    readonly source: FundingSource
    readonly actorId: AgentId
  },
): Promise<void> {
  await tx
    .update(agents)
    .set({ fundingSourceDefault: command.source })
    .where(eq(agents.id, command.agentId))

  await tx.insert(authorityEvents).values({
    actorId: command.actorId,
    action: 'funding-source-set' as const,
    subjectAgentId: command.agentId,
  })
}

/**
 * Reclassify one credit against its account's default, and record who decided.
 *
 * **Every entry of the booking moves together.** A transaction whose two rows
 * disagreed about whose money it was would make the external figure depend on
 * which row a query happened to sum.
 */
export async function overrideCreditFundingSource(
  tx: Transaction,
  command: {
    readonly transactionId: string
    readonly source: FundingSource
    readonly actorId: AgentId
  },
): Promise<number> {
  const updated = await tx
    .update(ledgerEntries)
    .set({ fundingSource: command.source })
    .where(
      and(
        eq(ledgerEntries.transactionId, command.transactionId),
        eq(ledgerEntries.type, 'balance_credit'),
      ),
    )
    .returning({ id: ledgerEntries.id })

  if (updated.length === 0) return 0

  const [credited] = await tx
    .select({ agentId: ledgerEntries.agentId })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.transactionId, command.transactionId),
        eq(ledgerEntries.accountKind, 'agent'),
      ),
    )
    .limit(1)

  await tx.insert(authorityEvents).values({
    actorId: command.actorId,
    action: 'funding-source-overridden' as const,
    subjectAgentId: (credited?.agentId ?? null) as AgentId | null,
  })

  return updated.length
}

/**
 * How much money the Colony has taken in from somebody other than the maintainer.
 *
 * **Computed by query, never stored.** A second place the total lives is a
 * second place it can be wrong — the same argument D-002 made, `#174` made for
 * reservations and `#175` made for slots.
 *
 * `unclassified` is excluded rather than counted optimistically. A credit nobody
 * has classified is not evidence of external demand, and counting it would make
 * the curve the coin is priced off flatter to the exact extent that the
 * bookkeeping was behind.
 */
export async function externalVolume(db: Database | Transaction): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amount}), 0)::text` })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.accountKind, 'agent'),
        eq(ledgerEntries.type, 'balance_credit'),
        eq(ledgerEntries.fundingSource, 'external'),
      ),
    )

  return Number(row?.total ?? 0)
}

/** What an account's deposits are classified as, or `null` if nobody has said. */
export async function accountFundingSource(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<FundingSource | null> {
  const [row] = await db
    .select({ source: agents.fundingSourceDefault })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1)

  return row?.source ?? null
}

/**
 * What an automated deposit for this account is credited as (`#219`).
 *
 * An account nobody has classified deposits as `unclassified`: the money lands,
 * and the credit does not count toward the external figure until a steward says
 * otherwise. Refusing the deposit instead would be a Colony that bounces a
 * sponsor's first payment over its own bookkeeping.
 */
export async function fundingSourceForDeposit(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<FundingSource> {
  return (await accountFundingSource(db, agentId)) ?? 'unclassified'
}
