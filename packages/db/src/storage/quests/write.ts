import { and, eq, sql } from 'drizzle-orm'
import {
  QUEST_EDITABLE_STATUSES,
  QUEST_MAX_SLOTS,
  QUEST_PENDING_LIMIT,
  QUEST_TASK_TYPE,
  type AgentId,
  type QuestDraft,
  type QuestPatch,
  type Task,
  type TaskId,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database } from '../../client.js'
import { tasks } from '../../schema/index.js'
import { toTask } from '../rows.js'
import { ownQuestRow, type OwnQuest } from './shared.js'

/**
 * The write path for a quest: drafted by an account, moderated, reviewed by a
 * steward, published with its escrow (`#176`).
 *
 * **The one write path that is not `seedAcademyTasks`.** Everything in `tasks`
 * arrived from the array in `academy-tasks.ts` until this file existed, which is
 * why several constraints in `schema/tasks.ts` carry comments about "the write
 * path nobody has built yet". This is that write path, and those constraints are
 * what it is checked against rather than what it re-implements.
 */

/** Whether a write happened, and what stopped it if it did not. */
export type QuestWriteOutcome =
  | { readonly outcome: 'written'; readonly quest: OwnQuest }
  | { readonly outcome: 'unknown-quest' }
  /** The caller is not the author. Indistinguishable from `unknown-quest` at the route. */
  | { readonly outcome: 'not-yours' }
  | { readonly outcome: 'not-editable'; readonly status: Task['status'] }

export type QuestSubmitOutcome =
  | { readonly outcome: 'submitted'; readonly quest: OwnQuest }
  | { readonly outcome: 'unknown-quest' }
  | { readonly outcome: 'not-yours' }
  | { readonly outcome: 'not-editable'; readonly status: Task['status'] }
  /** Another quest of this account is already in the queue, named so the sponsor can find it. */
  | { readonly outcome: 'queue-occupied'; readonly by: TaskId }
  | { readonly outcome: 'insufficient-funds'; readonly shortfall: number }

/**
 * Whether a quest came back out of the queue (`#323`).
 *
 * `not-in-review` rather than `not-editable`, because the two say opposite
 * things about what to do next: a quest that cannot be *edited* is one this
 * caller should stop touching, and a quest that cannot be *withdrawn* is either
 * already a draft — nothing to do, it is where the caller wanted it — or already
 * decided, which is a different sentence again.
 */
export type QuestWithdrawOutcome =
  | { readonly outcome: 'withdrawn'; readonly quest: OwnQuest }
  | { readonly outcome: 'unknown-quest' }
  | { readonly outcome: 'not-yours' }
  | { readonly outcome: 'not-in-review'; readonly status: Task['status'] }

/**
 * Write a new draft, owned by its author.
 *
 * **`created_by` comes from the credential and is not a field.** It is the whole
 * of who owns this row — the edit guard, the queue cap, the escrow account and
 * the self-approval ban all read it — so a caller that could supply it could
 * write a quest in somebody else's name and spend their balance.
 *
 * `kind`, `type` and `status` are equally not the caller's: a row written here
 * is a `quest`, of the one quest type, in `draft`. There is no parameter for any
 * of them.
 */
export async function createQuestDraft(
  db: Database,
  command: { readonly authorId: AgentId; readonly draft: QuestDraft },
): Promise<OwnQuest> {
  const [row] = await db
    .insert(tasks)
    .values({
      type: QUEST_TASK_TYPE,
      kind: 'quest',
      status: 'draft',
      createdBy: command.authorId,
      title: command.draft.title,
      description: command.draft.description,
      instructions: command.draft.instructions,
      rewardReputation: command.draft.reward.reputation,
      // D-106 (`#504`). Written from the draft like the other two, and its
      // absence here was a defect the first mainnet run found: a quest priced in
      // SOL reached the database at zero, so its invoice was zero and it went
      // live free.
      rewardLamports: command.draft.reward.lamports,
      slots: command.draft.slots,
      expiresAt: command.draft.expiresAt,
      audience: command.draft.audience,
      requiresSkills: [...command.draft.requires],
      minReputation: command.draft.minReputation,
      minActivityDays: command.draft.minActivityDays,
      distinctOperators: command.draft.distinctOperators,
      publishObstacles: command.draft.publishObstacles,
      timeoutHours: command.draft.timeoutHours,
      assistanceAllowed: command.draft.assistanceAllowed,
      questions: command.draft.questions,
      proofVerifier: command.draft.proofVerifier,
    })
    .returning()

  if (row === undefined) throw new Error('inserting a quest draft returned no row')

  return { task: toTask(row), rejectionReason: row.rejectionReason, awaitingModeration: false }
}

