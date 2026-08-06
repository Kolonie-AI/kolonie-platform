import { generateKeyPairSync } from 'node:crypto'
import { and, desc, eq, sql } from 'drizzle-orm'
import {
  LedgerTransactionIdSchema,
  creditsFromUsdc,
  depositRejection,
  encodeBase58,
  type AgentId,
  type Deposit,
  type ObservedTransfer,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { sealVaultValue } from '../vault-crypto.js'
import { depositAddresses, deposits, ledgerEntries } from '../schema/index.js'
import { sponsorAddressUnconfirmedSql } from './console-identity.js'
import { toTimestamp } from './rows.js'

/**
 * The way in: a sponsor sends USDC to its own address and the balance answers
 * (`#219`).
 *
 * **Nothing here can move value out of the Colony.** There is no function in
 * this file that debits an agent, no outbound transfer, and no path to one —
 * that leg is `#222` and is conditional on legal advice `kolonie-docs#129`
 * sequences to it. A test asserts the exported surface contains no such
 * operation.
 */

/** The keypair a deposit address is, as this module needs it. */
export interface DepositKeypair {
  readonly address: string
  /** The private key, base58, on its way into the seal and nowhere else. */
  readonly secret: string
}

/**
 * A fresh Ed25519 keypair, which is what a Solana address is.
 *
 * Node's own crypto rather than a Solana library: an address is the raw 32-byte
 * public key in base58, `encodeBase58` is already in core for the wallet rung,
 * and a dependency that pulls a chain client into `packages/db` to generate two
 * buffers would be a dependency to keep patched for no capability.
 *
 * The DER prefix is fixed for Ed25519 SPKI — twelve bytes of algorithm
 * identifier, then the key — which is why the slice is a constant and not a
 * parse.
 */
export function generateDepositKeypair(): DepositKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' })

  return {
    address: encodeBase58(new Uint8Array(spki.subarray(spki.length - 32))),
    secret: encodeBase58(new Uint8Array(pkcs8.subarray(pkcs8.length - 32))),
  }
}

/** A deposit address, or the reason there is none. */
export type DepositAddressOutcome =
  | { readonly outcome: 'issued'; readonly address: string }
  /** Opened from the console, and nobody has followed the sign-in link yet (`#266`). */
  | { readonly outcome: 'address-unconfirmed' }

/**
 * This identity's deposit address, generated on first use.
 *
 * **Generated rather than assigned**, and once: the unique index on `agent_id`
 * is what makes a second call return the first address rather than a second one.
 * A sponsor that sent to an address the Colony had forgotten would be a
 * deposit nobody could attribute, which is the failure the per-sponsor keypair
 * exists to remove.
 *
 * ## An unconfirmed console account gets no address, and this is where funding
 * is actually stopped
 *
 * `#266` requires the sign-up address to be confirmed before anything can be
 * funded, and there are two doors: a steward's hand credit, which
 * {@link creditBalance} refuses, and a transfer on chain, which this one closes.
 *
 * **It is closed here rather than at the credit**, because a transfer that has
 * already settled is money the Colony holds the key to, and refusing to credit
 * it would strand a real payment in a real address. An account that never
 * received an address can never be in that position — the refusal is free
 * exactly once, and this is the moment.
 */
