import { createHash } from 'node:crypto'
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import {
  QUEST_EDITABLE_STATUSES,
  QuestAnswersSchema,
  StoredQuestQuestionsSchema,
  QUEST_PENDING_LIMIT,
  QUEST_TASK_TYPE,
  questCommitment,
  type AgentId,
  type ModerationStages,
  type QuestDraft,
  type QuestPatch,
  type QuestQuestion,
  type SubmissionId,
  type Task,
  type TaskId,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import {
  agents,
  questAnswers,
  questModerations,
  submissions,
  tasks,
  verifications,
} from '../schema/index.js'
import { availableBalance, fundQuestEscrow } from './escrow.js'
import { recordAuthorityEvent } from './roles.js'
import { toTask, toTimestamp } from './rows.js'

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

/** The quest as the `quest-report` verifier needs it (`#177`). */
export interface QuestDefinition {
  readonly title: string
  readonly instructions: string
  readonly questions: readonly QuestQuestion[]
  readonly proofVerifier: string | null
}

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

/**
 * The quest as the verifier needs it: what it asks, and what proves it
 * (`#177`).
 *
 * A read of the task row and nothing else. It is separate from {@link readOwnQuest}
 * because the two answer different questions for different readers — that one is
 * the sponsor's view of its own quest, this one is what the runner needs in
 * order to judge a report against it, and neither should grow the other's
 * fields.
 */
export async function questDefinition(
  db: Database,
  taskId: TaskId,
): Promise<QuestDefinition | undefined> {
  const [row] = await db
    .select({
      title: tasks.title,
      instructions: tasks.instructions,
      questions: tasks.questions,
      proofVerifier: tasks.proofVerifier,
      kind: tasks.kind,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)

  if (row === undefined || row.kind !== 'quest') return undefined

  return {
    title: row.title,
    instructions: row.instructions,
    questions: StoredQuestQuestionsSchema.parse(row.questions),
    proofVerifier: row.proofVerifier,
  }
}

/** One answer as the scrub left it. */
export interface ScrubbedAnswer {
  readonly questionKey: string
  readonly text: string
}

/**
 * The scrubbed answers to one submission, or `undefined` if the scrub has not
 * run.
 *
 * **`undefined` and `[]` are different answers**, and the verifier branches on
 * exactly that: not-yet-moderated is `pending`, and moderated-to-nothing cannot
 * happen because stage 1 already refused an empty report.
 */
export async function scrubbedAnswers(
  db: Database,
  submissionId: SubmissionId,
): Promise<readonly ScrubbedAnswer[] | undefined> {
  const rows = await db
    .select({ questionKey: questAnswers.questionKey, text: questAnswers.text })
    .from(questAnswers)
    .where(eq(questAnswers.submissionId, submissionId))
    .orderBy(asc(questAnswers.questionKey))

  return rows.length === 0 ? undefined : rows
}

/** A report the moderator has not scrubbed yet, as the runner reads it. */
export interface UnmoderatedReport {
  readonly submissionId: SubmissionId
  readonly taskId: TaskId
  readonly questTitle: string
  readonly answers: readonly ScrubbedAnswer[]
}

/**
 * Reports waiting for the scrub: submitted, undecided, and with no answers
 * written yet.
 *
 * The raw answers come out of the submission's payload, which is the Colony's
 * own record of what was handed in. They go no further than the moderator —
 * what any other reader gets is what {@link writeScrubbedAnswers} stores.
 */
export async function pendingAnswerModerations(
  db: Database,
  limit: number,
): Promise<readonly UnmoderatedReport[]> {
  const rows = await db
    .select({
      submissionId: submissions.id,
      taskId: submissions.taskId,
      payload: submissions.payload,
      questTitle: tasks.title,
    })
    .from(submissions)
    .innerJoin(tasks, eq(tasks.id, submissions.taskId))
    .where(
      and(
        eq(tasks.kind, 'quest'),
        inArray(submissions.status, ['pending', 'verifying']),
        sql`not exists (
          select 1 from ${questAnswers} where ${questAnswers.submissionId} = ${submissions.id}
        )`,
      ),
    )
    .orderBy(asc(submissions.submittedAt))
    .limit(limit)

  return rows.map((row) => ({
    submissionId: row.submissionId as SubmissionId,
    taskId: row.taskId as TaskId,
    questTitle: row.questTitle,
    answers: Object.entries(QuestAnswersSchema.parse((row.payload as QuestPayload).answers ?? {}))
      .map(([questionKey, text]) => ({ questionKey, text }))
      .sort((left, right) => left.questionKey.localeCompare(right.questionKey)),
  }))
}

/** The shape of a quest submission's payload, as far as this file reads it. */
interface QuestPayload {
  readonly answers?: unknown
}

/**
 * Store the scrubbed answers, once.
 *
 * **Scrub on write, never on read.** `#178` states the rule and the reason: a
 * scrub applied at read time is a scrub somebody will forget to apply on the
 * export. There is exactly one scrubbed text per answer and no path that serves
 * the unscrubbed one — that stays in the submission payload, which no reader
 * outside the Colony reaches.
 *
 * `onConflictDoNothing` rather than an upsert: the thing that would write twice
 * is the scrub running again over a submission whose first pass committed while
 * the runner believed it had failed, and the first scrub is the one the verdict
 * will have been reached against.
 */
export async function writeScrubbedAnswers(
  db: Database,
  input: {
    readonly submissionId: SubmissionId
    readonly taskId: TaskId
    readonly answers: readonly ScrubbedAnswer[]
  },
): Promise<{ readonly written: number }> {
  if (input.answers.length === 0) return { written: 0 }

  // One id for the whole report, generated here: it is what holds the answers
  // together after an erasure has taken the submission they were handed in with.
  const reportId = crypto.randomUUID()

  const rows = await db
    .insert(questAnswers)
    .values(
      input.answers.map((answer) => ({
        submissionId: input.submissionId,
        reportId,
        taskId: input.taskId,
        questionKey: answer.questionKey,
        text: answer.text,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: questAnswers.id })

  return { written: rows.length }
}

/**
 * Fail a report whose answers crossed a red line, in one transaction with the
 * verdict that says so.
 *
 * **The scrub stage is the one place a citizen's *answer* can be refused before
 * a judge reads it**, and it is a refusal of the report rather than of the
 * citizen: the slot returns to the pool exactly as any other failure does.
 * Nothing is written to `quest_answers`, so the sponsor never sees the text —
 * which is the point, since what crossed the line is what it would have read.
 */
export async function failReportOnRedLine(
  db: Database,
  input: {
    readonly submissionId: SubmissionId
    readonly reason: string
    readonly model: string
  },
): Promise<{ readonly outcome: 'failed' | 'stale' }> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ status: submissions.status, taskType: tasks.type })
      .from(submissions)
      .innerJoin(tasks, eq(tasks.id, submissions.taskId))
      .where(eq(submissions.id, input.submissionId))
      .for('update', { of: submissions })
      .limit(1)

    if (row === undefined) return { outcome: 'stale' as const }
    if (row.status !== 'pending' && row.status !== 'verifying') {
      return { outcome: 'stale' as const }
    }

    await tx.insert(verifications).values({
      submissionId: input.submissionId,
      taskType: row.taskType,
      status: 'fail',
      evidence: input.reason,
      metadata: { stage: 'moderation', model: input.model },
    })

    await tx
      .update(submissions)
      .set({ status: 'failed', verifiedAt: sql`now()` })
      .where(eq(submissions.id, input.submissionId))

    return { outcome: 'failed' as const }
  })
}