/**
 * Change a draft, or a refused quest its author is correcting.
 *
 * **A text change moves `text_revised_at`, and that is what re-queues the
 * moderation.** The column was added by `#182` to say when what a task *asks
 * for* last changed, and the moderation queue reads exactly that question: a
 * verdict older than the current text is a verdict about a text nobody is
 * offering any more. Reusing it means a corrected quest is re-judged without a
 * second mechanism deciding when.
 */
export async function updateQuestDraft(
  db: Database,
  command: {
    readonly authorId: AgentId
    readonly taskId: TaskId
    readonly patch: QuestPatch
    readonly at: Timestamp
  },
): Promise<QuestWriteOutcome> {
  return await db.transaction(async (tx) => {
    const found = await ownQuestRow(tx, command.authorId, command.taskId)
    if (found.outcome !== 'found') return found

    const { row } = found
    if (!QUEST_EDITABLE_STATUSES.includes(row.status)) {
      return { outcome: 'not-editable', status: row.status }
    }

    const { patch } = command
    /**
     * **The questions count as text**, and that is the whole reason this is not
     * a comparison of three fields. A changed question is a changed statement of
     * what the quest asks for — it re-queues the moderation stage, and `#182`'s
     * column exists for exactly that reading.
     */
    const textChanged =
      (patch.title !== undefined && patch.title !== row.title) ||
      (patch.description !== undefined && patch.description !== row.description) ||
      (patch.instructions !== undefined && patch.instructions !== row.instructions) ||
      (patch.questions !== undefined &&
        JSON.stringify(patch.questions) !== JSON.stringify(row.questions))

    const [updated] = await tx
      .update(tasks)
      .set({
        ...(patch.title !== undefined && { title: patch.title }),
        ...(patch.description !== undefined && { description: patch.description }),
        ...(patch.instructions !== undefined && { instructions: patch.instructions }),
        ...(patch.reward !== undefined && {
          rewardReputation: patch.reward.reputation,
          rewardLamports: patch.reward.lamports,
        }),
        ...(patch.slots !== undefined && { slots: patch.slots }),
        ...(patch.expiresAt !== undefined && { expiresAt: patch.expiresAt }),
        ...(patch.audience !== undefined && { audience: patch.audience }),
        ...(patch.requires !== undefined && { requiresSkills: [...patch.requires] }),
        ...(patch.minReputation !== undefined && { minReputation: patch.minReputation }),
        ...(patch.minActivityDays !== undefined && { minActivityDays: patch.minActivityDays }),
        ...(patch.distinctOperators !== undefined && {
          distinctOperators: patch.distinctOperators,
        }),
        ...(patch.publishObstacles !== undefined && {
          publishObstacles: patch.publishObstacles,
        }),
        ...(patch.timeoutHours !== undefined && { timeoutHours: patch.timeoutHours }),
        ...(patch.assistanceAllowed !== undefined && {
          assistanceAllowed: patch.assistanceAllowed,
        }),
        ...(patch.questions !== undefined && { questions: patch.questions }),
        ...(patch.proofVerifier !== undefined && { proofVerifier: patch.proofVerifier }),
        updatedAt: command.at,
        ...(textChanged && { textRevisedAt: command.at }),
      })
      .where(eq(tasks.id, command.taskId))
      .returning()

    if (updated === undefined) return { outcome: 'unknown-quest' }

    return {
      outcome: 'written',
      quest: {
        task: toTask(updated),
        rejectionReason: updated.rejectionReason,
        awaitingModeration: false,
      },
    }
  })
}

