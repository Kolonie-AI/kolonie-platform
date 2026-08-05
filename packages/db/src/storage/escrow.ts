import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  LedgerTransactionIdSchema,
  QUEST_OBSTACLE_BONUS_WINNERS,
  questFundingReference,
  questCommitment,
  questObstacleBonus,
  questObstacleBonusPool,
  questObstacleBonusPrefix,
  questObstacleBonusReference,
  questPayoutReference,
  questRefundReference,
  type AgentId,
  type SubmissionId,
  type TaskId,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { ledgerEntries, tasks } from '../schema/index.js'

/**
 * A sponsor's coins are on account before its quest is written, reserved when
 * the quest is submitted, escrowed when a steward publishes it, released one
 * payout at a time as reports are accepted, and refunded if the quest expires
 * unfilled. **Nothing is minted at any point** — a quest moves a credit the
 * sponsor already had, and the mint is never touched (D-038).
 *
 * ## Zero books nothing
 *
 * Every function here writes no ledger rows at all when the amount is zero.
 * `ledger_entries_amount_non_zero` would refuse the row anyway, but the reason
 * is older than the constraint: a zero-sum transaction of zero is not a
 * transaction, and a ledger full of rows recording that nothing happened
 * exercises the deferred double-entry trigger for no reason.
 *
 * Since `kolonie-docs#130` a pilot quest pays one cent rather than zero,
 * precisely so that all four bookings execute rather than being skipped by this
 * branch. The branch stays because an Academy task still pays nothing, and
 * because a quest may legitimately be reputation-only.
 */

/** The statuses whose unspent capacity a sponsor has committed but not yet spent. */
const RESERVING_STATUSES = ['pending_review', 'active'] as const

/**
 * What a sponsor has committed to quests that have not yet been paid out.
 *
 * **Computed, never stored, and there is a test asserting no table holds it.**
 * A reservations table would be a second place a balance lives and the two would
 * disagree — the same argument D-002 made against a balance column on `agents`,
 * and the reason `#175` has no `slots_used` either.
 *
 * A reservation is not a booking. Between submission for review and publication
 * the credits are committed but **nothing has happened**, and the ledger records
 * what happened rather than what is intended. So this is a sum over the
 * sponsor's own quests, not a query against `ledger_entries`.
 *
 * Unspent capacity, not capacity: once a quest is published its whole capacity
 * has moved into escrow, and what is still reserved against the *balance* is
 * nothing. The `active` rows are here for the case a published quest's escrow
 * has been partly paid out — their remainder is in escrow rather than in the
 * balance, so they contribute zero and are counted for the `pending_review`
 * shape alone. See {@link availableBalance} for what the caller does with it.
 */
export async function reservedBy(db: Database | Transaction, sponsorId: AgentId): Promise<number> {
  const [row] = await db
    .select({
      /**
       * The table names are written out for the reason `isFull()` records at
       * length (#246): an interpolated `${table.column}` in a **select list**
       * over a single `from` renders without its table, and the two bare names
       * in this subquery would both resolve to `submissions` — making the
       * correlation `submissions.task_id = submissions.id`, false for every row.
       *
       * Latent rather than live, because this query is filtered to
       * `pending_review` and a quest that has not been published has no passed
       * submissions to subtract. It is fixed anyway: the paragraph above already
       * describes the published case, and a defect that is only invisible
       * because of a `where` clause somewhere else is one revision away from
       * being a sponsor told the wrong number about its own money.
       *
       * **The obstacle pool is part of the reservation** (`#371`), and it is
       * written here in SQL rather than read through `questObstacleBonusPool`
       * because this is a sum over rows the process never loads. The arithmetic
       * is the same one, and `escrow.test.ts` asserts the two agree — a
       * reservation that disagreed with what publication escrows is a sponsor
       * told it can afford a quest that is then refused.
       */
      reserved: sql<string>`coalesce(sum(
        tasks.reward_credits * greatest(
          coalesce(tasks.slots, 0) - (
            select count(*) from submissions s
            where s.task_id = tasks.id and s.status = 'passed'
          ), 0)
        + case when tasks.publish_obstacles
            then floor(tasks.reward_credits / 2) * ${QUEST_OBSTACLE_BONUS_WINNERS}
            else 0 end
      ), 0)::text`,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.createdBy, sponsorId),
        eq(tasks.kind, 'quest'),
        eq(tasks.status, 'pending_review'),
      ),
    )

  return Number(row?.reserved ?? 0)
}

