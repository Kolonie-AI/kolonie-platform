import { and, eq, isNotNull, sql } from 'drizzle-orm'
import {
  AgentPlatformSchema,
  QUEST_OBSTACLE_BONUS_LEGACY_PERCENT,
  QUEST_REPORT_KINDS_THE_SPONSOR_READS,
  questObstacleBonus,
  type AgentId,
  type QuestReportCounts,
  type QuestReportKind,
  type TaskId,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { agents, questAnswers, questReports, taskAttempts, tasks } from '../schema/index.js'
import type { BriefingSource } from './briefing.js'
import { oweForObstacleBonus } from './payouts.js'
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
  | {
      readonly outcome: 'filed'
      readonly replaced: boolean
      /**
       * Whether this report could earn the obstacle bonus (`#632`).
       *
       * **`false` on an `obstacle` from a citizen that never attempted**, which
       * is a thing the author has to be told at the moment it files rather than
       * left to infer from a payment that never arrives. The report is welcome,
       * moderated and published on the same terms as any other — what it is not
       * is work, and the bonus pays for work.
       *
       * `true` on the other three kinds too, in the sense that matters: they
       * were never eligible and the author is told nothing about a bonus,
       * because a sentence about a payment nobody offered reads as a payment
       * withheld.
       */
      readonly earnsBonus: boolean
    }
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

  /**
   * **Asked here so the author learns it now** (`#632`). The same question
   * `decideQuestReport` asks before paying, one step earlier — a citizen that
   * files an obstacle without ever having opened the quest should read *this is
   * welcome and it is not paid* while it is still deciding what to do, not
   * discover it from a payment that never comes.
   *
   * Two reads of one rule rather than one, and deliberately: this one is a
   * sentence and the other one is money, and a preview that lied by being stale
   * is better than a payment made on a stale answer.
   */
  const earnsBonus =
    command.kind !== 'obstacle' ? true : await hasAttempted(db, command.agentId, command.taskId)

  return { outcome: 'filed', replaced: row.updatedAt !== row.createdAt, earnsBonus }
}

/** Whether this citizen ever opened this task, which is what the bonus pays for. */
async function hasAttempted(
  db: Database | Transaction,
  agentId: AgentId,
  taskId: TaskId,
): Promise<boolean> {
  const [attempt] = await db
    .select({ id: taskAttempts.id })
    .from(taskAttempts)
    .where(and(eq(taskAttempts.agentId, agentId), eq(taskAttempts.taskId, taskId)))
    .limit(1)

  return attempt !== undefined
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
     * Nothing here decides *whether* to pay beyond the three conditions it can
     * see — `oweForObstacleBonus` owns the winners cap, and this is its one call
     * site.
     */
    if (decided === undefined || decided.kind !== 'obstacle' || decided.published === null) {
      return 0
    }

    const [task] = await tx
      .select({
        kind: tasks.kind,
        rewardLamports: tasks.rewardLamports,
        publishObstacles: tasks.publishObstacles,
        obstacleBonusPercent: tasks.obstacleBonusPercent,
      })
      .from(tasks)
      .where(eq(tasks.id, decided.taskId))
      .limit(1)

    // An Academy rung reaches here only through a bug, and paying on one would
    // break the boundary `governance/quests.md` draws. A sponsor that kept its
    // obstacles bought nobody anything and held no pool.
    if (task === undefined || task.kind !== 'quest' || !task.publishObstacles) return 0

    /**
     * **The bonus is for a citizen that tried and hit a wall** (`#632`).
     *
     * Nothing here asked before, and `quest_reports` has no attempt on it by
     * design — any of the three kinds may be filed by somebody that only read
     * the quest, and `unclear` in particular is most valuable from exactly that
     * citizen. So the question is asked of `task_attempts` instead: has this
     * author ever opened this quest?
     *
     * **The arithmetic this closes.** An obstacle report paid a share of an
     * answer and required no attempt, so *read the quest and name an obstacle*
     * was a strictly better trade than answering it. An agent doing that sum is
     * behaving correctly; the sum was wrong.
     *
     * **Unpaid rather than forbidden, which is the part not to lose.** The
     * attempt-less report is often the most useful kind — *"this is impossible
     * for anyone whose mailbox cannot send"* — and it is still filed, still
     * moderated, still published and still read. It simply is not work, and the
     * bonus pays for work. `#632`: *"the two are different claims and only one
     * of them is work."*
     */
    if (!(await hasAttempted(tx, decided.agentId as AgentId, decided.taskId as TaskId))) return 0

    return await oweForObstacleBonus(tx, {
      agentId: decided.agentId as AgentId,
      taskId: decided.taskId as TaskId,
      /**
       * **The share this quest was published at**, not the one in force today
       * (`#632`). The sponsor was invoiced for a pool sized at that figure, so
       * paying at any other would make the commitment and the payout disagree —
       * which is the one thing the column exists to prevent.
       */
      lamports: questObstacleBonus(
        { lamports: task.rewardLamports ?? 0 },
        task.obstacleBonusPercent ?? QUEST_OBSTACLE_BONUS_LEGACY_PERCENT,
      ),
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
 * **`retireQuestEarly` stood here, and `endQuest` in `quests/write.ts` replaced
 * it** (`#619`).
 *
 * It was written for `#240`: a published quest collecting `unclear` reports and
 * no claims can be ended early rather than left to occupy its capacity until
 * expiry, and the counts above are the reason somebody would. That case is
 * unchanged and is exactly what the new route serves — a steward may end any
 * quest, and this evidence is why one would.
 *
 * **Three reasons it went rather than gained a caller.** It was reachable from
 * nothing: the desk declared `retire` and no route or page ever called it, so
 * the only way a quest has ever actually been ended is the direct `UPDATE`
 * against production that `#619` was filed about. It recorded neither who ended
 * the quest nor why, which is the half a citizen holding an attempt reads. And
 * a second function that moves a quest to `retired` is a second answer to what
 * ending one means — the D-002 duplication this package argues against
 * everywhere else.
 *
 * **Its doc claimed a refund this repository does not perform**, and that is
 * worth recording rather than quietly dropping: *"the unspent capacity refunds
 * by `#174`'s existing path"*. There is no such path. `questRefundReference` is
 * defined in core and booked by nothing, and D-106's invoice notice — which
 * every sponsor reads before paying — says the opposite outright: *capacity
 * nobody fills is not returned at expiry*. `endQuest` says what became of the
 * money instead of leaving a sponsor to infer it.
 */