/**
 * Submit a draft for review.
 *
 * Three refusals, and each is a decision recorded in `#176` rather than a guard
 * invented here:
 *
 * - **One quest in the queue per account.** The second submission names the
 *   first, so a sponsor can find what is blocking it instead of guessing.
 * - **The money has to be there.** The reservation is computed from the quests
 *   in `pending_review` (`#174`), so this check is what stops an account from
 *   committing the same credit twice. Nothing is booked here — a reservation is
 *   not a booking, and between submission and publication *nothing has
 *   happened*.
 * - **The expiry has to be in the future**, which the caller checks with
 *   `questSubmissionRejection` before reaching this. It is not repeated here
 *   because the API refuses it with the sentence that function returns, and a
 *   second implementation of the same rule is a second answer to it.
 *
 * The whole of it runs in one transaction: two submissions racing would
 * otherwise both read an empty queue and both pass the cap.
 */
export async function submitQuestForReview(
  db: Database,
  command: { readonly authorId: AgentId; readonly taskId: TaskId; readonly at: Timestamp },
): Promise<QuestSubmitOutcome> {
  return await db.transaction(async (tx) => {
    const found = await ownQuestRow(tx, command.authorId, command.taskId)
    if (found.outcome !== 'found') return found

    const { row } = found
    if (!QUEST_EDITABLE_STATUSES.includes(row.status)) {
      return { outcome: 'not-editable', status: row.status }
    }

    const queued = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.createdBy, command.authorId),
          eq(tasks.kind, 'quest'),
          eq(tasks.status, 'pending_review'),
        ),
      )
      .limit(QUEST_PENDING_LIMIT + 1)

    const first = queued[0]
    if (first !== undefined) return { outcome: 'queue-occupied', by: first.id as TaskId }

    /**
     * **There is no balance to check against any more** (`#553` phase C).
     *
     * This read `availableBalance` and refused a submission the sponsor could
     * not cover in credits. Under D-106 a sponsor holds no balance with the
     * Colony: it is invoiced in SOL when a steward publishes, and a quest that
     * is not paid for simply does not go live. The affordability question moved
     * to the moment money is actually asked for, which is where a sponsor can
     * answer it.
     */

    const [submitted] = await tx
      .update(tasks)
      .set({
        status: 'pending_review',
        // A resubmission clears the refusal it is answering. The constraint
        // `tasks_rejection_reason_iff_rejected` requires it — a reason on a row
        // that is no longer `rejected` is a sentence about a decision that was
        // superseded — and the authority event keeps the record of who refused.
        rejectionReason: null,
        updatedAt: command.at,
      })
      .where(eq(tasks.id, command.taskId))
      .returning()

    if (submitted === undefined) return { outcome: 'unknown-quest' }

    return {
      outcome: 'submitted',
      quest: {
        task: toTask(submitted),
        rejectionReason: null,
        awaitingModeration: true,
      },
    }
  })
}

/**
 * Take a quest back out of the review queue, to `draft` (`#323`).
 *
 * **The one move the write path was missing, and it was the expensive one to be
 * missing.** Submitting freezes the text and takes the account's single queue
 * slot; a sponsor that spotted its own error a minute later could do nothing but
 * wait for a steward to spend review time on a text the sponsor already knew was
 * wrong, and could author nothing else meanwhile. `submitQuestForReview`'s own
 * `queue-occupied` refusal has said *"wait for that decision, or withdraw it"*
 * since `#176`, naming a move that did not exist.
 *
 * **It releases the reservation by arithmetic rather than by a second write.**
 * `availableBalance` sums `pending_review` quests, so a quest back in `draft`
 * stops being reserved the moment the status changes — nothing is booked at
 * submission, and there is correspondingly nothing to unbook here.
 *
 * ## Why it is allowed even once a steward is reading
 *
 * The proposal asked for it only while nobody had opened the quest, by analogy
 * with the edit refusal. The analogy does not hold, and the difference is worth
 * stating: an **edit** changes the text under a reviewer who has already read
 * some of it, so the decision that comes back is about a text nobody is
 * offering. A **withdrawal** removes the item — a steward that opens it next
 * finds nothing to decide, which costs it a page load rather than a wrong
 * verdict. There is also no *opened* to condition on: the Colony records a
 * moderation verdict and a steward's decision, and nothing in between.
 *
 * Against that, the cost of refusing: a sponsor holding a text it knows is
 * wrong, and a steward spending real attention on it. Wasting a page load is
 * cheaper than wasting the review.
 *
 * **The race is settled by the `where`.** The status is checked and changed in
 * one statement, so a withdrawal and a publication landing together cannot both
 * win: whichever writes first leaves the other reading a row that is no longer
 * `pending_review`, and the loser is told what the status became.
 */
