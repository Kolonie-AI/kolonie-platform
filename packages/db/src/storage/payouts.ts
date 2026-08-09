import { and, asc, desc, eq, gte, isNull, sql } from 'drizzle-orm'
import {
  PayoutRefusalSchema,
  type AgentId,
  type PayoutRefusal,
  type SubmissionId,
  type TaskId,
  QUEST_OBSTACLE_BONUS_WINNERS,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { payoutObligations, solanaWalletChallenges, tasks } from '../schema/index.js'
import { and as andSql } from 'drizzle-orm'

/**
 * What the Colony owes and whether it has paid — D-106 (`#505`).
 *
 * **Nothing here sends anything.** It records what is owed, what was paid and
 * what stopped a payment; the transfer itself is built, signed and submitted by
 * the caller, which is the one place a key and an endpoint are named.
 */

/** An amount owed, as the runner reads it. */
export interface OutstandingPayout {
  readonly id: string
  /** Null once the citizen has erased itself. The debt outlives it. */
  readonly agentId: AgentId | null
  readonly submissionId: SubmissionId
  readonly lamports: number
  /** Where it goes: the address the citizen had verified when this was accepted. */
  readonly address: string | null
  readonly attempts: number
  /** Whether the citizen has since erased itself. */
  readonly erased: boolean
}

/**
 * Record what an accepted report owes its author.
 *
 * **In the verdict's own transaction**, which is the rule every other booking on
 * this path already follows: a report accepted and not recorded as owed would be
 * a debt the Colony cannot find. The unique index on the submission is what makes
 * a replayed verdict harmless.
 *
 * Returns the obligation's id, or `undefined` when there already was one.
 */
export async function oweForReport(
  tx: Transaction,
  command: {
    readonly agentId: AgentId
    readonly taskId: TaskId
    readonly submissionId: SubmissionId
    readonly lamports: number
  },
): Promise<string | undefined> {
  if (command.lamports <= 0) return undefined

  /**
   * The destination, read here and written onto the row.
   *
   * **Read once, at acceptance, rather than at every payout attempt.** It fixes
   * the payout to the wallet in force when the work was accepted, and it is what
   * lets the debt outlive an erasure — see `address` on the schema.
   */
  const [verified] = await tx
    .select({ address: solanaWalletChallenges.address })
    .from(solanaWalletChallenges)
    .where(
      andSql(
        eq(solanaWalletChallenges.agentId, command.agentId),
        sql`${solanaWalletChallenges.verifiedAt} is not null`,
      ),
    )
    .limit(1)

  const [row] = await tx
    .insert(payoutObligations)
    .values({
      agentId: command.agentId,
      taskId: command.taskId,
      submissionId: command.submissionId,
      lamports: command.lamports,
      ...(verified?.address != null && { address: verified.address }),
    })
    /**
     * **Untargeted, because the index it arbitrates on is partial** (`#553`
     * phase C). `payout_obligations_submission_unique` gained
     * `where submission_id is not null` when a review row stopped having one,
     * and Postgres refuses to infer a partial index as an arbiter unless the
     * statement repeats the predicate: `42P10 there is no unique or exclusion
     * constraint matching the ON CONFLICT specification`. Naming no target
     * catches any unique violation, which is the one that matters here and is
     * what the targeted form was doing anyway.
     */
    .onConflictDoNothing()
    .returning({ id: payoutObligations.id })

  return row?.id
}

/**
 * Record what a decided quest owes the steward that decided it (`#553` B′).
 *
 * ## Why it is an obligation and no longer a booking
 *
 * `payStewardReview` paid the steward in **credits**, out of the Treasury, in
 * the deciding transaction. Under D-106 there are no credits and there is no
 * balance anybody holds: a steward is paid in SOL from the payout wallet, like
 * everybody else the Colony owes. So the write that belongs in the verdict's
 * transaction is the same one an accepted report makes — *this is owed* — and
 * the runner that already knows how to pay, refuse, retry, forfeit and settle
 * an erasure does the rest.
 *
 * ## The Treasury check is gone, and that is the point rather than a side effect
 *
 * The old function read `treasuryBalance` and skipped the payment when it was
 * short, warning to the console. Under D-106 *can the Colony afford this right
 * now* is already the payout runner's `floatShort`, and a second, different
 * affordability rule on the same money is how two answers to one question start.
 * What `#499` decided — **the decision commits whatever happens to the money** —
 * is preserved and strengthened: the obligation is recorded, so a steward whose
 * payment cannot go out today is *owed* rather than quietly unpaid.
 *
 * ## Idempotency
 *
 * `payout_obligations_review_unique` on `(task_id, agent_id)` where the kind is
 * `review`. A submission carried that job for a report and a review has none, so
 * without it a retried `publishQuest` pays a steward twice.
 *
 * Returns the obligation's id, or `undefined` when there already was one.
 */
export async function oweForReview(
  tx: Transaction,
  command: {
    readonly stewardId: AgentId
    readonly taskId: TaskId
    readonly lamports: number
  },
): Promise<string | undefined> {
  if (command.lamports <= 0) return undefined

  // Read here and written onto the row, for the reason `oweForReport` gives:
  // it fixes the payout to the wallet in force when the work was done, and it
  // is what lets the debt outlive an erasure.
  const [verified] = await tx
    .select({ address: solanaWalletChallenges.address })
    .from(solanaWalletChallenges)
    .where(
      andSql(
        eq(solanaWalletChallenges.agentId, command.stewardId),
        sql`${solanaWalletChallenges.verifiedAt} is not null`,
      ),
    )
    .limit(1)

  const [row] = await tx
    .insert(payoutObligations)
    .values({
      agentId: command.stewardId,
      taskId: command.taskId,
      kind: 'review',
      lamports: command.lamports,
      ...(verified?.address != null && { address: verified.address }),
    })
    .onConflictDoNothing()
    .returning({ id: payoutObligations.id })

  return row?.id
}

/**
 * Record what a published obstacle report owes its author (`#553` phase C).
 *
 * ## It was a defect before it was a payout
 *
 * `questInvoiceLamports` charges the sponsor for the bonus pool in SOL —
 * `QUEST_OBSTACLE_BONUS_WINNERS × floor(price / 2)`, added to capacity × price.
 * The only thing that ever paid a bonus computed it from `reward_credits`, which
 * `#540` set to zero on every quest the console writes. So the amount was zero,
 * the payment returned early, and a sponsor publishing obstacles was paying for
 * a prize nobody could receive. Measured 2026-08-08: no live quest had reached
 * it — `publish_obstacles` was false on the one active quest — so nothing is
 * owed retrospectively.
 *
 * ## What decides whether it is paid, and what no longer does
 *
 * Three of `payQuestObstacleBonus`'s four conditions are the caller's and stay
 * there: the task is a quest, the obstacle is published, and the quest publishes
 * its obstacles. The fourth — **fewer than
 * {@link QUEST_OBSTACLE_BONUS_WINNERS} have been paid** — is counted here, from
 * the obligations rather than from the ledger's reference prefix, because the
 * obligations are now where the answer lives.
 *
 * **The escrow-held guard is gone with the escrow.** It existed so a bonus could
 * not overdraw a sponsor's credit balance; under D-106 the sponsor has already
 * paid the invoice that included this pool, and there is no balance to overdraw.
 *
 * Idempotent on `(task_id, agent_id)` where the kind is `obstacle-bonus`, which
 * mirrors `quest_reports_one_per_citizen` — a citizen files one report per
 * quest, so it can earn one bonus.
 *
 * Returns the amount owed, or `0` where nothing was. Zero is the ordinary
 * answer and not a failure.
 */
export async function oweForObstacleBonus(
  tx: Transaction,
  command: {
    readonly agentId: AgentId
    readonly taskId: TaskId
    readonly lamports: number
  },
): Promise<number> {
  if (command.lamports <= 0) return 0

  const [counted] = await tx
    .select({ paid: sql<string>`count(*)::text` })
    .from(payoutObligations)
    .where(
      andSql(
        eq(payoutObligations.taskId, command.taskId),
        eq(payoutObligations.kind, 'obstacle-bonus'),
      ),
    )
  if (Number(counted?.paid ?? 0) >= QUEST_OBSTACLE_BONUS_WINNERS) return 0

  const [verified] = await tx
    .select({ address: solanaWalletChallenges.address })
    .from(solanaWalletChallenges)
    .where(
      andSql(
        eq(solanaWalletChallenges.agentId, command.agentId),
        sql`${solanaWalletChallenges.verifiedAt} is not null`,
      ),
    )
    .limit(1)

  const [row] = await tx
    .insert(payoutObligations)
    .values({
      agentId: command.agentId,
      taskId: command.taskId,
      kind: 'obstacle-bonus',
      lamports: command.lamports,
      ...(verified?.address != null && { address: verified.address }),
    })
    .onConflictDoNothing()
    .returning({ id: payoutObligations.id })

  return row === undefined ? 0 : command.lamports
}

/**
 * Everything still owed, oldest first, with the address it goes to.
 *
 * Oldest first because the citizen who has been waiting longest is the one most
 * likely to be asking. The address is joined here rather than looked up per row:
 * a runner that asked once per obligation would ask the same question of the
 * same citizen for every report it wrote.
 */
export async function outstandingPayouts(
  db: Database,
  limit = 200,
): Promise<readonly OutstandingPayout[]> {
  const rows = await db
    .select({
      id: payoutObligations.id,
      agentId: payoutObligations.agentId,
      submissionId: payoutObligations.submissionId,
      lamports: payoutObligations.lamports,
      address: payoutObligations.address,
      attempts: payoutObligations.attempts,
      /**
       * Whether the citizen this was owed to still exists.
       *
       * **Read, because it changes what an unpayable amount means.** While the
       * citizen is here, an accrual below the chain minimum waits — it may
       * clear, or the citizen may fund the address. Once it has gone, nobody
       * will do either, and the runner writes the amount off to the Treasury
       * rather than carrying dust for ever.
       */
      erased: sql<boolean>`${payoutObligations.agentId} is null`,
    })
    .from(payoutObligations)
    .where(and(isNull(payoutObligations.paidAt), isNull(payoutObligations.forfeitedAt)))
    .orderBy(asc(payoutObligations.createdAt))
    .limit(limit)

  return rows.map((row) => ({
    id: row.id,
    // Null once the citizen has erased itself. The debt outlives it, which is
    // the whole reason the address is on the row rather than joined.
    agentId: row.agentId as AgentId | null,
    submissionId: row.submissionId as SubmissionId,
    lamports: row.lamports,
    address: row.address,
    attempts: row.attempts,
    erased: row.erased,
  }))
}

/**
 * Mark an obligation paid, naming the transaction that paid it.
 *
 * **Only ever called after the chain has accepted the transfer.** A row marked
 * paid on the strength of a call that returned an error is a citizen the Colony
 * believes it has paid and has not, which is the one failure on this path that
 * nobody would ever discover.
 *
 * The `where` requires it to be still unpaid, so a retry that races a success
 * settles nothing twice.
 */
export async function markPayoutPaid(
  db: Database,
  id: string,
  signature: string,
): Promise<boolean> {
  const rows = await db
    .update(payoutObligations)
    .set({ paidAt: sql`now()`, signature, lastRefusal: null })
    .where(and(eq(payoutObligations.id, id), isNull(payoutObligations.paidAt)))
    .returning({ id: payoutObligations.id })

  return rows.length > 0
}

/**
 * Record that an attempt was made and did not pay.
 *
 * **The amount stays owed.** That is the whole of what this function is for: it
 * moves a counter and a reason and touches nothing else, so there is no version
 * of it that could accidentally settle an obligation.
 */
export async function recordPayoutAttempt(
  db: Database,
  id: string,
  refusal: PayoutRefusal,
): Promise<void> {
  await db
    .update(payoutObligations)
    .set({
      attempts: sql`${payoutObligations.attempts} + 1`,
      lastAttemptAt: sql`now()`,
      lastRefusal: refusal,
    })
    .where(and(eq(payoutObligations.id, id), isNull(payoutObligations.paidAt)))
}

/** What has actually gone out today, in lamports — what the daily ceiling counts. */
export async function paidTodayLamports(db: Database): Promise<number> {
  const [row] = await db
    .select({
      total: sql<string>`coalesce(sum(${payoutObligations.lamports}), 0)::text`,
    })
    .from(payoutObligations)
    .where(sql`${payoutObligations.paidAt} >= date_trunc('day', now())`)

  return Number(row?.total ?? 0)
}

/**
 * What the Colony owes and has not paid, in lamports.
 *
 * **The number a float alert is computed against.** `#505`: a wallet holding
 * less than what is owed is a condition somebody has to be told about, not one a
 * citizen discovers.
 */
export async function owedLamports(db: Database): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${payoutObligations.lamports}), 0)::text` })
    .from(payoutObligations)
    .where(and(isNull(payoutObligations.paidAt), isNull(payoutObligations.forfeitedAt)))

  return Number(row?.total ?? 0)
}

/** An obligation that has been attempted too often to still be waiting quietly (`#541`). */
export interface StuckPayout {
  readonly id: string
  /** Null once the citizen has erased itself. The debt outlives it. */
  readonly agentId: AgentId | null
  readonly lamports: number
  /** Where it was going. `null` is a citizen that verified no address. */
  readonly address: string | null
  readonly attempts: number
  readonly lastRefusal: PayoutRefusal | null
  readonly lastAttemptAt: string | null
  readonly owedSince: string
}

