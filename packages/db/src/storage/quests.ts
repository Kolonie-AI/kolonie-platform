import { createHash } from 'node:crypto'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import {
  QUEST_EDITABLE_STATUSES,
  QUEST_PENDING_LIMIT,
  QUEST_TASK_TYPE,
  questCommitment,
  type AgentId,
  type ModerationStages,
  type QuestDraft,
  type QuestPatch,
  type Task,
  type TaskId,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { questModerations, tasks } from '../schema/index.js'
import { availableBalance, fundQuestEscrow } from './escrow.js'
import { recordAuthorityEvent } from './roles.js'
import { toTask } from './rows.js'

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

/** What a sponsor's own quest looks like to it: the task, plus why it was refused. */
export interface OwnQuest {
  readonly task: Task
  /** The steward's reason, on a refused quest and nowhere else. */
  readonly rejectionReason: string | null
  /** Whether this quest is still waiting for the moderation stage (`#176`). */
  readonly awaitingModeration: boolean
}

/** A quest the moderator has not judged since its text last changed. */
export interface PendingQuest {
  readonly id: TaskId
  readonly title: string
  readonly description: string
  readonly instructions: string
}

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

export type QuestPublishOutcome =
  | { readonly outcome: 'published'; readonly escrowed: number }
  | { readonly outcome: 'unknown-quest' }
  | { readonly outcome: 'not-in-review'; readonly status: Task['status'] }
  /** Nobody publishes a quest it wrote (`#173`). */
  | { readonly outcome: 'own-quest' }
  /** The moderation stage has not answered yet, so no steward is entitled to see it. */
  | { readonly outcome: 'awaiting-moderation' }
  | { readonly outcome: 'insufficient-funds'; readonly shortfall: number }

export type QuestRefuseOutcome =
  | { readonly outcome: 'refused' }
  | { readonly outcome: 'unknown-quest' }
  | { readonly outcome: 'not-in-review'; readonly status: Task['status'] }
  | { readonly outcome: 'own-quest' }

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
      timeoutHours: command.draft.timeoutHours,
      assistanceAllowed: command.draft.assistanceAllowed,
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
    const textChanged =
      (patch.title !== undefined && patch.title !== row.title) ||
      (patch.description !== undefined && patch.description !== row.description) ||
      (patch.instructions !== undefined && patch.instructions !== row.instructions)

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
        ...(patch.timeoutHours !== undefined && { timeoutHours: patch.timeoutHours }),
        ...(patch.assistanceAllowed !== undefined && {
          assistanceAllowed: patch.assistanceAllowed,
        }),
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

/** Every quest this account has written, newest first. */
export async function listOwnQuests(db: Database, authorId: AgentId): Promise<readonly OwnQuest[]> {
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.createdBy, authorId), eq(tasks.kind, 'quest')))
    .orderBy(desc(tasks.createdAt))

  const pending = await unmoderatedIds(
    db,
    rows.filter((row) => row.status === 'pending_review').map((row) => row.id as TaskId),
  )

  return rows.map((row) => ({
    task: toTask(row),
    rejectionReason: row.rejectionReason,
    awaitingModeration: pending.has(row.id as TaskId),
  }))
}

/** One of this account's own quests, in any status. */
export async function readOwnQuest(
  db: Database,
  authorId: AgentId,
  taskId: TaskId,
): Promise<OwnQuest | undefined> {
  const found = await ownQuestRow(db, authorId, taskId)
  if (found.outcome !== 'found') return undefined

  const pending = await unmoderatedIds(db, [taskId])

  return {
    task: toTask(found.row),
    rejectionReason: found.row.rejectionReason,
    awaitingModeration: pending.has(taskId),
  }
}

/**
 * The steward's queue: quests awaiting review that the moderator has cleared.
 *
 * **A quest the moderation stage has not answered about is not in this list**,
 * and that is the acceptance criterion rather than an optimisation. A steward
 * should not have to read unmoderated text from strangers as part of its job,
 * and a red-line quest is refused mechanically — so the queue is defined as
 * *approved by the moderator and not yet decided by a human*, never as
 * *everything in `pending_review`*.
 */
export async function questReviewQueue(db: Database): Promise<readonly Task[]> {
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.kind, 'quest'), eq(tasks.status, 'pending_review'), moderationCleared()))
    .orderBy(asc(tasks.updatedAt))

  return rows.map((row) => toTask(row))
}

/**
 * Publish a quest and move its money, in one transaction.
 *
 * **The status change and the escrow booking commit together or neither
 * commits.** A published quest whose money did not move is the exact failure the
 * prepay model exists to prevent, and a two-step version has a window in which it
 * is true. `fundQuestEscrow` is called inside this transaction for that reason
 * and takes a `Transaction` in its signature so it cannot be called outside one.
 *
 * **A steward never edits.** There is no parameter here that changes the text,
 * and there is no route that does either — a steward that edited would become
 * the author, and the self-approval ban would have been walked around rather
 * than enforced.
 */
