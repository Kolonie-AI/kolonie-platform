import { and, eq, isNotNull, sql } from 'drizzle-orm'
import {
  QUEST_REPORT_KINDS_THE_SPONSOR_READS,
  type AgentId,
  type QuestReportCounts,
  type QuestReportKind,
  type TaskId,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { questAnswers, questReports, taskAttempts, tasks } from '../schema/index.js'
import { toTimestamp } from './rows.js'

/**
 * A citizen can tell a sponsor something about its quest without completing it,
 * claiming it, or liking it (`#240`).
 *
 * The table's own comment carries why this is not `task_reports` and why it
 * produces no briefing. This module carries the reads, and there are exactly two
 * of them: the counts, and the text — with the second deliberately unable to
 * return a `declined` row.
 */

/** What filing a report came to. */
export type FileQuestReportOutcome =
  | { readonly outcome: 'filed'; readonly replaced: boolean }
  /** No quest with that id, or it is an Academy rung rather than a quest. */
  | { readonly outcome: 'unknown-quest' }

/**
 * File a report, replacing this citizen's previous one on the same quest.
 *
 * **A replacement rather than a second row**, and the previous text is not kept:
 * reading a quest twice and thinking better of it is one data point, and a
 * citizen on a six-hour rhythm would otherwise file the same `unclear` four
 * times a day and make the counts a measure of its schedule.
 *
 * **A replacement returns to `pending` and drops the scrub.** The moderated text
 * belonged to what was written before; serving it beside a changed opinion would
 * be showing the sponsor a sentence the citizen has withdrawn.
 *
 * **Filing costs nothing** — no reputation, no reward, no standing — which is why
 * nothing else is written here. That is the same promise the struggle channel
 * makes, and the reason it is kept the same way: there is no code path from this
 * function to anything that scores.
 */
export async function fileQuestReport(
  db: Database,
  command: {
    readonly taskId: TaskId
    readonly agentId: AgentId
    readonly kind: QuestReportKind
    readonly text: string
  },
): Promise<FileQuestReportOutcome> {
  const [quest] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, command.taskId), eq(tasks.kind, 'quest')))
    .limit(1)

  if (quest === undefined) return { outcome: 'unknown-quest' }

  const [row] = await db
    .insert(questReports)
    .values({
      taskId: command.taskId,
      agentId: command.agentId,
      kind: command.kind,
      text: command.text,
    })
    .onConflictDoUpdate({
      target: [questReports.taskId, questReports.agentId],
      set: {
        kind: command.kind,
        text: command.text,
        // Back to the start of the pipeline: a new text has not been moderated,
        // and the old scrub described the old text.
        scrubbed: null,
        status: 'pending',
        updatedAt: sql`now()`,
      },
    })
    .returning({ createdAt: questReports.createdAt, updatedAt: questReports.updatedAt })

  if (row === undefined) throw new Error('inserting a quest report returned no row')

  return { outcome: 'filed', replaced: row.updatedAt !== row.createdAt }
}

/** One report as its sponsor reads it: scrubbed, moderated, and attributed to nobody. */
export interface SponsorQuestReport {
  readonly kind: 'unclear' | 'feedback'
  readonly text: string
  readonly filedAt: Timestamp
}

/**
 * The reports a sponsor may read on its own quest.
 *
 * **`declined` cannot come out of here**, and it is refused three times over: the
 * kind filter below, the `scrubbed is not null` clause, and the check constraint
 * that stops a `declined` row from ever holding scrubbed text. The redundancy is
 * the point — `#240` asks for the code path to make this structurally hard to
 * get wrong rather than relying on a moderator to notice, and the class of
 * mistake it is guarding against has already happened once, on 2026-07-30, when
 * an approved struggle carried its author's mailbox address.
 *
 * **No citizen identity, by construction.** Neither the agent id nor the handle
 * is selected. A quest report is one citizen's opinion about a stranger's
 * product, and `#178`'s rule — *the sponsor reads the answers and never learns
 * who wrote them* — applies to it unchanged.
 */
export async function sponsorQuestReports(
  db: Database,
  taskId: TaskId,
): Promise<readonly SponsorQuestReport[]> {
  const rows = await db
    .select({
      kind: questReports.kind,
      scrubbed: questReports.scrubbed,
      updatedAt: questReports.updatedAt,
    })
    .from(questReports)
    .where(
      and(
        eq(questReports.taskId, taskId),
        eq(questReports.status, 'approved'),
        isNotNull(questReports.scrubbed),
        // `inArray` over the two kinds the sponsor reads, written from the core
        // constant rather than repeated here — a second list is a second answer
        // to *which kinds are the sponsor's* and only one of them would be
        // updated when a fourth kind is argued for.
        sql`${questReports.kind} in ${QUEST_REPORT_KINDS_THE_SPONSOR_READS}`,
      ),
    )
    .orderBy(questReports.updatedAt)

  return rows.map((row) => ({
    kind: row.kind as 'unclear' | 'feedback',
    text: row.scrubbed!,
    filedAt: toTimestamp(row.updatedAt),
  }))
}

/**
 * What the sponsor and the steward both see on a live quest (`#240`).
 *
 * **Available before expiry, which is the point.** A quest with no claims and
 * eight `unclear` reports is a diagnosis, and it is worth having while the quest
 * is still running rather than in a post-mortem after the refund.
 *
 * **`declined` is a number here and a text nowhere.** *Eight citizens declined on
 * conscience grounds* is unambiguous feedback to an honest sponsor; the text
 * would tell a dishonest one which citizens refuse what, and the Colony would
 * have hosted and billed for the probe.
 *
 * **Every `declined` row is counted, moderated or not.** The count is a fact
 * about how many citizens refused, and moderation decides whether text may be
 * *served* — which nothing here does. Filtering by status would make the number
 * depend on how far behind the runner is.
 */