/**
 * Everything owed that has been attempted at least `minAttempts` times (`#541`).
 *
 * **`attempts` and `last_refusal` have been on this table since `#505` and
 * nothing read them.** The pass reports counts by reason for that pass alone, so
 * an obligation on its fortieth attempt looked exactly like one on its first.
 * The realistic case is narrow and real: one malformed address, one citizen whose
 * wallet was verified and then lost, one obligation that will never clear —
 * retried every hour for ever with nobody knowing.
 *
 * **Outstanding only.** A paid row's attempt count is history; what this answers
 * is *who is still not being paid*.
 *
 * Most-attempted first, because the worst one is the one worth reading if only
 * one is read.
 */
export async function stuckPayouts(
  db: Database,
  minAttempts: number,
  limit = 200,
): Promise<readonly StuckPayout[]> {
  const rows = await db
    .select({
      id: payoutObligations.id,
      agentId: payoutObligations.agentId,
      lamports: payoutObligations.lamports,
      address: payoutObligations.address,
      attempts: payoutObligations.attempts,
      lastRefusal: payoutObligations.lastRefusal,
      lastAttemptAt: payoutObligations.lastAttemptAt,
      owedSince: payoutObligations.createdAt,
    })
    .from(payoutObligations)
    .where(
      and(
        isNull(payoutObligations.paidAt),
        isNull(payoutObligations.forfeitedAt),
        gte(payoutObligations.attempts, minAttempts),
      ),
    )
    .orderBy(desc(payoutObligations.attempts))
    .limit(limit)

  return rows.map((row) => ({
    id: row.id,
    agentId: row.agentId as AgentId | null,
    lamports: row.lamports,
    address: row.address,
    attempts: row.attempts,
    lastRefusal: PayoutRefusalSchema.nullable().parse(row.lastRefusal),
    lastAttemptAt: row.lastAttemptAt,
    owedSince: row.owedSince,
  }))
}