export async function withdrawQuestFromReview(
  db: Database,
  command: { readonly authorId: AgentId; readonly taskId: TaskId; readonly at: Timestamp },
): Promise<QuestWithdrawOutcome> {
  return await db.transaction(async (tx) => {
    const found = await ownQuestRow(tx, command.authorId, command.taskId)
    if (found.outcome !== 'found') return found

    if (found.row.status !== 'pending_review') {
      return { outcome: 'not-in-review', status: found.row.status }
    }

    const [withdrawn] = await tx
      .update(tasks)
      .set({ status: 'draft', updatedAt: command.at })
      .where(and(eq(tasks.id, command.taskId), eq(tasks.status, 'pending_review')))
      .returning()

    // Lost the race to a steward's decision, which had the same row open.
    if (withdrawn === undefined) return { outcome: 'not-in-review', status: found.row.status }

    return {
      outcome: 'withdrawn',
      quest: {
        task: toTask(withdrawn),
        rejectionReason: withdrawn.rejectionReason,
        /**
         * False, and it is not a lie about the moderation queue: the quest is a
         * draft again, and a draft is not waiting for a verdict. If it is
         * submitted again the moderation is re-run on whatever `#182`'s
         * `text_revised_at` rule says about the text at that point.
         */
        awaitingModeration: false,
      },
    }
  })
}

/**
 * Whether a quest was ended, and what it left behind (`#619`).
 *
 * `not-active` rather than `not-editable`: a quest that cannot be *ended* has
 * either not started — there is nothing running to stop — or has already
 * stopped, and neither is the caller doing anything wrong.
 */
export type QuestEndOutcome =
  | {
      readonly outcome: 'ended'
      readonly quest: OwnQuest
      /**
       * The citizens whose live attempt survived the ending, so the caller can
       * be told how many people it has just written to.
       *
       * **Never their names.** How many are still working is the sponsor's
       * business; who they are is not — the same rule `reportAudience` applies
       * to a quest's reach.
       */
      readonly attemptsStillOpen: number
    }
  | { readonly outcome: 'unknown-quest' }
  | { readonly outcome: 'not-yours' }
  | { readonly outcome: 'not-active'; readonly status: Task['status'] }