/**
 * What a sponsor may still commit: its ledger balance minus what it has
 * reserved.
 *
 * The ledger balance is summed here rather than taken from `balanceOfAgent`, so
 * that both halves are read inside one transaction when the caller has one — a
 * quest submitted between the two reads would otherwise be invisible to exactly
 * the check that exists to see it.
 */
export async function availableBalance(
  db: Database | Transaction,
  sponsorId: AgentId,
): Promise<{ readonly balance: number; readonly reserved: number; readonly available: number }> {
  const [held] = await db
    .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amount}), 0)::text` })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.accountKind, 'agent'), eq(ledgerEntries.agentId, sponsorId)))

  const balance = Number(held?.total ?? 0)
  const reserved = await reservedBy(db, sponsorId)
  return { balance, reserved, available: balance - reserved }
}

/** What a quest's escrow currently holds. Zero once it has closed out. */
export async function escrowHeldFor(db: Database | Transaction, taskId: TaskId): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amount}), 0)::text` })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.systemAccount, 'escrow'),
        sql`${ledgerEntries.reference} like ${'quest:' + taskId + ':%'}`,
      ),
    )

  return Number(row?.total ?? 0)
}

/** Both rows of one booking, written together. */
async function book(
  tx: Transaction,
  entry: {
    readonly reference: string
    readonly type: 'task_funding' | 'task_payout'
    readonly memo: string
    readonly amount: number
    readonly from:
      | { readonly kind: 'agent'; readonly agentId: AgentId }
      | { readonly kind: 'system'; readonly account: 'escrow' | 'treasury' }
    readonly to:
      | { readonly kind: 'agent'; readonly agentId: AgentId }
      | { readonly kind: 'system'; readonly account: 'escrow' | 'treasury' }
  },
): Promise<void> {
  // Generated here rather than by the database: both entries of one booking must
  // carry the same id, and a column default would give each of them its own.
  const transactionId = LedgerTransactionIdSchema.parse(crypto.randomUUID())
  const side = (who: typeof entry.from, amount: number): typeof ledgerEntries.$inferInsert => ({
    transactionId,
    accountKind: who.kind,
    ...(who.kind === 'agent' ? { agentId: who.agentId } : { systemAccount: who.account }),
    amount,
    type: entry.type,
    memo: entry.memo,
    reference: entry.reference,
  })

  await tx
    .insert(ledgerEntries)
    .values([side(entry.from, -entry.amount), side(entry.to, entry.amount)])
}

/**
 * Sponsor → escrow, for the whole capacity, when a steward publishes.
 *
 * **Called inside the publication's transaction**, so the status change to
 * `active` and the money moving commit together or neither does. A published
 * quest whose money did not move is the exact failure the prepay model exists to
 * prevent, and a two-step version has a window in which it is true.
 *
 * Booking twice is refused by `ledger_entries_quest_funding_unique` rather than
 * by a check here: the thing that would book twice is two requests publishing
 * the same quest in the same millisecond, and both would pass a `select`.
 */
export async function fundQuestEscrow(
  tx: Transaction,
  command: {
    readonly taskId: TaskId
    readonly sponsorId: AgentId
    readonly credits: number
    readonly capacity: number
    /**
     * Whether the obstacle pool is part of this escrow (`#370`, `#371`).
     *
     * **Required, and deliberately not defaulted.** A caller that forgot it
     * would under-fund the escrow by the pool, and the failure would be silent
     * and late: the bonus would simply never be paid, because the guard that
     * refuses to overdraw the escrow would refuse it, on a quest whose sponsor
     * had been told the money was held.
     */
    readonly publishObstacles: boolean
  },
): Promise<number> {
  const total = questCommitment({
    reward: { credits: command.credits, reputation: 0 },
    slots: command.capacity,
    publishObstacles: command.publishObstacles,
  })
  if (total === 0) return 0

  const pool = questObstacleBonusPool({
    reward: { credits: command.credits, reputation: 0 },
    publishObstacles: command.publishObstacles,
  })

  await book(tx, {
    reference: questFundingReference(command.taskId),
    type: 'task_funding',
    memo:
      pool === 0
        ? `Quest escrow — ${command.capacity} × ${command.credits}`
        : `Quest escrow — ${command.capacity} × ${command.credits}, plus ${pool} for obstacle reports`,
    amount: total,
    from: { kind: 'agent', agentId: command.sponsorId },
    to: { kind: 'system', account: 'escrow' },
  })

  return total
}