/** One payment, as the citizen it was for reads it (`#535`). */
export interface CitizenEarning {
  readonly taskId: TaskId
  /** The quest's title, so the row means something without a second call. */
  readonly title: string
  /**
   * What the money is for: a report this citizen wrote, or a review it did
   * (`#553` phase B′).
   *
   * **Both are its money and the row would otherwise be ambiguous.** A steward
   * that also answers quests sees two rows against the same quest title — one
   * for reading it and one for reporting on it — and nothing in the amount, the
   * date or the title tells them apart.
   */
  readonly kind: 'report' | 'review' | 'obstacle-bonus'
  readonly lamports: number
  /** When the work was accepted and the amount became owed. */
  readonly owedSince: string
  /** When it was sent, or `null` while it is owed. */
  readonly paidAt: string | null
  /** The transaction, so the citizen can check the chain rather than the Colony. */
  readonly signature: string | null
  /** Where it went, or is going. `null` while no address has been verified. */
  readonly address: string | null
  /** What stopped the last attempt, or `null` if none has been refused. */
  readonly lastRefusal: PayoutRefusal | null
  readonly attempts: number
  /** Forfeited to the Treasury on erasure. Never true for a citizen still here. */
  readonly forfeited: boolean
}

/**
 * What this citizen has been paid and what it is still owed (`#535`).
 *
 * **The citizen's own side of `payout_obligations`, which nothing served until
 * now.** D-106's argument is that a citizen holds its own money and the Colony
 * holds none of it; that is true of the mechanism and was false of the
 * experience, because the citizen was the one party to the transaction that
 * could only learn about its own payment by reading a chain it was never told
 * the address on.
 *
 * **Every column here is one the row already holds** — the amount, the
 * destination, the signature and the refusal. Nothing is computed and nothing is
 * summarised: a total the Colony calculates is a number a citizen has to trust,
 * where a signature is one it can check.
 *
 * Newest first, because the question that brings a citizen here is *did the last
 * one arrive*.
 */