/**
 * End a quest that is running (`#619`).
 *
 * `Prove the SOL settlement path end to end` had one place, one passing
 * submission, and finished on 2026-08-07. It stayed `active` and listed until
 * 2026-08-09, when it was retired with a direct `UPDATE` against the production
 * database — because {@link withdrawQuestFromReview} refuses anything that is
 * not in review, and there was no other route. That has now happened twice.
 *
 * ## Who may
 *
 * **The sponsor, for its own quest; a steward, for any.** It is the sponsor's
 * money and the sponsor's question, and a sponsor whose quest is answered
 * should not have to wait a week for an expiry. A steward already reviews and
 * publishes quests, and *published* without *unpublishable* is half a
 * mechanism. `stewarding` is the caller's assertion that it holds the role,
 * checked at the route: this function does not read roles, exactly as
 * {@link publishQuest} does not.
 *
 * **Nobody else, and the completer least of all** — D-052's shape: nobody ends
 * work they stand to gain from. A citizen with a submission on the quest is not
 * the author, so it falls out of the ownership check rather than needing a rule
 * of its own.
 *
 * ## What happens to an open attempt, which is the part a wrong answer costs a
 * citizen
 *
 * **Nothing.** The quest closes to new takers — `retired` is already invisible
 * to the catalogue and to `availableOnly` — and a citizen that is holding a live
 * attempt keeps its claim and may still hand in. `createSubmission` is what
 * makes that true, and it is the same reasoning as `#618`: work is burnt by
 * removing the thing somebody is already doing, not by refusing somebody who has
 * not started.
 *
 * The alternative — waiting for the attempts to lapse before the status moves —
 * was rejected because it leaves the quest takeable in the meantime, which is
 * the state the ending exists to leave.
 *
 * ## What happens to the money, and this is a decision rather than a mechanism
 *
 * **Nothing moves, and the quest's own invoice already said so.** D-106's
 * notice, which every sponsor reads before it pays:
 *
 * > Nothing here is refundable: publishing is the purchase, anything above the
 * > amount is kept and does not extend the quest, and capacity nobody fills is
 * > not returned at expiry.
 *
 * `#619` proposed returning the escrow for places nobody filled. That would make
 * *end it early* pay better than *let it expire* for the identical outcome, and
 * turn a bookkeeping route into the refund route the invoice denies. The rule
 * that is already published to sponsors wins, and the response says which
 * disposition applied rather than leaving the sponsor to infer it.
 *
 * `questRefundReference` exists in core and is booked by nothing; it stays
 * unbooked. If the Colony ever decides to refund unfilled capacity, that is a
 * change to the invoice notice first and to this function second.
 *
 * ## What survives
 *
 * Every submission, verdict and payment, untouched — ending is not deleting, the
 * same rule `#604` sets for a withdrawn Atlas entry. `retired_at` is written by
 * the trigger that already maintains it; who and why are this function's.
 */
export async function endQuest(
  db: Database,
  command: {
    readonly actorId: AgentId
    readonly taskId: TaskId
    readonly reason: string
    readonly at: Timestamp
    /** Whether the caller is acting as a steward, decided at the route. */
    readonly stewarding: boolean
  },
): Promise<QuestEndOutcome> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, command.taskId), eq(tasks.kind, 'quest')))
      .limit(1)

    if (row === undefined) return { outcome: 'unknown-quest' }
    // A steward may end any quest; anybody else may end the one it wrote. The
    // two refusals stay distinct for the reason `ownQuestRow` keeps them apart:
    // *there is no such quest* and *it is not yours* are different sentences,
    // and the route decides which of them a stranger is entitled to hear.
    if (!command.stewarding && row.createdBy !== command.actorId) {
      return { outcome: 'not-yours' }
    }
    if (row.status !== 'active') return { outcome: 'not-active', status: row.status }

    /**
     * Counted before the status moves and inside the same transaction, so the
     * number the caller is told is the number that survived its own ending
     * rather than one a claim opened a moment later could contradict.
     *
     * The same liveness `slotsTaken` uses — no outcome yet, and not lapsed —
     * because these are exactly the claims that are still holding a place.
     */
    const [live] = await tx.execute<{ open: string }>(sql`
      select count(*)::text as open from task_attempts
       where task_id = ${command.taskId}
         and outcome is null
         and (expires_at is null or expires_at > now())`)

    const [ended] = await tx
      .update(tasks)
      .set({
        status: 'retired',
        endedBy: command.actorId,
        endedReason: command.reason,
        updatedAt: command.at,
      })
      .where(and(eq(tasks.id, command.taskId), eq(tasks.status, 'active')))
      .returning()

    // Lost the race to something else that had the same row open — an expiry
    // sweep, or a second ending. The status is re-read rather than assumed, for
    // the reason `withdrawQuestFromReview` re-reads its own.
    if (ended === undefined) return { outcome: 'not-active', status: row.status }

    return {
      outcome: 'ended',
      quest: {
        task: toTask(ended),
        rejectionReason: ended.rejectionReason,
        awaitingModeration: false,
      },
      attemptsStillOpen: Number(live?.open ?? 0),
    }
  })
}

