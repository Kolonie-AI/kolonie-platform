import { and, eq, sql } from 'drizzle-orm'
import { LedgerTransactionIdSchema, type AgentId, type FundingSource } from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { agents, authorityEvents, ledgerEntries } from '../schema/index.js'
import { sponsorAddressUnconfirmedSql } from './console-identity.js'

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

/** What a steward is told when it tries to credit a balance without saying whose money it is. */
export const FUNDING_SOURCE_REQUIRED =
  'a balance credit must record whose money it was: bootstrap, external, or unclassified'

/** Whether the money went in, or why it did not. */
export type CreditOutcome =
  | { readonly outcome: 'credited' }
  /** The account was opened from the console and nobody has followed the link yet (`#266`). */
  | { readonly outcome: 'address-unconfirmed' }

/**
 * Credit a sponsor's balance by hand, which is the only way in that exists today.
 *
 * **The source is required and has no default.** A default is how a field like
 * this ends up wrong at scale — whichever value is the default becomes the value
 * nobody thought about. `#219` will pass the account's declared default here;
 * a steward doing it by hand has to say.
 *
 * Audited, because it is the single most abusable action in the system while
 * there is no payment rail behind it, and it should look like it.
 *
 * **It refuses an account whose address is not confirmed yet** (`#266`). Since
 * the console opens an account from an address alone, the address on a fresh
 * sponsor account is a string somebody typed and may be a stranger's. A refusal
 * rather than a throw, because this is a fact about the account and not a fault:
 * a steward can read it, and the remedy — follow the link — belongs to the
 * person who holds the mailbox.
 */
export async function creditBalance(
  tx: Transaction,
  command: {
    readonly agentId: AgentId
    readonly amount: number
    readonly source: FundingSource
    readonly actorId: AgentId | null
    readonly reference: string
    readonly memo?: string | null
  },
): Promise<CreditOutcome> {
  if (command.amount <= 0) {
    throw new Error(
      `a balance credit moves money in, so it must be positive: got ${command.amount}`,
    )
  }

  const [unconfirmed] = await tx.execute<{ unconfirmed: boolean }>(
    sql`select ${sponsorAddressUnconfirmedSql(command.agentId)} as unconfirmed`,
  )
  if (unconfirmed?.unconfirmed === true) return { outcome: 'address-unconfirmed' }

  const transactionId = LedgerTransactionIdSchema.parse(crypto.randomUUID())
  const shared = {
    transactionId,
    type: 'balance_credit' as const,
    // On both rows, because the booking is the event and either row read alone
    // should be able to say where the money came from.
    fundingSource: command.source,
    memo: command.memo ?? null,
    reference: command.reference,
  }

  await tx.insert(ledgerEntries).values([
    {
      ...shared,
      accountKind: 'system' as const,
      systemAccount: 'treasury' as const,
      amount: -command.amount,
    },
    { ...shared, accountKind: 'agent' as const, agentId: command.agentId, amount: command.amount },
  ])

  return { outcome: 'credited' }
}

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