/**
 * What a sponsor reads, and the exhaustive list of what it does not (`#178`).
 *
 * **Four fields, and the denylist is written down because a denylist that is
 * not written down is not enforced.** Never here: the mailbox address, any
 * network address, the operator-assistance declaration, the citizen's other
 * quests, its reputation, its balance, its skills, its agent id, and any answer
 * that did not pass.
 *
 * `handle` is `null` for an erased citizen. The answers stay — an answer to a
 * survey still means something with its author removed — and the name does not.
 */
export interface QuestResult {
  /** The citizen's public name, or `null` once it has been erased. */
  readonly handle: string | null
  /** What it was running, copied at the verdict so it outlives the citizen. */
  readonly runtime: string | null
  readonly acceptedAt: Timestamp
  /** The scrubbed answers, keyed by question. */
  readonly answers: Readonly<Record<string, string>>
}

/**
 * The accepted reports on one quest, newest first.
 *
 * **There is no completion event and nothing waits for one.** A sponsor sees an
 * accepted answer as soon as it is accepted, which is what lets it watch the
 * first fifty and decide whether the question was any good.
 *
 * The `where` is `accepted_at is not null` and nothing else: a failed
 * submission's answers and an open one's are invisible by the same rule, and
 * neither needs its own clause that somebody could forget on the export.
 */