export async function depositAddressFor(
  db: Database,
  command: {
    readonly agentId: AgentId
    /**
     * The Colony's own sealing key, read from the environment by the caller.
     *
     * A parameter and not a read inside this function, for the reason
     * `eraseAgent`'s `banSalt` is one: a process wired without it must fail at
     * startup where an operator is looking, rather than at the first deposit
     * address of the first sponsor.
     */
    readonly sealingKey: string
  },
): Promise<DepositAddressOutcome> {
  const [existing] = await db
    .select({ address: depositAddresses.address })
    .from(depositAddresses)
    .where(eq(depositAddresses.agentId, command.agentId))
    .limit(1)

  // An address already handed out stays handed out. Whatever the account's state
  // is today, a sponsor may already have written that string down, and an
  // address the Colony stops acknowledging is the deposit nobody can attribute.
  if (existing !== undefined) return { outcome: 'issued', address: existing.address }

  const [unconfirmed] = await db.execute<{ unconfirmed: boolean }>(
    sql`select ${sponsorAddressUnconfirmedSql(command.agentId)} as unconfirmed`,
  )
  if (unconfirmed?.unconfirmed === true) return { outcome: 'address-unconfirmed' }

  const keypair = generateDepositKeypair()

  const [row] = await db
    .insert(depositAddresses)
    .values({
      agentId: command.agentId,
      address: keypair.address,
      secretSealed: sealVaultValue(
        command.sealingKey,
        command.agentId,
        'deposit-address',
        keypair.secret,
      ),
    })
    .onConflictDoNothing({ target: depositAddresses.agentId })
    .returning({ address: depositAddresses.address })

  if (row !== undefined) return { outcome: 'issued', address: row.address }

  // Two requests raced and the other won. Its address is the one to hand back:
  // the loser's keypair is discarded unused, which is the only correct outcome —
  // an address nobody was told about can receive nothing.
  const [winner] = await db
    .select({ address: depositAddresses.address })
    .from(depositAddresses)
    .where(eq(depositAddresses.agentId, command.agentId))
    .limit(1)

  if (winner === undefined) throw new Error('a deposit address was neither inserted nor found')

  return { outcome: 'issued', address: winner.address }
}

/** What recording an observed transfer came to. */
export type DepositOutcome =
  | { readonly outcome: 'credited'; readonly credits: number; readonly remainder: number }
  /** Recorded, and nothing credited. The reason is on the row and the sponsor reads it. */
  | { readonly outcome: 'refused'; readonly rejection: string }
  /** Seen before. Webhook redelivery is normal operation, not an incident. */
  | { readonly outcome: 'already-recorded' }
  /** Not `finalized`. Nothing is written at all — the transfer may still vanish. */
  | { readonly outcome: 'not-final' }

/**
 * Credit an observed transfer, or record why it was not credited.
 *
 * **The deposit row and the ledger credit commit in one transaction.** A deposit
 * row without its credit is money the Colony received and did not honour, which
 * is the failure this whole path exists to make impossible.
 *
 * **Idempotent by signature, in the database.** The unique index refuses the
 * second write; this function reads that refusal as `already-recorded` rather
 * than as an error, because a redelivered webhook is the expected case.
 *
 * **Nothing is written for a transfer that is not `finalized`.** A
 * confirmed-but-not-finalized transfer can still disappear, and a row saying it
 * arrived would have to be deleted afterwards — which is a worse record than no
 * record.
 */
export async function recordDeposit(
  db: Database,
  transfer: ObservedTransfer,
): Promise<DepositOutcome> {
  const rejection = depositRejection(transfer)
  if (rejection === 'not-final') return { outcome: 'not-final' }

  return await db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ agentId: depositAddresses.agentId })
      .from(depositAddresses)
      .where(eq(depositAddresses.address, transfer.address))
      .limit(1)

    const { credits, remainder } = creditsFromUsdc(transfer.baseUnits)
    const refusal = owner === undefined ? 'unknown-address' : rejection

    const [row] = await tx
      .insert(deposits)
      .values({
        signature: transfer.signature,
        ...(owner !== undefined && { agentId: owner.agentId }),
        address: transfer.address,
        baseUnits: transfer.baseUnits,
        credits: refusal === undefined ? credits : 0,
        remainder: refusal === undefined ? remainder : transfer.baseUnits,
        ...(refusal === undefined ? { creditedAt: sql`now()` } : { rejection: refusal }),
      })
      .onConflictDoNothing({ target: deposits.signature })
      .returning({ id: deposits.id })

    if (row === undefined) return { outcome: 'already-recorded' as const }
    if (refusal !== undefined) return { outcome: 'refused' as const, rejection: refusal }

    /**
     * Both legs, sharing a transaction id, exactly as every other booking is
     * written. **`funding_source` is `external`** and it is not optional:
     * `ledger_entries_funding_source_iff_credit` refuses a `balance_credit`
     * without one, and this is the path that finally has money whose origin is
     * genuinely outside the Colony (`#220`).
     */
    const transactionId = LedgerTransactionIdSchema.parse(crypto.randomUUID())
    await tx.insert(ledgerEntries).values([
      {
        transactionId,
        accountKind: 'system' as const,
        systemAccount: 'mint' as const,
        amount: -credits,
        type: 'balance_credit' as const,
        fundingSource: 'external' as const,
        memo: 'USDC deposit',
        reference: depositReference(transfer.signature),
      },
      {
        transactionId,
        accountKind: 'agent' as const,
        agentId: owner!.agentId,
        amount: credits,
        type: 'balance_credit' as const,
        fundingSource: 'external' as const,
        memo: 'USDC deposit',
        reference: depositReference(transfer.signature),
      },
    ])

    return { outcome: 'credited' as const, credits, remainder }
  })
}