export async function publishQuest(
  db: Database,
  command: { readonly stewardId: AgentId; readonly taskId: TaskId; readonly at: Timestamp },
): Promise<QuestPublishOutcome> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, command.taskId), eq(tasks.kind, 'quest')))
      .limit(1)

    if (row === undefined) return { outcome: 'unknown-quest' }
    if (row.status !== 'pending_review') return { outcome: 'not-in-review', status: row.status }

    /**
     * The self-approval ban, applied at the write rather than only at the route
     * (`#173`). `mayActOnQuest` in the API is the same rule for a caller that
     * already holds both sides in memory; this is the one no route can skip.
     */
    if (row.createdBy === command.stewardId) return { outcome: 'own-quest' }

    const [cleared] = await tx
      .select({ id: questModerations.id })
      .from(questModerations)
      .where(
        and(
          eq(questModerations.taskId, command.taskId),
          eq(questModerations.decision, 'approved'),
          // The row's own timestamp rather than a correlated subquery: the task
          // is already read and locked by this transaction, so the comparison is
          // against a value in hand.
          sql`${questModerations.createdAt} >= ${row.textRevisedAt}`,
        ),
      )
      .limit(1)

    if (cleared === undefined) return { outcome: 'awaiting-moderation' }

    const sponsorId = row.createdBy as AgentId | null
    const capacity = row.slots ?? 0
    const total = row.rewardCredits * capacity

    if (sponsorId !== null && total > 0) {
      const { balance, reserved } = await availableBalance(tx, sponsorId)
      // `reserved` includes this quest, since it is still `pending_review`. What
      // has to be covered is therefore the whole reservation and not this quest
      // alone — a sponsor with two quests queued and money for one must not
      // publish either on the strength of the other's reservation lapsing later.
      if (balance < reserved) {
        return { outcome: 'insufficient-funds', shortfall: reserved - balance }
      }
    }

    const escrowed =
      sponsorId === null
        ? 0
        : await fundQuestEscrow(tx, {
            taskId: command.taskId,
            sponsorId,
            credits: row.rewardCredits,
            capacity,
          })

    await tx
      .update(tasks)
      .set({ status: 'active', updatedAt: command.at })
      .where(eq(tasks.id, command.taskId))

    await recordAuthorityEvent(tx, {
      actorId: command.stewardId,
      action: 'quest-published',
      subjectTaskId: command.taskId,
      ...(sponsorId !== null && { subjectAgentId: sponsorId }),
    })

    return { outcome: 'published', escrowed }
  })
}

/**
 * Refuse a quest, with a reason its author reads.
 *
 * **Nothing is unbooked, because nothing was booked.** The reservation is
 * computed over `pending_review` and `active` quests, so a refused quest simply
 * stops counting — which is `#174`'s design and the reason this function moves
 * no money.
 */
export async function refuseQuest(
  db: Database,
  command: {
    readonly stewardId: AgentId
    readonly taskId: TaskId
    readonly reason: string
    readonly at: Timestamp
  },
): Promise<QuestRefuseOutcome> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, command.taskId), eq(tasks.kind, 'quest')))
      .limit(1)

    if (row === undefined) return { outcome: 'unknown-quest' }
    if (row.status !== 'pending_review') return { outcome: 'not-in-review', status: row.status }
    if (row.createdBy === command.stewardId) return { outcome: 'own-quest' }

    await tx
      .update(tasks)
      .set({ status: 'rejected', rejectionReason: command.reason, updatedAt: command.at })
      .where(eq(tasks.id, command.taskId))

    await recordAuthorityEvent(tx, {
      actorId: command.stewardId,
      action: 'quest-refused',
      subjectTaskId: command.taskId,
      ...(row.createdBy !== null && { subjectAgentId: row.createdBy as AgentId }),
    })

    return { outcome: 'refused' }
  })
}

/**
 * Quests the moderator has not judged since their text last changed.
 *
 * The moderation runner's queue. Ordered oldest first so a quest cannot be
 * starved by newer arrivals — a sponsor waiting on a steward is waiting on a
 * human, and a sponsor waiting on a model should not be waiting at all.
 */
export async function pendingQuestModerations(
  db: Database,
  limit: number,
): Promise<readonly PendingQuest[]> {
  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      instructions: tasks.instructions,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.kind, 'quest'),
        eq(tasks.status, 'pending_review'),
        sql`not exists (
          select 1 from ${questModerations}
          where ${questModerations.taskId} = ${tasks.id}
            and ${questModerations.createdAt} >= ${tasks.textRevisedAt}
        )`,
      ),
    )
    .orderBy(asc(tasks.updatedAt))
    .limit(limit)

  return rows.map((row) => ({
    id: row.id as TaskId,
    title: row.title,
    description: row.description,
    instructions: row.instructions,
  }))
}