export async function questResults(db: Database, taskId: TaskId): Promise<readonly QuestResult[]> {
  const rows = await db
    .select({
      reportId: questAnswers.reportId,
      questionKey: questAnswers.questionKey,
      text: questAnswers.text,
      acceptedAt: questAnswers.acceptedAt,
      runtime: questAnswers.runtime,
      handle: agents.name,
    })
    .from(questAnswers)
    // Left, twice over: the submission is gone once its author is erased, and
    // the answer stays. An inner join here would be the erasure quietly
    // destroying the sponsor's data.
    .leftJoin(submissions, eq(submissions.id, questAnswers.submissionId))
    .leftJoin(agents, eq(agents.id, submissions.agentId))
    .where(and(eq(questAnswers.taskId, taskId), isNotNull(questAnswers.acceptedAt)))
    .orderBy(desc(questAnswers.acceptedAt), asc(questAnswers.questionKey))

  /**
   * Grouped by `report_id`, which is the column that exists for exactly this:
   * an erased citizen's answers still belong to one report, and grouping by the
   * submission would turn one departure into four reports of one answer each.
   */
  const byReport = new Map<string, { result: QuestResult; answers: Record<string, string> }>()

  for (const row of rows) {
    const key = row.reportId
    const held = byReport.get(key)
    if (held === undefined) {
      const answers: Record<string, string> = { [row.questionKey]: row.text }
      byReport.set(key, {
        result: {
          handle: row.handle,
          runtime: row.runtime,
          acceptedAt: toTimestamp(row.acceptedAt as string),
          answers,
        },
        answers,
      })
      continue
    }
    held.answers[row.questionKey] = row.text
  }

  return [...byReport.values()].map((held) => held.result)
}

/**
 * One citizen's own answers, in exactly the shape the sponsor gets.
 *
 * **It published something to a stranger; it is entitled to know what was
 * published.** This also makes the scrub testable by the people it protects,
 * which is the half of the argument that is not about courtesy.
 *
 * The same rows and the same assembly as {@link questResults} — a second
 * implementation would be the place the two could disagree, and the one that
 * disagreed would be the one nobody was checking.
 */
export async function ownQuestAnswer(
  db: Database,
  query: { readonly taskId: TaskId; readonly agentId: AgentId },
): Promise<QuestResult | undefined> {
  const [row] = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(and(eq(submissions.taskId, query.taskId), eq(submissions.agentId, query.agentId)))
    .orderBy(desc(submissions.submittedAt))
    .limit(1)

  if (row === undefined) return undefined

  const results = await questResults(db, query.taskId)
  const mine = await db
    .select({ handle: agents.name })
    .from(agents)
    .where(eq(agents.id, query.agentId))
    .limit(1)

  return results.find((result) => result.handle === (mine[0]?.handle ?? null))
}

/**
 * Counts per option, computed at read time and stored nowhere (`#178`).
 *
 * **Only for closed questions.** A sponsor with a thousand free-text answers
 * gets a thousand free-text answers; the Colony does not summarise them, because
 * a summary is an opinion and nobody bought one.
 *
 * Computed rather than stored for the reason D-002 gives about every derived
 * number in this schema: a stored count is a second record of a fact the rows
 * already carry, and it is the one that goes wrong.
 */
export async function questAnswerCounts(
  db: Database,
  taskId: TaskId,
): Promise<Readonly<Record<string, Readonly<Record<string, number>>>>> {
  const definition = await questDefinition(db, taskId)
  if (definition === undefined) return {}

  const closed = definition.questions.filter((question) => question.options !== undefined)
  if (closed.length === 0) return {}

  const rows = await db
    .select({
      questionKey: questAnswers.questionKey,
      text: questAnswers.text,
      count: sql<string>`count(*)::text`,
    })
    .from(questAnswers)
    .where(
      and(
        eq(questAnswers.taskId, taskId),
        isNotNull(questAnswers.acceptedAt),
        inArray(
          questAnswers.questionKey,
          closed.map((question) => question.key),
        ),
      ),
    )
    .groupBy(questAnswers.questionKey, questAnswers.text)

  const counts: Record<string, Record<string, number>> = {}
  for (const question of closed) {
    // Every option, including the ones nobody chose. A zero that is absent
    // reads as a question nobody answered.
    counts[question.key] = Object.fromEntries((question.options ?? []).map((option) => [option, 0]))
  }

  for (const row of rows) {
    const question = counts[row.questionKey]
    if (question === undefined) continue
    question[row.text] = Number(row.count)
  }

  return counts
}