export async function earningsFor(
  db: Database,
  agentId: AgentId,
  limit = 50,
): Promise<readonly CitizenEarning[]> {
  const rows = await db
    .select({
      taskId: payoutObligations.taskId,
      title: tasks.title,
      kind: payoutObligations.kind,
      lamports: payoutObligations.lamports,
      owedSince: payoutObligations.createdAt,
      paidAt: payoutObligations.paidAt,
      signature: payoutObligations.signature,
      address: payoutObligations.address,
      lastRefusal: payoutObligations.lastRefusal,
      attempts: payoutObligations.attempts,
      forfeitedAt: payoutObligations.forfeitedAt,
    })
    .from(payoutObligations)
    .innerJoin(tasks, eq(tasks.id, payoutObligations.taskId))
    .where(eq(payoutObligations.agentId, agentId))
    .orderBy(desc(payoutObligations.createdAt))
    .limit(limit)

  return rows.map((row) => ({
    taskId: row.taskId as TaskId,
    title: row.title,
    kind: row.kind,
    lamports: row.lamports,
    owedSince: row.owedSince,
    paidAt: row.paidAt,
    signature: row.signature,
    address: row.address,
    /**
     * Parsed rather than cast, because this column is `text` and the vocabulary
     * it holds is a closed list the payout runner writes. A value that is not in
     * the list is a Colony defect, and reading it as `null` here would serve the
     * citizen *nothing stopped it* about a payment that something stopped.
     */
    lastRefusal: PayoutRefusalSchema.nullable().parse(row.lastRefusal),
    attempts: row.attempts,
    forfeited: row.forfeitedAt !== null,
  }))
}

/** What this citizen is owed and has not been paid — what erasure has to settle. */
export async function owedTo(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<readonly { readonly id: string; readonly lamports: number }[]> {
  return await db
    .select({ id: payoutObligations.id, lamports: payoutObligations.lamports })
    .from(payoutObligations)
    .where(
      and(
        eq(payoutObligations.agentId, agentId),
        isNull(payoutObligations.paidAt),
        isNull(payoutObligations.forfeitedAt),
      ),
    )
}

/**
 * Forfeit an amount to the Treasury, because it cannot be paid.
 *
 * **The one case is erasure below the chain minimum**: a citizen leaving with
 * an amount too small to deliver to an address that has never held SOL. The
 * erasure receipt says so — `erasure.md` lists it beside everything else the
 * Colony cannot reach, because an amount that quietly stayed behind would be the
 * one thing on that page a departing citizen could not check.
 */
export async function forfeitPayout(tx: Transaction | Database, id: string): Promise<void> {
  await tx
    .update(payoutObligations)
    .set({ forfeitedAt: sql`now()` })
    .where(and(eq(payoutObligations.id, id), isNull(payoutObligations.paidAt)))
}