/**
 * Write a moderation verdict, and refuse the quest if it crossed a line.
 *
 * **A rejection is a refusal of the quest and not a note about it**, so the
 * verdict row and the status change commit together. The sponsor reads the same
 * `rejection_reason` field a steward's refusal writes — it was refused, and by
 * what is a question the authority record answers rather than the task row.
 *
 * Answers `stale` when the quest has left `pending_review` or its text has moved
 * since the moderator read it, the same guard `recordModeration` applies for the
 * same reason: a verdict about a text nobody is offering must not be applied to
 * the text that replaced it.
 */
export async function recordQuestModeration(
  db: Database,
  input: {
    readonly taskId: TaskId
    readonly decision: 'approved' | 'rejected'
    readonly reason?: string | undefined
    readonly model: string
    readonly stages: ModerationStages
    /** The text the moderator judged, as it read it. */
    readonly judged: Pick<PendingQuest, 'title' | 'description' | 'instructions'>
  },
): Promise<{ readonly outcome: 'written' | 'stale' }> {
  return await db.transaction(async (tx) => {
    const [row] = await tx.select().from(tasks).where(eq(tasks.id, input.taskId)).limit(1)

    if (row === undefined) return { outcome: 'stale' as const }
    if (row.status !== 'pending_review') return { outcome: 'stale' as const }
    if (
      row.title !== input.judged.title ||
      row.description !== input.judged.description ||
      row.instructions !== input.judged.instructions
    ) {
      return { outcome: 'stale' as const }
    }

    await tx.insert(questModerations).values({
      taskId: input.taskId,
      decision: input.decision,
      model: input.model,
      stages: input.stages,
      contentSha256: questTextDigest(input.judged),
    })

    if (input.decision === 'rejected') {
      await tx
        .update(tasks)
        .set({
          status: 'rejected',
          // The constraint requires a reason on a rejected row, and a refusal
          // the author cannot read is the failure it exists to prevent. The
          // fallback is never expected to be used and is not an excuse for a
          // caller that supplies nothing.
          rejectionReason:
            input.reason ??
            'This quest crosses one of the Colony’s red lines (governance/red-lines.md).',
        })
        .where(eq(tasks.id, input.taskId))
    }

    return { outcome: 'written' as const }
  })
}

/**
 * The digest of what was judged.
 *
 * The three fields joined by a character none of them can contain, so that
 * moving text between the title and the description cannot produce the same
 * digest as leaving it where it was.
 */
export function questTextDigest(
  text: Pick<PendingQuest, 'title' | 'description' | 'instructions'>,
): string {
  return createHash('sha256')
    .update([text.title, text.description, text.instructions].join(' '))
    .digest('hex')
}

/** Whether a task has a moderation verdict at least as new as its text. */
const moderationCleared = () =>
  sql`exists (
    select 1 from ${questModerations}
    where ${questModerations.taskId} = ${tasks.id}
      and ${questModerations.decision} = 'approved'
      and ${questModerations.createdAt} >= ${tasks.textRevisedAt}
  )`

/** Which of these quests are still waiting on the moderator. */
async function unmoderatedIds(
  db: Database,
  taskIds: readonly TaskId[],
): Promise<ReadonlySet<TaskId>> {
  if (taskIds.length === 0) return new Set()

  const rows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        inArray(tasks.id, [...taskIds]),
        sql`not exists (
          select 1 from ${questModerations}
          where ${questModerations.taskId} = ${tasks.id}
            and ${questModerations.createdAt} >= ${tasks.textRevisedAt}
        )`,
      ),
    )

  return new Set(rows.map((row) => row.id as TaskId))
}

/** One of this account's quests, or why it is not. */
async function ownQuestRow(
  db: Database | Transaction,
  authorId: AgentId,
  taskId: TaskId,
): Promise<
  | { readonly outcome: 'found'; readonly row: typeof tasks.$inferSelect }
  | { readonly outcome: 'unknown-quest' }
  | { readonly outcome: 'not-yours' }
> {
  const [row] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.kind, 'quest')))
    .limit(1)

  if (row === undefined) return { outcome: 'unknown-quest' }
  if (row.createdBy !== authorId) return { outcome: 'not-yours' }

  return { outcome: 'found', row }
}

/**
 * Quests written by the Colony itself, which is none of them.
 *
 * Exported so a test can assert the invariant rather than assume it: every
 * `quest` row has an author, because the only path that writes one takes the
 * author from a credential. A Colony-authored quest would be the Colony paying
 * itself, and `governance/economy.md` §2 is what that would walk around.
 */
export async function ownerlessQuestDrafts(db: Database): Promise<number> {
  const [row] = await db
    .select({ count: sql<string>`count(*)::text` })
    .from(tasks)
    .where(
      and(
        eq(tasks.kind, 'quest'),
        isNull(tasks.createdBy),
        inArray(tasks.status, ['draft', 'pending_review']),
      ),
    )

  return Number(row?.count ?? 0)
}