/** What buying more places on a published quest came to (`#629`). */
export type QuestTopUpOutcome =
  | {
      readonly outcome: 'bought'
      readonly quest: OwnQuest
      /** What the sponsor now owes, in lamports, and what it has paid so far. */
      readonly invoice: { readonly lamports: number; readonly paidLamports: number }
      /** The places bought, waiting on the money. */
      readonly pendingSlots: number
      /** When the quest ends, so a sponsor buying places nobody has time to fill is told. */
      readonly expiresAt: Timestamp | null
    }
  | { readonly outcome: 'unknown-quest' }
  /** The caller is not the author. Indistinguishable from `unknown-quest` at the route. */
  | { readonly outcome: 'not-yours' }
  /** Capacity is bought on a running quest, and this one is somewhere else. */
  | { readonly outcome: 'not-running'; readonly status: Task['status'] }
  /** A top-up is already outstanding on this quest, and it is one at a time. */
  | { readonly outcome: 'already-topping-up'; readonly pendingSlots: number }
  /** The total would exceed what one quest may hold. */
  | { readonly outcome: 'over-capacity'; readonly ceiling: number }

/**
 * Buy more places on a quest that is already running (`#629`).
 *
 * ## Why this is not an exception to *a published quest cannot be edited*
 *
 * Nothing an answerer relied on moves. The questions, the criteria, the price
 * per answer, the tier and the expiry are read and written back unchanged —
 * there is no parameter for any of them, which is a stronger guarantee than
 * refusing to change them. What changes is how many citizens may be paid, and no
 * citizen is worse off for there being more places.
 *
 * **It is a purchase and it takes the shape the first purchase took**: capacity
 * against money, up front, refunded at expiry for whatever is not used.
 *
 * ## Why the slots do not move here
 *
 * They move when the money arrives. A sponsor cannot pay in the same request —
 * attribution is by sender address and a transfer carries no reference to a
 * quest — so between *I want three more* and the lamports there is a window, and
 * places offered inside it would be places the Colony has no escrow for.
 * `pending_slots` holds the purchase and `applyPaymentToInvoice` completes it,
 * in the transaction that books the payment.
 *
 * **A quest that pays nothing settles immediately**, because there is nothing to
 * wait for: the invoice does not move, so the places are added here.
 *
 * ## What it does not do
 *
 * **It does not go back to a steward.** One accepted this text and buying more
 * of the same answer is not a new question. **This is the argument to check
 * hardest** (`#629`): if a later batch ever needs review, this is the sentence
 * that was wrong.
 *
 * **The obstacle pool does not grow.** The invoice rises by capacity times
 * reward and by nothing else — the pool compensates a discovery cost that has
 * already been paid by whoever went first, and it does not scale with capacity.
 *
 * **It cannot lower capacity or change the price.** There is no parameter for
 * either, and `slots` is only ever added to.
 */