/**
 * Escrow → citizen, for one accepted report.
 *
 * **Booked in the verdict's transaction**, exactly as an Academy pass already
 * books reputation and grants a skill in one. No second job, no reconciliation:
 * a report that was accepted and not paid would be a debt the Colony cannot
 * find.
 */
export async function payQuestReport(
  tx: Transaction,
  command: {
    readonly taskId: TaskId
    readonly submissionId: SubmissionId
    readonly agentId: AgentId
    readonly credits: number
    /**
     * What the Colony paid and why, in the words the verdict used.
     *
     * Passed in rather than written here, so a quest payout carries the same rate
     * record an Academy reward does — the memo is where an audit reads what was
     * paid and at what rate, and a payout that dropped it would be the one entry
     * in the ledger a reviewer had to reconstruct from somewhere else.
     */
    readonly memo: string
  },
): Promise<void> {
  if (command.credits === 0) return

  /**
   * **The escrow may never go negative**, and this is where that is enforced.
   *
   * Capacity is supposed to make it impossible — `#175` refuses a submission
   * once every slot is taken, so there can never be more accepted reports than
   * the escrow was funded for. This checks it anyway, because the two are
   * different mechanisms and the failure if they ever disagree is the worst kind
   * available here: an escrow lent against itself, paying citizens with money
   * that belongs to another sponsor's quest.
   *
   * It throws rather than returning an outcome. Every caller is inside a verdict
   * transaction that has already decided the report is good, and there is no
   * sensible partial answer — the whole verdict has to go back.
   */
  const held = await escrowHeldFor(tx, command.taskId)
  if (held < command.credits) {
    throw new Error(
      `quest ${command.taskId} holds ${held} in escrow and a report costs ${command.credits}: ` +
        'paying it would overdraw the escrow into another quest’s money',
    )
  }

  await book(tx, {
    reference: questPayoutReference(command.taskId, command.submissionId),
    type: 'task_payout',
    memo: command.memo,
    amount: command.credits,
    from: { kind: 'system', account: 'escrow' },
    to: { kind: 'agent', agentId: command.agentId },
  })
}

/**
 * Escrow → citizen, for one published obstacle report (`#371`).
 *
 * **On a rung a report deliberately pays nothing, and that decision stands.** A
 * rung is the Colony's own work and the Colony can afford to ask for the account
 * of it as a gift. A quest is not: there is real money in escrow, and the
 * front-runner problem is a payment problem — the first citizen to answer pays
 * the whole cost of discovery, reads nothing, and hands the benefit to everybody
 * after it. Nothing compensated that, and the result was measurable:
 * `quest_reports` held zero rows on 2026-08-05.
 *
 * **Four conditions, and each is a refusal rather than a filter**, because every
 * one of them is a way this could quietly pay for something it should not:
 *
 * - the task is a **quest**. An Academy rung reaches here only through a bug,
 *   and paying on one would break the boundary `governance/quests.md` draws;
 * - the obstacle is **published**. A report the moderation stage rejected, or one
 *   whose obstacle was withheld, bought nobody anything;
 * - the quest **publishes its obstacles** (`#370`). A sponsor that kept them held
 *   no pool, so there is nothing to pay from and nothing was earned;
 * - fewer than {@link QUEST_OBSTACLE_BONUS_WINNERS} have been paid already,
 *   counted from the ledger by reference prefix rather than from a column
 *   somebody keeps in step.
 *
 * Returns what it paid, so the caller can say so. Zero is the ordinary answer
 * and not a failure.
 */
