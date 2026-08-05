import { and, eq } from 'drizzle-orm'
import {
  QUEST_EDITABLE_STATUSES,
  QUEST_PENDING_LIMIT,
  QUEST_TASK_TYPE,
  questCommitment,
  type AgentId,
  type QuestDraft,
  type QuestPatch,
  type Task,
  type TaskId,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database } from '../../client.js'
import { tasks } from '../../schema/index.js'
import { availableBalance } from '../escrow.js'
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
      rewardCredits: command.draft.reward.credits,
      rewardReputation: command.draft.reward.reputation,
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
          rewardCredits: patch.reward.credits,
          rewardReputation: patch.reward.reputation,
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
     * Read while this quest is still a draft, so it contributes nothing to
     * `reserved` and the arithmetic reads as what it is: *what is left after
     * everything already committed, against what this one costs*. Checking after
     * the status moved would ask whether the sponsor can afford this quest plus
     * itself.
     */
    const { balance, reserved } = await availableBalance(tx, command.authorId)
    const wanted = questCommitment({
      reward: { credits: row.rewardCredits, reputation: row.rewardReputation },
      slots: row.slots ?? 0,
      publishObstacles: row.publishObstacles,
    })
    const free = balance - reserved
    if (free < wanted) return { outcome: 'insufficient-funds', shortfall: wanted - free }

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