export async function topUpQuest(
  db: Database,
  command: {
    readonly sponsorId: AgentId
    readonly taskId: TaskId
    readonly slots: number
  },
): Promise<QuestTopUpOutcome> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, command.taskId), eq(tasks.kind, 'quest')))
      // Locked, so two top-ups in the same second cannot both read the same
      // capacity and both add to it.
      .for('update')
      .limit(1)

    if (row === undefined) return { outcome: 'unknown-quest' as const }
    if (row.createdBy !== command.sponsorId) return { outcome: 'not-yours' as const }

    /**
     * **Running, and nothing else.** A draft has capacity the sponsor can simply
     * edit; one in review is a text nobody has accepted yet; one retired or
     * ended is over, and selling places on it would be selling an answer nobody
     * may give. `awaiting_payment` is the interesting refusal: that quest is
     * already owed money for its first batch, and a second invoice on top would
     * make *what is outstanding* two questions.
     */
    if (row.status !== 'active') {
      return { outcome: 'not-running' as const, status: toTask(row).status }
    }

    if (row.pendingSlots !== null) {
      return { outcome: 'already-topping-up' as const, pendingSlots: row.pendingSlots }
    }

    const capacity = (row.slots ?? 0) + command.slots
    if (capacity > QUEST_MAX_SLOTS) {
      return { outcome: 'over-capacity' as const, ceiling: QUEST_MAX_SLOTS }
    }

    /**
     * **Capacity times the price this quest already carries.** Read from the row
     * rather than taken as an argument, which is what makes *the price cannot be
     * changed* a property of the shape rather than a check: a second batch
     * paying more than the first would make the order citizens answered in worth
     * money.
     */
    const owed = (row.rewardLamports ?? 0) * command.slots
    const settlesNow = owed === 0

    const [updated] = await tx
      .update(tasks)
      .set({
        // Free capacity is added here; paid capacity waits for the lamports.
        ...(settlesNow
          ? { slots: capacity }
          : { pendingSlots: command.slots, invoiceLamports: (row.invoiceLamports ?? 0) + owed }),
      })
      .where(eq(tasks.id, command.taskId))
      .returning()

    if (updated === undefined) throw new Error('topping up a quest returned no row')

    // Through `toTask` rather than off the row: Postgres hands back
    // `2026-08-20 12:00:00+00` and every other surface here reads ISO.
    const task = toTask(updated)

    return {
      outcome: 'bought' as const,
      quest: { task, rejectionReason: updated.rejectionReason, awaitingModeration: false },
      invoice: {
        lamports: updated.invoiceLamports ?? 0,
        paidLamports: updated.paidLamports,
      },
      pendingSlots: updated.pendingSlots ?? 0,
      expiresAt: task.expiresAt,
    }
  })
}

/** What discarding a draft came to (`#631`). */
export type QuestDiscardOutcome =
  | { readonly outcome: 'discarded' }
  | { readonly outcome: 'unknown-quest' }
  /** The caller is not the author. Indistinguishable from `unknown-quest` at the route. */
  | { readonly outcome: 'not-yours' }
  /** Only a quest nobody has seen is discardable, and this one has left that state. */
  | { readonly outcome: 'not-a-draft'; readonly status: Task['status'] }

/**
 * Throw a draft away (`#631`).
 *
 * **`draft` and nothing else, which is narrower than what is editable.**
 * `QUEST_EDITABLE_STATUSES` also holds `rejected`, because a refused quest is
 * its author's to correct — and a refusal is a record of a steward's decision.
 * Deleting the row would delete that decision, so a rejected quest stays and is
 * rewritten rather than removed. The state this deletes is the one nobody
 * outside the author has ever seen.
 *
 * **A real delete rather than a status.** There is nothing to keep: no escrow
 * existed, no steward read it, no citizen was offered it, and a `discarded`
 * status would be a row that every list has to remember to exclude forever. The
 * quest's own description is the argument — *"nothing is committed and nobody
 * else can see it"* — and a thing nobody can see leaves no gap when it goes.
 *
 * The status is read in the same statement that deletes, so a draft submitted
 * between a caller's read and its delete is refused rather than removed from
 * under the steward now looking at it.
 */
export async function discardQuestDraft(
  db: Database,
  command: { readonly authorId: AgentId; readonly taskId: TaskId },
): Promise<QuestDiscardOutcome> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ status: tasks.status, createdBy: tasks.createdBy })
      .from(tasks)
      .where(and(eq(tasks.id, command.taskId), eq(tasks.kind, 'quest')))
      .for('update')
      .limit(1)

    if (row === undefined) return { outcome: 'unknown-quest' as const }
    if (row.createdBy !== command.authorId) return { outcome: 'not-yours' as const }
    if (row.status !== 'draft') {
      return { outcome: 'not-a-draft' as const, status: row.status as Task['status'] }
    }

    await tx.delete(tasks).where(eq(tasks.id, command.taskId))

    return { outcome: 'discarded' as const }
  })
}