export async function payQuestObstacleBonus(
  tx: Transaction,
  command: {
    readonly taskId: TaskId
    readonly reportId: string
    readonly agentId: AgentId
  },
): Promise<number> {
  const [task] = await tx
    .select({
      kind: tasks.kind,
      rewardCredits: tasks.rewardCredits,
      publishObstacles: tasks.publishObstacles,
    })
    .from(tasks)
    .where(eq(tasks.id, command.taskId))
    .limit(1)

  if (task === undefined || task.kind !== 'quest' || !task.publishObstacles) return 0

  const bonus = questObstacleBonus({ credits: task.rewardCredits })
  if (bonus === 0) return 0

  const [counted] = await tx
    .select({ paid: sql<string>`count(*)::text` })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.accountKind, 'agent'),
        sql`${ledgerEntries.reference} like ${questObstacleBonusPrefix(command.taskId) + '%'}`,
      ),
    )
  if (Number(counted?.paid ?? 0) >= QUEST_OBSTACLE_BONUS_WINNERS) return 0

  /**
   * The same guard `payQuestReport` states in full: capacity and the pool
   * together are what the escrow was funded for, so this cannot overdraw — and
   * it is checked anyway, because the failure if the two mechanisms ever
   * disagree is an escrow paying citizens with another sponsor's money.
   */
  const held = await escrowHeldFor(tx, command.taskId)
  if (held < bonus) return 0

  await book(tx, {
    reference: questObstacleBonusReference(command.taskId, command.reportId),
    type: 'task_payout',
    memo: `Published obstacle report — one of the first ${QUEST_OBSTACLE_BONUS_WINNERS} on this quest`,
    amount: bonus,
    from: { kind: 'system', account: 'escrow' },
    to: { kind: 'agent', agentId: command.agentId },
  })

  return bonus
}

/**
 * Escrow → sponsor, for capacity that expired unspent.
 *
 * The sponsor bought reports and did not receive them, and the Colony has no
 * claim on the difference.
 *
 * **An ownerless quest refunds to the `treasury` instead.** A sponsor that
 * erased itself mid-quest leaves the quest standing with `created_by` unset —
 * which `tasks.ts` already implements and `erasure.md` §2 already argued — and
 * the consequence nobody had written down is that its unspent remainder has
 * nowhere to go. It goes to the Colony rather than staying in escrow forever,
 * because escrow holding money for a quest that has ended is a balance that
 * never nets to zero and therefore an audit that never reconciles.
 *
 * Refunding twice is refused by the same unique index that refuses funding
 * twice; the two carry different references.
 */
export async function refundQuestRemainder(
  tx: Transaction,
  command: { readonly taskId: TaskId },
): Promise<number> {
  const remainder = await escrowHeldFor(tx, command.taskId)
  if (remainder === 0) return 0

  const [task] = await tx
    .select({ sponsorId: tasks.createdBy })
    .from(tasks)
    .where(eq(tasks.id, command.taskId))
    .limit(1)

  await book(tx, {
    reference: questRefundReference(command.taskId),
    type: 'task_funding',
    memo:
      task?.sponsorId == null
        ? 'Quest closed — remainder to the treasury, its author having erased itself'
        : 'Quest closed — unspent capacity refunded',
    amount: remainder,
    from: { kind: 'system', account: 'escrow' },
    to:
      task?.sponsorId == null
        ? { kind: 'system', account: 'treasury' }
        : { kind: 'agent', agentId: task.sponsorId as AgentId },
  })

  return remainder
}

/** Whether a sponsor could still commit this much. Used before accepting a draft for review. */
export async function canCommit(
  db: Database | Transaction,
  sponsorId: AgentId,
  total: number,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly shortfall: number }> {
  const { available } = await availableBalance(db, sponsorId)
  return available >= total ? { ok: true } : { ok: false, shortfall: total - available }
}

/** The statuses a reservation is computed over, exported so a test can pin them. */
export const RESERVED_IN_STATUSES = RESERVING_STATUSES

/**
 * Every quest that has finished and whose escrow still holds something.
 *
 * **Finished means one of two things, and only one of them is a date.** An
 * `active` quest finishes when its expiry passes. A **`retired`** one has
 * finished by decision — a steward retiring it early on the evidence of `#240`'s
 * counts — and waiting for its original expiry would hold a sponsor's money for
 * a fortnight after the quest stopped existing.
 *
 * This used to require the expiry in both cases, and `#240` is what made the
 * difference visible: retiring cannot bring the expiry forward, because
 * `tasks_published_quest_frozen` refuses any change to a live quest's terms and
 * the expiry is one of them. That trigger is right and stays; what changes is
 * this query, which was asking *has the clock run out* where it meant *is this
 * quest over*.
 */
