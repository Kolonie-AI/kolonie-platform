import { createHash } from 'node:crypto'
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import {
  QuestAnswersSchema,
  StoredQuestQuestionsSchema,
  paidQuestRejection,
  type AgentId,
  type ModerationStages,
  type QuestAuditPolicy,
  type QuestQuestion,
  type SubmissionId,
  type Task,
  type TaskId,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../../client.js'
import {
  questAnswers,
  questAudits,
  questModerations,
  submissions,
  tasks,
  verifications,
} from '../../schema/index.js'
import { availableBalance, fundQuestEscrow } from '../escrow.js'
import { recordAuthorityEvent } from '../roles.js'
import { toTask, toTimestamp } from '../rows.js'
import type { ScrubbedAnswer } from './shared.js'

/** A quest the moderator has not judged since its text last changed. */
export interface PendingQuest {
  readonly id: TaskId
  readonly title: string
  readonly description: string
  readonly instructions: string
}

export type QuestPublishOutcome =
  | { readonly outcome: 'published'; readonly escrowed: number }
  | { readonly outcome: 'unknown-quest' }
  | { readonly outcome: 'not-in-review'; readonly status: Task['status'] }
  /** Nobody publishes a quest it wrote (`#173`). */
  | { readonly outcome: 'own-quest' }
  /** The moderation stage has not answered yet, so no steward is entitled to see it. */
  | { readonly outcome: 'awaiting-moderation' }
  | { readonly outcome: 'insufficient-funds'; readonly shortfall: number }
  /**
   * This quest pays, and the sampling audit is off or the judge is being
   * overruled too often (`#221`). Carries the sentence rather than a code,
   * because both refusals name what would change them.
   */
  | { readonly outcome: 'audit-missing'; readonly reason: string }

export type QuestRefuseOutcome =
  | { readonly outcome: 'refused' }
  | { readonly outcome: 'unknown-quest' }
  | { readonly outcome: 'not-in-review'; readonly status: Task['status'] }
  | { readonly outcome: 'own-quest' }

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
  command: {
    readonly stewardId: AgentId
    readonly taskId: TaskId
    readonly at: Timestamp
    /**
     * The audit as this deployment has it configured (`#221`).
     *
     * **Required rather than optional, and it defaults to off nowhere.** A
     * caller that forgot it would publish paid quests with no audit behind
     * them, which is the precise failure the guard exists for — so the compiler
     * asks, exactly as `banSalt` does in `eraseAgent`.
     */
    readonly audit: QuestAuditPolicy
  },
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

    /**
     * The precondition, checked at the one moment it matters: the transaction
     * that turns a quest into work citizens can take for money.
     *
     * Inside the transaction rather than at the route, so no second write path
     * can reach publication without it — the same reason the self-approval ban
     * is checked here as well as in the guard.
     */
    const disagreement = await questDisagreementRate(tx, command.audit)
    const refusal = paidQuestRejection(command.audit, {
      credits: row.rewardCredits,
      disagreement: disagreement.rate,
      // The count the rate was computed over, which this call used to discard
      // (`#317`). Without it the brake fires on a sample of one.
      audited: disagreement.audited,
    })
    if (refusal !== undefined) return { outcome: 'audit-missing', reason: refusal }

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
 * The sample, as a `where` clause.
 *
 * **The SQL half of `questAuditDraw`**, and the one place this schema
 * deliberately duplicates a rule from core — the same arrangement
 * `tasks_type_slug` has with `TASK_TYPE_PATTERN`, and for the same reason: a
 * check constraint cannot call into TypeScript, and neither can a `where`. There
 * is a test asserting the two agree over two hundred submission ids.
 */
const drawnBelow = (rate: number) =>
  sql`(('x' || substr(md5(${submissions.id}::text), 1, 8))::bit(32)::bigint::numeric / 4294967295.0) < ${rate}`

/** One verdict awaiting a steward's second reading, with no citizen in it. */
export interface AuditCandidate {
  readonly submissionId: SubmissionId
  readonly taskId: TaskId
  readonly questTitle: string
  readonly questions: readonly QuestQuestion[]
  readonly answers: readonly ScrubbedAnswer[]
  /** What the judge said, in the words the citizen was given. */
  readonly verdict: string
  readonly acceptedAt: Timestamp
}

/**
 * The audit queue: sampled passes on judged quests that no steward has read yet.
 *
 * **It carries the questions, the answers and the verdict — and not the
 * citizen.** `#177` keeps the judge blind for a reason, and a human auditor with
 * more context than the judge is not auditing the judge. There is no agent id in
 * this shape and no join that could put one there.
 *
 * A `hard` quest is excluded: its report was proved by a third party rather than
 * by a model, and re-reading a mailbox round trip tells nobody anything.
 */
export async function questAuditQueue(
  db: Database,
  policy: { readonly rate: number },
  limit = 50,
  /**
   * Who is asking, so it is never drawn its own quest (`#318`).
   *
   * Optional, because a caller that wants the queue as the Colony sees it —
   * a count, a report, a test — is asking a different question from a steward
   * about to read one. What is *not* optional is the guard: `recordAuditDecision`
   * refuses the write whether or not this was passed, because a queue is a
   * suggestion and the write is where a rule lives (`#173`'s lesson, one route
   * later).
   */
  stewardId?: AgentId,
): Promise<readonly AuditCandidate[]> {
  const rows = await db
    .select({
      submissionId: submissions.id,
      taskId: submissions.taskId,
      questTitle: tasks.title,
      questions: tasks.questions,
      proofVerifier: tasks.proofVerifier,
      verdict: verifications.evidence,
      acceptedAt: submissions.verifiedAt,
    })
    .from(submissions)
    .innerJoin(tasks, eq(tasks.id, submissions.taskId))
    .innerJoin(verifications, eq(verifications.submissionId, submissions.id))
    .where(
      and(
        eq(tasks.kind, 'quest'),
        eq(submissions.status, 'passed'),
        isNull(tasks.proofVerifier),
        eq(verifications.status, 'pass'),
        drawnBelow(policy.rate),
        sql`not exists (
          select 1 from ${questAudits} where ${questAudits.submissionId} = ${submissions.id}
        )`,
        // A steward is never shown a verdict on a quest it wrote itself. The
        // `is distinct from` rather than `<>` is for the ownerless quest: a
        // sponsor that erased itself leaves `created_by` null, and `null <> id`
        // is null, which would drop every such quest out of every queue.
        ...(stewardId === undefined ? [] : [sql`${tasks.createdBy} is distinct from ${stewardId}`]),
      ),
    )
    .orderBy(asc(submissions.verifiedAt))
    .limit(limit)

  const candidates: AuditCandidate[] = []

  for (const row of rows) {
    const answers = await db
      .select({ questionKey: questAnswers.questionKey, text: questAnswers.text })
      .from(questAnswers)
      .where(eq(questAnswers.submissionId, row.submissionId))
      .orderBy(asc(questAnswers.questionKey))

    candidates.push({
      submissionId: row.submissionId as SubmissionId,
      taskId: row.taskId as TaskId,
      questTitle: row.questTitle,
      questions: StoredQuestQuestionsSchema.parse(row.questions),
      answers,
      verdict: row.verdict,
      acceptedAt: toTimestamp(row.acceptedAt as string),
    })
  }

  return candidates
}

export type AuditRecordOutcome =
  | { readonly outcome: 'recorded' }
  | { readonly outcome: 'unknown-submission' }
  /** Somebody read it first. Two stewards opening the queue at once is ordinary. */
  | { readonly outcome: 'already-audited' }
  /** The verdict is on a quest this steward sponsored (`#318`). */
  | { readonly outcome: 'own-quest' }

/**
 * Record what a steward found. It changes nothing else, by construction.
 *
 * There is no update to the submission, the verification or the ledger anywhere
 * in this function, and there is a test asserting the citizen's balance is
 * unchanged after a disagreement. **A disagreement is counted, never applied.**
 *
 * **Except its own quest's** (`#318`). `#173` bans a steward from publishing a
 * quest it wrote; the audit added by `#221` had no equivalent, so a steward that
 * also sponsors could record whether it agreed with the verdicts on its own
 * work. The payout is untouched either way — the audit *"counts and never
 * reverses a payout"* (D-061) — so what a self-audit corrupts is the **number**:
 * `questDisagreementRate` is the Colony's own measurement of whether its judge
 * can be trusted with money, and a sponsor is the one party with an interest in
 * the answer. Agreeing keeps its quests publishable; disagreeing stops the
 * programme it is buying from. Both directions are an interested reading.
 */
export async function recordAuditDecision(
  db: Database,
  command: {
    readonly submissionId: SubmissionId
    readonly stewardId: AgentId
    readonly agrees: boolean
    readonly reason: string
  },
): Promise<AuditRecordOutcome> {
  const [submission] = await db
    .select({ id: submissions.id, sponsorId: tasks.createdBy })
    .from(submissions)
    .innerJoin(tasks, eq(tasks.id, submissions.taskId))
    .where(eq(submissions.id, command.submissionId))
    .limit(1)

  if (submission === undefined) return { outcome: 'unknown-submission' }

  // The guard, at the write. The queue above already hides these, and hiding is
  // not refusing: a submission id is guessable, the queue is a suggestion, and
  // `#173` put its ban here for the same reason.
  if (submission.sponsorId === command.stewardId) return { outcome: 'own-quest' }

  const rows = await db
    .insert(questAudits)
    .values({
      submissionId: command.submissionId,
      stewardId: command.stewardId,
      agrees: command.agrees,
      reason: command.reason,
    })
    .onConflictDoNothing()
    .returning({ id: questAudits.id })

  return rows.length === 0 ? { outcome: 'already-audited' } : { outcome: 'recorded' }
}

/**
 * How often a steward has overruled the judge lately.
 *
 * **Computed by query and stored nowhere** (`#221`), which is D-002's rule about
 * every derived number here. An empty window is `0` rather than `null`: nothing
 * has been overruled, which is the honest reading and the one that does not stop
 * the programme on its first day.
 */
export async function questDisagreementRate(
  db: Database | Transaction,
  policy: { readonly windowDays: number },
): Promise<{ readonly rate: number; readonly audited: number; readonly disagreed: number }> {
  const [row] = await db
    .select({
      audited: sql<string>`count(*)::text`,
      disagreed: sql<string>`count(*) filter (where not ${questAudits.agrees})::text`,
    })
    .from(questAudits)
    .where(sql`${questAudits.createdAt} > now() - make_interval(days => ${policy.windowDays})`)

  const audited = Number(row?.audited ?? 0)
  const disagreed = Number(row?.disagreed ?? 0)

  return { rate: audited === 0 ? 0 : disagreed / audited, audited, disagreed }
}
