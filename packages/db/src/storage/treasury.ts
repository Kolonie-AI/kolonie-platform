import { eq, isNotNull, sql } from 'drizzle-orm'
import type { Database } from '../client.js'
import { payoutObligations, tasks, treasuryTransfers } from '../schema/index.js'

/**
 * What the Colony has earned, what it has already moved, and the record of the
 * moving — `#507`.
 *
 * **Nothing here sends anything**, exactly as `payouts.ts` sends nothing: this
 * counts, and the transfer is built, signed and submitted by the caller. It is
 * also the file where the one-way property is easiest to break by accident, so
 * it is stated at the top rather than left to a reader of the last function:
 *
 * > **The Colony holds no key for the Treasury and no function here takes one.**
 * > Every export below either reads a number or writes a receipt. There is no
 * > path that sends *from* the Treasury address, and `treasury.test.ts` in
 * > `apps/api` asserts that on the exports rather than trusting this paragraph.
 */

/**
 * The fee the Colony has earned, in lamports, across every accepted report.
 *
 * ## Derived, because nothing books it
 *
 * The SOL path records the citizen's obligation and not the Colony's share —
 * `payout_obligations.lamports` is *"the citizen's share; the Colony's fee is
 * not in this table"*. So the fee is the difference between what the quest
 * priced a report at and what the citizen was owed for it, per report, computed
 * against `platform_fee_percent` as it stood when the quest was published.
 *
 * **The subtraction is the point.** Recomputing `questPayoutSplit` here would be
 * a second implementation of the split, and `#553` records what that costs: the
 * price moved to `reward_lamports` while a rule still read `reward_credits`, and
 * three defects in one afternoon were all that same mistake. The obligation
 * already holds the citizen's side, computed once by the one function that
 * computes it, so the Colony's side is whatever is left.
 *
 * ## A forfeited obligation is earned too
 *
 * When a citizen erases itself owed less than the chain can deliver, the amount
 * is written off **to the Treasury** (`erasure.md`, and `forfeit` on the payout
 * desk). That is the Colony keeping money it was going to pay out, so it belongs
 * in this number — leaving it out would mean the Colony holds lamports that no
 * arithmetic here can ever account for, which is the state a sweep is supposed
 * to end.
 *
 * ## What is deliberately not counted
 *
 * **Quarantined payments.** Money that arrived and could not be attributed to
 * anybody is not income — it belongs to whoever sent it and a maintainer
 * resolves it by hand (`colony-payments.ts`). Sweeping it to the Treasury would
 * be the Colony taking a stranger's money because it could not read the sender.
 */
export async function earnedFeeLamports(db: Database): Promise<number> {
  const [row] = await db
    .select({
      /**
       * `reward_lamports - lamports` for the fee, plus the whole obligation
       * where it was forfeited. Both legs in one statement, because two reads
       * would let an obligation be forfeited between them and be counted twice.
       */
      earned: sql<string>`coalesce(sum(
        greatest(coalesce(${tasks.rewardLamports}, 0) - ${payoutObligations.lamports}, 0)
        + case when ${payoutObligations.forfeitedAt} is null then 0
               else ${payoutObligations.lamports} end
      ), 0)`,
    })
    .from(payoutObligations)
    .innerJoin(tasks, eq(tasks.id, payoutObligations.taskId))

  return Number(row?.earned ?? 0)
}

/** Everything already moved to the Treasury, in lamports. */
export async function sweptToTreasuryLamports(db: Database): Promise<number> {
  const [row] = await db
    .select({ swept: sql<string>`coalesce(sum(${treasuryTransfers.lamports}), 0)` })
    .from(treasuryTransfers)

  return Number(row?.swept ?? 0)
}

/** When the last sweep went out, or `undefined` if none ever has. */
export async function lastTreasurySweepAt(db: Database): Promise<string | undefined> {
  const [row] = await db
    .select({ at: treasuryTransfers.createdAt })
    .from(treasuryTransfers)
    .orderBy(sql`${treasuryTransfers.createdAt} desc`)
    .limit(1)

  return row?.at
}

/**
 * Record a transfer that has already gone out.
 *
 * **After the signature and never before.** A row written ahead of the send
 * would subtract, on a failed send, money that never moved — stranding it in the
 * hot wallet permanently, because nothing would ever count it as sweepable
 * again. `#505` refused the mirror of this by never marking a report paid on a
 * call that returned an error.
 *
 * Returns `false` where the signature was already recorded, which is what makes
 * a timer firing twice harmless.
 */
export async function recordTreasurySweep(
  db: Database,
  command: {
    readonly lamports: number
    readonly signature: string
    readonly address: string
  },
): Promise<boolean> {
  const inserted = await db
    .insert(treasuryTransfers)
    .values({
      lamports: command.lamports,
      signature: command.signature,
      address: command.address,
    })
    .onConflictDoNothing({ target: treasuryTransfers.signature })
    .returning({ id: treasuryTransfers.id })

  return inserted.length > 0
}

/** What the Colony still owes citizens, in lamports — unpaid, unforfeited. */
export async function outstandingObligationLamports(db: Database): Promise<number> {
  const [row] = await db
    .select({ owed: sql<string>`coalesce(sum(${payoutObligations.lamports}), 0)` })
    .from(payoutObligations)
    .where(sql`${payoutObligations.paidAt} is null and ${payoutObligations.forfeitedAt} is null`)

  return Number(row?.owed ?? 0)
}

/** Every sweep, newest first — what a maintainer reads to see the money leaving. */
export interface TreasuryTransfer {
  readonly lamports: number
  readonly signature: string
  readonly address: string
  readonly at: string
}

export async function treasuryTransfersMade(
  db: Database,
  limit = 50,
): Promise<readonly TreasuryTransfer[]> {
  const rows = await db
    .select({
      lamports: treasuryTransfers.lamports,
      signature: treasuryTransfers.signature,
      address: treasuryTransfers.address,
      at: treasuryTransfers.createdAt,
    })
    .from(treasuryTransfers)
    .where(isNotNull(treasuryTransfers.signature))
    .orderBy(sql`${treasuryTransfers.createdAt} desc`)
    .limit(limit)

  return rows.map((row) => ({ ...row, lamports: Number(row.lamports) }))
}