export async function questsAwaitingRefund(db: Database): Promise<readonly TaskId[]> {
  const rows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.kind, 'quest'),
        sql`(
          ${tasks.status} = 'retired'
          or (${tasks.status} = 'active'
              and ${tasks.expiresAt} is not null and ${tasks.expiresAt} <= now())
        )`,
      ),
    )

  return rows.map((row) => row.id as TaskId)
}

/** What one refund pass returned, per quest that still held something. */
export interface QuestRefund {
  readonly taskId: TaskId
  readonly credits: number
}

/**
 * Refund every quest that has finished and whose escrow still holds something.
 *
 * **One transaction per quest, deliberately.** A pass over a hundred expired
 * quests in one transaction would make the hundredth quest's failure undo the
 * ninety-nine refunds that worked, and there is nothing about two sponsors'
 * money that has to commit together. The unit of atomicity here is a quest,
 * which is the unit `refundQuestRemainder` already books.
 *
 * **Idempotent, and by the same mechanism the other three legs are.** A second
 * pass over a quest already refunded reads an escrow of zero and books nothing;
 * a pass that raced another one is refused by
 * `ledger_entries_quest_funding_unique`, which is the index rather than a check
 * here for the reason `fundQuestEscrow` records — the thing that would book
 * twice is two passes in the same millisecond, and both would pass a `select`.
 * That refusal is caught per quest and reported as a failure of that quest
 * alone, because it is the loser of a race and not an outage.
 *
 * The caller is a sweep on a timer (`#315`), and what it does with the result is
 * log it. Nothing waits on a refund the way a citizen waits on a verdict: the
 * money is the sponsor's either way, and the only thing an interval costs is how
 * soon its balance says so.
 */
export async function sweepQuestRefunds(db: Database): Promise<{
  readonly refunded: readonly QuestRefund[]
  readonly failed: readonly { readonly taskId: TaskId; readonly error: unknown }[]
}> {
  const refunded: QuestRefund[] = []
  const failed: { readonly taskId: TaskId; readonly error: unknown }[] = []

  for (const taskId of await questsAwaitingRefund(db)) {
    try {
      const credits = await db.transaction((tx) => refundQuestRemainder(tx, { taskId }))
      if (credits > 0) refunded.push({ taskId, credits })
    } catch (thrown) {
      // One quest's failure is not the pass's. The next tick tries it again, and
      // a quest that cannot be refunded at all will say so once an interval
      // rather than stopping every other sponsor's money from coming back.
      failed.push({ taskId, error: thrown })
    }
  }

  return { refunded, failed }
}

/**
 * One quest's share of what a sponsor has committed (`#324`).
 *
 * Two numbers, because a quest's money is in one of two places and a sponsor
 * that cannot tell them apart cannot tell what happened:
 *
 * - **`reserved`** is committed and not yet moved. It exists only while the
 *   quest is in `pending_review`, and it disappears the moment the quest leaves
 *   — published, refused or withdrawn — because {@link reservedBy} sums the
 *   queue rather than reading a stored figure.
 * - **`escrowed`** is money that has actually moved, held against this quest
 *   from publication until it is paid out or refunded.
 *
 * The two are never both non-zero, and that is a property of the lifecycle
 * rather than a coincidence: publication is what turns one into the other, in
 * one transaction.
 *
 * **`paid` is the third, and it is what makes the row add up** (`#333`). Without
 * it a sponsor watching its own quest sees the escrow fall and cannot tell by
 * how much it should have: a citizen read 277 against a published cost of 300
 * and could establish only that 23 is not a multiple of the 15 the quest
 * advertises. It is not, and the escrow was right — a payout is reduced when the
 * answering citizen declares that it was assisted, so two accepted answers at an
 * advertised 15 cost 15 and 8. That is a rule the sponsor is entitled to see the
 * effect of rather than deduce, and `escrowed + paid` restores the arithmetic:
 * it equals what publication funded, always, for as long as the quest is open.
 */