export async function questReportCounts(db: Database, taskId: TaskId): Promise<QuestReportCounts> {
  const [row] = await db.execute<{
    claims: string
    accepted: string
    unclear: string
    declined: string
  }>(sql`
    select
      (select count(*)::text from ${taskAttempts} where task_id = ${taskId}) as claims,
      (select count(distinct r.submission_id)::text
         from ${questAnswers} r
        where r.task_id = ${taskId} and r.accepted_at is not null) as accepted,
      (select count(*)::text from ${questReports}
        where task_id = ${taskId} and kind = 'unclear') as unclear,
      (select count(*)::text from ${questReports}
        where task_id = ${taskId} and kind = 'declined') as declined
  `)

  return {
    claims: Number(row?.claims ?? 0),
    acceptedReports: Number(row?.accepted ?? 0),
    unclear: Number(row?.unclear ?? 0),
    declined: Number(row?.declined ?? 0),
  }
}

/**
 * What the Colony reads that the sponsor does not: the `declined` text.
 *
 * A pattern of conscience declines across quests from one sponsor is a
 * governance signal, and `governance/red-lines.md` is where that conversation
 * lives. This is the only reader of it, and it takes no agent id: what matters is
 * that eight citizens said the same thing, not which eight.
 */
export async function declineReasons(
  db: Database | Transaction,
  taskId: TaskId,
): Promise<readonly string[]> {
  const rows = await db
    .select({ text: questReports.text })
    .from(questReports)
    .where(and(eq(questReports.taskId, taskId), eq(questReports.kind, 'declined')))
    .orderBy(questReports.updatedAt)

  return rows.map((row) => row.text)
}

/** One report awaiting the scrub, as the moderation pass needs it. */
export interface UnmoderatedQuestReport {
  readonly id: string
  readonly taskId: TaskId
  readonly text: string
}

/**
 * The reports the moderation pass has left to do.
 *
 * **`declined` is not in this queue and cannot enter it.** Nobody outside the
 * Colony ever reads that text, so there is nothing to scrub it *for* — and a
 * pass that handled it would be a code path from a declined row to a scrubbed
 * column, which is exactly the thing the check constraint exists to make
 * unreachable.
 */
export async function unmoderatedQuestReports(
  db: Database,
  limit: number,
): Promise<readonly UnmoderatedQuestReport[]> {
  const rows = await db
    .select({ id: questReports.id, taskId: questReports.taskId, text: questReports.text })
    .from(questReports)
    .where(
      and(
        eq(questReports.status, 'pending'),
        sql`${questReports.kind} in ${QUEST_REPORT_KINDS_THE_SPONSOR_READS}`,
      ),
    )
    .orderBy(questReports.createdAt)
    .limit(limit)

  return rows.map((row) => ({ id: row.id, taskId: row.taskId as TaskId, text: row.text }))
}

/** Write what the scrub produced, or refuse the report. */
export async function recordQuestReportModeration(
  db: Database,
  command: {
    readonly id: string
    readonly decision: 'approved' | 'rejected'
    readonly scrubbed?: string
  },
): Promise<void> {
  await db
    .update(questReports)
    .set({
      status: command.decision,
      // A refused report keeps its row and gains no scrub: the citizen wrote it,
      // the Colony declined to pass it on, and deleting the row would delete the
      // record of that decision.
      scrubbed: command.decision === 'approved' ? (command.scrubbed ?? null) : null,
    })
    .where(and(eq(questReports.id, command.id), eq(questReports.status, 'pending')))
}

/**
 * The one thing a quest report can cause, and it is a steward's decision rather
 * than an automatic one (`#240`).
 *
 * A published quest collecting `unclear` reports and no claims can be retired
 * early and refunded rather than left to occupy its capacity until expiry. The
 * refund path already exists (`#174`); what was missing was a reason for
 * somebody to use it in time, and the counts above are it.
 *
 * **Nothing here is automatic**, and that is deliberate: a threshold that retired
 * a quest by itself would be the Colony overruling a sponsor on evidence a model
 * moderated, and `governance/quests.md` gives the sponsor its remedies rather
 * than taking them.
 */
export type RetireQuestOutcome =
  | { readonly outcome: 'retired' }
  /** It was not an active quest — already closed, still a draft, or not a quest. */
  | { readonly outcome: 'not-active' }

export async function retireQuestEarly(db: Database, taskId: TaskId): Promise<RetireQuestOutcome> {
  /**
   * The status and nothing else, which is what makes the refund happen without
   * a second mechanism.
   *
   * **The expiry is deliberately untouched.** `tasks_published_quest_frozen`
   * refuses any change to a live quest's terms and the expiry is one of them —
   * that rule is right, and a retirement that had to break it would be the
   * Colony editing a published quest to end it. So `questsAwaitingRefund` reads
   * `retired` as finished instead, and the unspent capacity refunds by `#174`'s
   * existing path rather than by a second one that could disagree with it about
   * a quest with a claim still open.
   */
  const [row] = await db
    .update(tasks)
    .set({ status: 'retired', retiredAt: sql`now()` })
    .where(and(eq(tasks.id, taskId), eq(tasks.kind, 'quest'), eq(tasks.status, 'active')))
    .returning({ id: tasks.id })

  return row === undefined ? { outcome: 'not-active' } : { outcome: 'retired' }
}
