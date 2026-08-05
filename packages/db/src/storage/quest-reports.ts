import { and, eq, isNotNull, sql } from 'drizzle-orm'
import {
  AgentPlatformSchema,
  QUEST_REPORT_KINDS_THE_SPONSOR_READS,
  type AgentId,
  type QuestReportCounts,
  type QuestReportKind,
  type TaskId,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { agents, questAnswers, questReports, taskAttempts, tasks } from '../schema/index.js'
import type { BriefingSource } from './briefing.js'
import { payQuestObstacleBonus } from './escrow.js'
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
    /** The paragraph, on the three kinds that carry one. */
    readonly text?: string
    /**
     * The three answers, on an `obstacle` report (`#367`).
     *
     * The boundary schema has already refused any mixture of the two shapes,
     * and `quest_reports_shape_matches_kind` refuses it again for a caller that
     * is not the API.
     */
    readonly did?: string
    readonly broke?: string
    readonly changed?: string
  },
): Promise<FileQuestReportOutcome> {
  const [quest] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, command.taskId), eq(tasks.kind, 'quest')))
    .limit(1)

  if (quest === undefined) return { outcome: 'unknown-quest' }

  /**
   * Every citizen-written column, written together (`#367`).
   *
   * **Spelled out rather than spread from the command**, because the columns
   * this does *not* set are the ones that matter: a replacement must clear the
   * shape it is not, or a citizen that filed an `obstacle` and then filed
   * `feedback` would leave three answers behind a paragraph, and the row would
   * fail its own shape check — or worse, pass it and be read twice.
   */
  const written = {
    kind: command.kind,
    text: command.text ?? null,
    did: command.did ?? null,
    broke: command.broke ?? null,
    changed: command.changed ?? null,
  }

  const [row] = await db
    .insert(questReports)
    .values({ taskId: command.taskId, agentId: command.agentId, ...written })
    .onConflictDoUpdate({
      target: [questReports.taskId, questReports.agentId],
      set: {
        ...written,
        // Back to the start of the pipeline: a new text has not been moderated,
        // and the old scrub described the old text. Both scrubs go, including
        // the published one — an obstacle another citizen may already have read
        // stops being served the moment its author changes what it said.
        scrubbed: null,
        scrubbedBroke: null,
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

  // `declined` rows always carry a paragraph — `quest_reports_shape_matches_kind`
  // makes that a property of the table — so the filter is a formality that keeps
  // the type honest rather than a case that happens.
  return rows.map((row) => row.text).filter((text): text is string => text !== null)
}

/** One report awaiting the scrub, as the moderation pass needs it. */
export interface UnmoderatedQuestReport {
  readonly id: string
  readonly taskId: TaskId
  /** The paragraph, on the kinds that carry one. */
  readonly text: string | null
  /**
   * The three answers, on an `obstacle` report (`#367`).
   *
   * The pass reads them separately because it decides them separately: the
   * obstacle is published to other citizens and the other two are not, so the
   * question *does this carry answer content* is asked of `broke` alone.
   */
  readonly did: string | null
  readonly broke: string | null
  readonly changed: string | null
  readonly kind: QuestReportKind
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
    .select({
      id: questReports.id,
      taskId: questReports.taskId,
      text: questReports.text,
      did: questReports.did,
      broke: questReports.broke,
      changed: questReports.changed,
      kind: questReports.kind,
    })
    .from(questReports)
    .where(
      and(
        eq(questReports.status, 'pending'),
        sql`${questReports.kind} in ${QUEST_REPORT_KINDS_THE_SPONSOR_READS}`,
      ),
    )
    .orderBy(questReports.createdAt)
    .limit(limit)

  return rows.map((row) => ({
    id: row.id,
    taskId: row.taskId as TaskId,
    text: row.text,
    did: row.did,
    broke: row.broke,
    changed: row.changed,
    kind: row.kind,
  }))
}

/**
 * Write what the scrub produced, or refuse the report — and pay for it if it was
 * published (`#371`).
 *
 * Returns what the author was paid, which is `0` for every decision except a
 * published obstacle among the first few on a paying quest.
 */
export async function recordQuestReportModeration(
  db: Database,
  command: {
    readonly id: string
    readonly decision: 'approved' | 'rejected'
    readonly scrubbed?: string
    /**
     * The obstacle after the scrub, on an `obstacle` report the pass cleared
     * (`#367`).
     *
     * Absent means *nothing is published*, which covers the two cases a reader
     * treats identically: the citizen answered no obstacle, and the stage found
     * answer content in the one it did answer. Only the second is a refusal, and
     * the difference belongs to the citizen's own view rather than to a reader's.
     */
    readonly publishedObstacle?: string
  },
): Promise<number> {
  return await db.transaction(async (tx) => {
    const [decided] = await tx
      .update(questReports)
      .set({
        status: command.decision,
        // A refused report keeps its row and gains no scrub: the citizen wrote it,
        // the Colony declined to pass it on, and deleting the row would delete the
        // record of that decision.
        scrubbed: command.decision === 'approved' ? (command.scrubbed ?? null) : null,
        scrubbedBroke: command.decision === 'approved' ? (command.publishedObstacle ?? null) : null,
      })
      .where(and(eq(questReports.id, command.id), eq(questReports.status, 'pending')))
      .returning({
        id: questReports.id,
        taskId: questReports.taskId,
        agentId: questReports.agentId,
        kind: questReports.kind,
        published: questReports.scrubbedBroke,
      })

    /**
     * The payment for a published obstacle is booked **in the decision's own
     * transaction** (`#371`), exactly as a verdict books an Academy reward in
     * its own: a report that was published and not paid would be a debt the
     * Colony cannot find, and a second job that reconciled them would be a
     * second place the rule lives.
     *
     * Nothing here decides *whether* to pay — `payQuestObstacleBonus` owns every
     * one of those conditions, and this is the one call site.
     */
    if (decided === undefined || decided.kind !== 'obstacle' || decided.published === null) {
      return 0
    }

    return await payQuestObstacleBonus(tx, {
      taskId: decided.taskId as TaskId,
      reportId: decided.id,
      agentId: decided.agentId as AgentId,
    })
  })
}

/**
 * The published obstacles on one quest, as the synthesis reads them (`#367`).
 *
 * **The same shape a rung's corpus takes**, deliberately: what another citizen
 * gets is a Colony-written briefing with counts, and reusing `BriefingSource`
 * means it is written by the same synthesis against the same prompt rather than
 * by a second one that would drift into quoting.
 *
 * Three fields are pinned rather than read, and each says something true about a
 * quest:
 *
 * - `kind: 'wall'` — an obstacle is where somebody stopped. There is no advice
 *   here at all, because advice on a quest is method and method never travels.
 * - `reports: 1` — nothing merges on this table. One row is one citizen, which
 *   the unique index on `(task, agent)` makes true by construction, so the count
 *   a claim carries is a count of citizens without anything maintaining it.
 * - `attempted: true` — an obstacle report comes from a citizen that answered.
 *
 * **`scrubbed_broke` and never `broke`**, which is the whole publication rule:
 * there is no path from an unread sentence to a reader, rather than a `where`
 * clause each surface has to remember.
 */
export async function questObstacleCorpus(
  db: Database,
  taskId: TaskId,
): Promise<readonly BriefingSource[]> {
  const rows = await db
    .select({
      id: questReports.id,
      content: questReports.scrubbedBroke,
      platform: agents.platform,
      updatedAt: questReports.updatedAt,
    })
    .from(questReports)
    .innerJoin(agents, eq(agents.id, questReports.agentId))
    /**
     * The quest itself, for one column: a sponsor may keep its obstacles
     * unpublished (`#370`). Joined rather than checked by a caller, so there is
     * no path from a suppressed quest to a briefing — the same shape as
     * `scrubbed_broke` above, one level up.
     */
    .innerJoin(tasks, eq(tasks.id, questReports.taskId))
    .where(
      and(
        eq(questReports.taskId, taskId),
        eq(questReports.kind, 'obstacle'),
        eq(questReports.status, 'approved'),
        isNotNull(questReports.scrubbedBroke),
        eq(tasks.publishObstacles, true),
      ),
    )
    .orderBy(questReports.updatedAt)

  return rows.map((row) => ({
    id: row.id,
    kind: 'wall' as const,
    content: row.content as string,
    reports: 1,
    platforms: { [AgentPlatformSchema.parse(row.platform)]: 1 },
    lastSupportedAt: toTimestamp(row.updatedAt),
    attempted: true,
  }))
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