export interface QuestCommitmentRow {
  readonly taskId: TaskId
  readonly title: string
  readonly status: string
  /** Counted in {@link reservedBy}. Non-zero only in `pending_review`. */
  readonly reserved: number
  /** Held by the escrow account for this quest. Non-zero only after publication. */
  readonly escrowed: number
  /**
   * What this quest's escrow has already paid to answering citizens.
   *
   * Positive, and it only ever grows while the quest is open. `escrowed + paid`
   * is what was funded at publication — so a sponsor can see both that money is
   * leaving and that none of it has gone anywhere it did not authorise.
   */
  readonly paid: number
}

/**
 * What each of a sponsor's quests is holding, and where (`#324`).
 *
 * **The decomposition of `reserved`, which was a scalar.** A citizen reported
 * the consequence exactly: with two quests settling, it could not tell which one
 * had released what — so the refund rule was unobservable even to a sponsor
 * watching for it. The scalar is unchanged and this sums to it; nothing here is
 * a second source of truth, both being computed from the same rows.
 *
 * **Escrow is joined by reference prefix**, which is how every other read of a
 * quest's escrow already works ({@link escrowHeldFor}) — the ledger records what
 * a booking was *for* in `reference`, and `quest:<id>:` is that vocabulary.
 *
 * Only the two statuses where money is anywhere: a `draft` commits nothing, and
 * a `rejected`, `retired` or expired quest has either never moved money or has
 * had it swept back. A quest that has closed and been refunded shows zero in
 * both columns for one sweep interval and then leaves this list entirely, which
 * is the sponsor watching the refund happen.
 */
export async function commitmentsBy(
  db: Database | Transaction,
  sponsorId: AgentId,
): Promise<readonly QuestCommitmentRow[]> {
  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      /**
       * The same expression {@link reservedBy} sums, per row rather than over
       * the set, and zero for anything that is not in the queue — so this column
       * adds up to the scalar by construction rather than by agreement.
       *
       * Table names written out, per `isFull()` and for the same reason: an
       * interpolated column in a select list over a single `from` renders
       * unqualified, and the two bare names inside the subquery would both
       * resolve to `submissions`.
       */
      reserved: sql<string>`(case when tasks.status = 'pending_review' then
        tasks.reward_credits * greatest(
          coalesce(tasks.slots, 0) - (
            select count(*) from submissions s
            where s.task_id = tasks.id and s.status = 'passed'
          ), 0)
        + case when tasks.publish_obstacles
            then floor(tasks.reward_credits / 2) * ${QUEST_OBSTACLE_BONUS_WINNERS}
            else 0 end
      else 0 end)::text`,
      escrowed: sql<string>`coalesce((
        select sum(e.amount) from ledger_entries e
        where e.system_account = 'escrow'
          and e.reference like 'quest:' || tasks.id || ':%'
      ), 0)::text`,
      /**
       * Read from the **escrow** side and negated, rather than from the
       * citizens' side (`#333`).
       *
       * Both are the same number today and only this one stays that way. A
       * payout books escrow → citizen, so summing the agent legs would mean
       * summing rows that belong to as many different citizens as there are
       * accepted answers — and a booking that ever paid a second party out of
       * the same escrow would be counted once instead of twice. The escrow side
       * is the side that is about this quest's money by definition, which is
       * also why {@link escrowHeldFor} reads it.
       *
       * Negated because an outflow from escrow is a negative entry there, and
       * a sponsor reading *what has this cost me so far* wants a positive.
       */
      paid: sql<string>`coalesce((
        select -sum(e.amount) from ledger_entries e
        where e.system_account = 'escrow'
          and e.type = 'task_payout'
          and e.reference like 'quest:' || tasks.id || ':%'
      ), 0)::text`,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.createdBy, sponsorId),
        eq(tasks.kind, 'quest'),
        inArray(tasks.status, [...RESERVING_STATUSES]),
      ),
    )
    .orderBy(desc(tasks.createdAt))

  return rows.map((row) => ({
    taskId: row.id as TaskId,
    title: row.title,
    status: row.status,
    reserved: Number(row.reserved),
    escrowed: Number(row.escrowed),
    paid: Number(row.paid),
  }))
}