/**
 * What a deposit's ledger entries are keyed on.
 *
 * The signature, so an auditor holding a transaction can find the credit it
 * became without joining anything — and so a second booking against the same
 * signature would be visible in the ledger even if the deposit row were somehow
 * written twice.
 */
export function depositReference(signature: string): string {
  return `deposit:${signature}`
}

/**
 * The address this identity already holds, or nothing (`#470`).
 *
 * **The whole point is what it does not do.** {@link depositAddressFor} answers
 * the same question and generates a keypair when the answer is *none*, which is
 * correct for an identity asking on its own behalf and wrong for a reader. The
 * agent page is read by the person who operates an agent, and `#457` allows them
 * to read it and not to act for it — generating an address on a page load would
 * be the console taking a step the agent never took, and it would do so on a
 * `GET`.
 *
 * So this is a select and can never be anything else. Not a parameter on the
 * function above: a flag that switches off the write is a flag somebody passes
 * wrongly once.
 */
export async function existingDepositAddress(
  db: Database,
  agentId: AgentId,
): Promise<string | undefined> {
  const [row] = await db
    .select({ address: depositAddresses.address })
    .from(depositAddresses)
    .where(eq(depositAddresses.agentId, agentId))
    .limit(1)

  return row?.address
}

/** Every arrival at this identity's address, newest first, credited or not. */
export async function depositHistory(db: Database, agentId: AgentId): Promise<readonly Deposit[]> {
  const rows = await db
    .select()
    .from(deposits)
    .where(eq(deposits.agentId, agentId))
    .orderBy(desc(deposits.observedAt))

  return rows.map((row) => ({
    signature: row.signature,
    baseUnits: row.baseUnits,
    credits: row.credits,
    remainder: row.remainder,
    observedAt: toTimestamp(row.observedAt),
    creditedAt: row.creditedAt === null ? null : toTimestamp(row.creditedAt),
    rejection: row.rejection as Deposit['rejection'],
  }))
}

/** Every address the Colony is watching, for the reconciliation pass. */
export async function watchedDepositAddresses(db: Database): Promise<readonly string[]> {
  const rows = await db.select({ address: depositAddresses.address }).from(depositAddresses)
  return rows.map((row) => row.address)
}

/** Whether this signature has already been recorded, credited or refused. */
export async function depositRecorded(db: Database, signature: string): Promise<boolean> {
  const [row] = await db
    .select({ id: deposits.id })
    .from(deposits)
    .where(eq(deposits.signature, signature))
    .limit(1)

  return row !== undefined
}

/**
 * What the sponsor's balance and its deposits add up to, for the reconciliation
 * a human does rather than the job.
 *
 * Exported because *"the deposit total and the credit total disagree"* has to be
 * a query somebody can run, not an arithmetic argument in a comment.
 */
export async function depositTotals(
  db: Database,
  agentId: AgentId,
): Promise<{ readonly baseUnits: number; readonly credits: number; readonly remainder: number }> {
  const [row] = await db
    .select({
      baseUnits: sql<string>`coalesce(sum(${deposits.baseUnits}), 0)::text`,
      credits: sql<string>`coalesce(sum(${deposits.credits}), 0)::text`,
      remainder: sql<string>`coalesce(sum(${deposits.remainder}), 0)::text`,
    })
    .from(deposits)
    .where(and(eq(deposits.agentId, agentId), sql`${deposits.creditedAt} is not null`))

  return {
    baseUnits: Number(row?.baseUnits ?? 0),
    credits: Number(row?.credits ?? 0),
    remainder: Number(row?.remainder ?? 0),
  }
}
