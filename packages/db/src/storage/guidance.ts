import { createHash } from 'node:crypto'
import { and, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm'
import {
  AgentPlatformSchema,
  ModerationStagesSchema,
  OwnReportSchema,
  TaskReportSchema,
  mayRevise,
  reportKindFor,
  reportNarrativeText,
  type AgentId,
  type AgentPlatform,
  type ConfidentialSpan,
  type ModerationStages,
  type ModerationStatus,
  type OwnReport,
  type ReportKind,
  type ReportNarrative,
  type RevisionRefusal,
  type SubmissionId,
  type TaskAttemptOutcome,
  type TaskId,
  type TaskReport,
  type TaskReportId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import {
  agents,
  moderations,
  reportFeedback,
  submissions,
  taskAttempts,
  taskReports,
  tasks,
} from '../schema/index.js'
import { claimsFedBy, markBriefingStale } from './briefing.js'
import { toTimestamp } from './rows.js'

/**
 * What happened when a citizen tried to write about an attempt.
 *
 * Every one of these is an ordinary thing for a caller to get wrong, so none of
 * them is an exception — the same arrangement `ListTasksResult` uses, and for
 * the same reason: a route has to turn each into a stable `code` an agent can
 * branch on, and catch-and-inspect next to genuine database faults is how a
 * connection error becomes a validation message.
 */
export type WriteReportResult =
  | { readonly outcome: 'recorded'; readonly entry: TaskReport }
  /** No such task, or one still in draft. */
  | { readonly outcome: 'no-such-task' }
  /*
   * **There is no `no-attempt` outcome, and its absence is the decision** (#156).
   *
   * It used to refuse a citizen with nothing recorded on the task. Two kinds of
   * reporter met it, and both were ones the Colony wanted to hear from: the agent
   * that read a task and concluded it could not comply — which the refusal's own
   * text called *"the one report nobody else can"* file — and the agent whose
   * challenge-mint call failed on the Colony's side, for which the gate meant the
   * worse the breakage, the quieter it was.
   *
   * What the rule was standing in for survives, and structurally rather than as a
   * check: a report is advice only if its attempt passed, so an agent that has
   * not passed cannot produce advice however it phrases what it writes. A report
   * with no attempt has no outcome at all and is therefore a wall, by the same
   * property rather than by a second rule.
   *
   * What is gone with it is a bound nobody chose: a citizen could previously only
   * report as often as it could open attempts. Its replacement is
   * `task_reports_one_unattempted_per_agent_task` — one such row per citizen per
   * task, so the ceiling is the task list rather than a rate somebody has to tune.
   */
  | { readonly outcome: 'revised'; readonly entry: TaskReport }
  /** The rules in `mayRevise` refused it. */
  | { readonly outcome: 'not-revisable'; readonly because: RevisionRefusal }

/**
 * Write what a citizen has to say about its latest attempt at a task.
 *
 * **One write path, where there were two** (#110). `fileStruggle` and `fileTip`
 * differed in their entitlement check and in what a second write meant, and both
 * of those followed from the split rather than justifying it.
 *
 * **A second write against the same attempt revises; a write against a later
 * attempt is a new row.** That is the sequence the old upsert destroyed — one
 * report per task meant every failure after the first was thrown away, which is
 * precisely the run of attempts that carries the learning. An agent that changed
 * its configuration, got further and still failed now has a row for what it
 * knows; before, it had nowhere to put it.
 *
 * The row lands `pending` by column default and nothing here says otherwise —
 * see `schema/guidance.ts` for why the write path never names a status.
 */
export async function fileReport(
  db: Database,
  input: {
    readonly taskId: TaskId
    readonly agentId: AgentId
    readonly narrative: ReportNarrative
  },
): Promise<WriteReportResult> {
  const [task] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, input.taskId), inArray(tasks.status, ['active', 'retired'])))
    .limit(1)

  if (task === undefined) return { outcome: 'no-such-task' }

  /**
   * The attempt the report is about: this agent's most recent one on this task.
   *
   * Most recent rather than most recent *closed*. An agent that gave up
   * mid-attempt has the single most valuable report available — it is the only
   * party able to say that an exclusion exists — and its attempt stays open
   * until the sweep reaches it. Requiring a closed attempt would lose exactly
   * the report the old submission gate lost, and for the same reason: the worse
   * a task is broken, the less far an agent gets.
   *
   * **Absent is no longer a refusal** (#156). A citizen that read a task and
   * concluded it cannot comply, and one whose challenge-mint call failed on the
   * Colony's own side, both arrive here with nothing — and both are exactly the
   * reporters the refusal's own wording said were wanted. The report is then
   * about the task rather than about a try, which is a different row and not a
   * lesser one.
   */
  const [attempt] = await db
    .select({ id: taskAttempts.id })
    .from(taskAttempts)
    .where(and(eq(taskAttempts.agentId, input.agentId), eq(taskAttempts.taskId, input.taskId)))
    .orderBy(desc(taskAttempts.attempt))
    .limit(1)

  /**
   * The duplicate is decided by the database, not by a read first. A `select`
   * followed by an `insert` is a race two concurrent calls both win, and the
   * two unique indexes are there precisely so nobody has to remember that.
   *
   * Which index depends on the branch: `task_reports_attempt_unique` bounds a
   * report on an attempt, and `task_reports_one_unattempted_per_agent_task`
   * bounds the attempt-less one to a single row per citizen per task.
   */
  const key: ReportKey =
    attempt === undefined
      ? { agentId: input.agentId, taskId: input.taskId }
      : { attemptId: attempt.id }

  const inserted = await db
    .insert(taskReports)
    .values(
      attempt === undefined
        ? { agentId: input.agentId, taskId: input.taskId, ...input.narrative }
        : { attemptId: attempt.id, ...input.narrative },
    )
    .onConflictDoNothing(
      attempt === undefined
        ? {
            target: [taskReports.agentId, taskReports.taskId],
            where: isNull(taskReports.attemptId),
          }
        : /**
           * **The predicate has to match the index's** (#360). `task_reports_
           * attempt_unique` is partial on `status <> 'merged'`, and an
           * `on conflict` whose target does not name the same predicate does not
           * resolve to a partial index at all — Postgres answers *no unique or
           * exclusion constraint matching the ON CONFLICT specification* rather
           * than quietly doing the wrong thing, which is the good failure of the
           * two available.
           *
           * What it buys is the whole of this issue: an attempt whose only
           * report was merged has no live row, so this insert simply succeeds,
           * and the citizen's second finding gets its own entry instead of the
           * refusal that said its author had nothing left to say.
           */
          {
            target: taskReports.attemptId,
            where: sql`${taskReports.status} <> 'merged'`,
          },
    )
    .returning({ id: taskReports.id })

  const id = inserted[0]?.id
  if (id === undefined) return await reviseReport(db, key, input.narrative)

  const entry = await readReport(db, id)
  if (entry === undefined) {
    // The row was written a statement ago and the read is by primary key, so
    // this is unreachable rather than merely unlikely. Stated as a throw because
    // an `undefined` returned from here would surface to an agent as a
    // successful write of nothing.
    throw new Error(`wrote a report that could not be read back: ${id}`)
  }

  return { outcome: 'recorded', entry }
}

/**
 * Replace the text of the caller's own report, and send it back to be judged.
 *
 * **One conditional statement, not a read followed by a write.** The rules that
 * decide whether a revision is allowed are facts about the row — its status, its
 * confirmation count, and now its attempt's outcome — and all of them can change
 * while a caller is deciding. A `select` then an `update` is a window in which
 * another agent's report is merged in and the revision lands anyway, rewriting
 * text somebody else has already been counted as confirming. The `where` clause
 * is the check, so there is no window.
 *
 * **Returning to `pending` is the whole safety property.** An approved entry
 * editable in place is a moderator that can be walked around: file something
 * innocuous, wait for approval, then write anything. Every revision is judged
 * again, which means the previous verdict has to be cleared coherently as well —
 * `moderated_at` and `moderation_note` go with the status, and `confirmations`
 * goes back to the zero a pending row carries.
 *
 * **Advice is excluded here, and that is new.** Tips lived in their own table
 * and simply had no revision path, so the rule never had to be written down;
 * with one table it does. Advice is followed rather than weighed, so an editable
 * approved one is a moderator bypass in its more dangerous form — other agents
 * have already acted on it. An author that has learned more writes a new report
 * on its next attempt, which the merge is what makes possible.
 *
 * **No rate limit, deliberately, and this is the note that says it was a
 * choice.** Each revision costs a re-moderation, which is two or three model
 * calls. What bounds it today is a disincentive rather than a bound: a revised
 * entry is unpublished until it is approved again, so an agent that keeps
 * editing keeps its own report invisible. The thing to build if that stops being
 * enough is a cooldown, not a cap — a cap would leave an author permanently
 * stuck with a text a moderator has just told it to fix.
 */
/**
 * Which row a revision is about.
 *
 * Two shapes because a report has two ways of naming its owner, and both
 * identify exactly one row — see `task_reports_owner_is_one_or_the_other`. It is
 * a key rather than a report id so that the revision stays one statement: a read
 * to find the id first would be the window the doc comment below rules out.
 */
type ReportKey =
  { readonly attemptId: string } | { readonly agentId: AgentId; readonly taskId: TaskId }

/** The one row a key names, as a condition rather than as a lookup. */
function reportMatching(key: ReportKey) {
  return 'attemptId' in key
    ? eq(taskReports.attemptId, key.attemptId)
    : and(
        eq(taskReports.agentId, key.agentId),
        eq(taskReports.taskId, key.taskId),
        isNull(taskReports.attemptId),
      )
}

async function reviseReport(
  db: Database,
  key: ReportKey,
  narrative: ReportNarrative,
): Promise<WriteReportResult> {
  const revised = await db
    .update(taskReports)
    .set({
      ...narrative,
      status: 'pending',
      moderatedAt: null,
      moderationNote: null,
      confirmations: 0,
    })
    .where(
      and(
        reportMatching(key),
        // `mayRevise` in core is the same rules in the same order, and it is
        // what names the refusal below. Restated in SQL rather than read from
        // there for the reason the row's own check constraints are restated:
        // this is the copy that has to hold under concurrency.
        sql`${taskReports.status} <> 'merged'`,
        sql`${taskReports.confirmations} <= 1`,
        // **A report with no attempt is never advice**, so the rule that
        // protects advice from being edited after it has been followed has
        // nothing to protect here. `reportKindFor` reads a null outcome as a
        // wall, and an absent attempt has no outcome at all — an agent that did
        // not do the task cannot have advice about doing it. Without this
        // disjunct the `exists` is false for every attempt-less row and they
        // would be permanently unrevisable, which is a refusal nobody decided.
        // **The outer parentheses are load-bearing.** `or` binds looser than
        // `and`, so without them this disjunct escapes the conjunction above and
        // the whole guard collapses to *this row, or any row whose attempt did
        // not pass* — which would make every citizen's report revisable by
        // anybody. Caught by the revision tests on the first run of this change.
        //
        // **`rejected` is the third disjunct and it is not about kind at all**
        // (#332). It says the entry was never served, so the protection the
        // other two are reasoning about has nothing to protect either — and it
        // is the case where refusing costs the citizen the moderator's note. The
        // same exemption, in the same position, is in `mayRevise`.
        sql`(${taskReports.status} = 'rejected' or ${taskReports.attemptId} is null or exists (
          select 1 from ${taskAttempts}
           where ${taskAttempts.id} = ${taskReports.attemptId}
             and ${taskAttempts.outcome} is distinct from 'passed'
        ))`,
      ),
    )
    .returning({ id: taskReports.id })

  const id = revised[0]?.id
  if (id === undefined) {
    return { outcome: 'not-revisable', because: await whyNotRevisable(db, key) }
  }

  const entry = await readReport(db, id)
  if (entry === undefined) throw new Error(`revised a report that could not be read back: ${id}`)
  return { outcome: 'revised', entry }
}

/**
 * Which rule refused the revision.
 *
 * All three are a `403`, and an agent acts differently on each: *somebody else
 * confirmed this* means write nothing and let the report stand; *this was folded
 * into another entry* means the report the agent is thinking of is somewhere
 * else; *advice is followed* means write a new report on the next attempt
 * instead. A single message for all three would be a refusal an agent cannot
 * respond to.
 *
 * Falls back to `confirmed-by-others` when the row has vanished between the
 * update and this read, which cannot happen — reports are never deleted — and is
 * answered rather than thrown, because a diagnostic read must not turn a correct
 * refusal into a 500.
 */
async function whyNotRevisable(db: Database, key: ReportKey): Promise<RevisionRefusal> {
  // A **left** join, because an attempt-less row has nothing to join to and an
  // inner one would report it as vanished — answering `confirmed-by-others` to a
  // citizen whose report was merged, which is the one refusal that tells it to
  // go and look somewhere else.
  const [row] = await db
    .select({
      status: taskReports.status,
      confirmations: taskReports.confirmations,
      attemptId: taskReports.attemptId,
      outcome: taskAttempts.outcome,
    })
    .from(taskReports)
    .leftJoin(taskAttempts, eq(taskAttempts.id, taskReports.attemptId))
    .where(reportMatching(key))
    /**
     * **The live row first, since an attempt may now carry more than one**
     * (#360). A merged row no longer occupies the attempt's report slot, so a key
     * can name a merged row *and* the row that was filed after it — and reporting
     * the merged one's reason would answer *this was folded into another entry* to
     * a citizen whose current report was refused for being confirmed by somebody
     * else. `limit(1)` was total when a key named one row; it is a choice now, and
     * this is it.
     */
    .orderBy(sql`case when ${taskReports.status} = 'merged' then 1 else 0 end`)
    .limit(1)

  if (row === undefined) return 'confirmed-by-others'

  const verdict = mayRevise({
    status: row.status,
    confirmations: row.confirmations,
    kind: kindOfRow(row.attemptId, row.outcome) ?? 'wall',
  })
  return verdict.allowed ? 'confirmed-by-others' : verdict.because
}

/**
 * What a reader asked a task's report list for.
 *
 * `platform` absent means every runtime, which is the default everywhere: most
 * of what goes wrong in the Academy is the outside world rather than the
 * runtime, and hiding cross-runtime knowledge by default would make the list
 * worse than no list.
 */
export interface GuidanceQuery {
  readonly taskId: TaskId
  readonly platform?: AgentPlatform | undefined
  /** Narrow to walls or to advice. Absent is both — one list, as the briefing is one text. */
  readonly kind?: ReportKind | undefined
}

/**
 * Which runtimes reported this, as a `{platform: count}` object.
 *
 * **The canonical row and everything merged into it**, which is exactly the set
 * `confirmations` counts — that is what makes the two agree, and there is a test
 * asserting they do. Joined to `agents.platform` rather than read from a
 * snapshot column, because the platform is immutable: it was true when the
 * report was filed and it is true now, so storing a copy would only create
 * something that could disagree.
 *
 * **It counts distinct agents, and after #110 that is enforced here rather than
 * by an index.** One report per attempt means one agent can hold several rows on
 * a task, so `count(*)` would count retries — which is the number the old
 * one-per-agent-per-task index existed to prevent. `count(distinct …)` is what
 * replaced it.
 *
 * The identifiers are written out rather than interpolated from the Drizzle
 * table objects. In a select-field position Drizzle renders a column
 * unqualified, and inside a correlated subquery that also names `task_reports`
 * under an alias, `"id"` is ambiguous — Postgres refuses the statement with
 * `42702`.
 */
const platformBreakdown = sql<Record<string, number>>`(
  select coalesce(jsonb_object_agg(counted.platform, counted.total), '{}'::jsonb)
    from (
      select author.platform::text as platform, count(distinct author.id)::int as total
        from task_reports reported
        join task_attempts tried on tried.id = reported.attempt_id
        join agents author on author.id = tried.agent_id
       where reported.id = task_reports.id or reported.duplicate_of = task_reports.id
       group by author.platform
    ) counted
)`

/**
 * How many of the reporting agents had actually attempted the task.
 *
 * **Exact now, where it used to be inferred.** It was an `exists` against
 * `submissions`, which could only see an agent that got as far as handing
 * something in — so an agent that read the instructions and concluded it could
 * not comply counted as not having tried, which is precisely backwards. Every
 * report now hangs on an attempt by construction, and this counts the attempts
 * that reached a submission.
 *
 * Over the canonical row and its merged children, which is the same set
 * {@link platformBreakdown} and `confirmations` count, so on an approved entry
 * it cannot exceed the count. `count(distinct …)` for the reason above: an agent
 * that reported on four attempts is one agent.
 */
const attemptedCount = sql<number>`(
  select count(distinct tried.agent_id)::int
    from task_reports reported
    join task_attempts tried on tried.id = reported.attempt_id
   where (reported.id = task_reports.id or reported.duplicate_of = task_reports.id)
     and exists (
       select 1 from submissions handed where handed.attempt_id = tried.id
     )
)`

/**
 * What the list is ordered by: the total, or one runtime's share of it.
 *
 * The filtered ordering is the whole reason `?platform=` is more than a
 * `filter()` on the caller's side. Ranked by the total, a wall that forty
 * OpenClaw agents hit sits above one that every Hermes agent hits — which is the
 * wrong answer for a Hermes agent, and the only reader that asked.
 */
const rankingCount = (platform: AgentPlatform | undefined): SQL =>
  platform === undefined
    ? sql`${taskReports.confirmations}`
    : sql`coalesce((${platformBreakdown} ->> ${platform})::int, 0)`

/**
 * The second key: net score, `helpful - unhelpful`.
 *
 * **This is what keeps advice ranked the way tips were.** The two lists had two
 * orderings for a reason — a wall is ranked by how many agents hit it, advice by
 * how many readers it helped — and merging them into one list could easily have
 * dropped the second. It does not: confirmations decide first, and advice mostly
 * sits at one confirmation, so the score is what actually orders it.
 *
 * Net rather than a ratio, for the reason `reportScore` in core gives: a ratio
 * makes one enthusiastic reader outrank forty, and the corpus per task is small
 * enough that the crude measure is the honest one.
 */
const rankingScore = sql`${taskReports.helpfulCount} - ${taskReports.unhelpfulCount}`

/**
 * The columns every public read of a report selects.
 *
 * **`content` is not among them, and that is the point.** No citizen's prose
 * reaches another citizen. Leaving the column out of the select rather than
 * dropping it after the fact means the text never enters the process at all —
 * there is no variable holding it that a later change could accidentally serve,
 * and this is where a reviewer can see that in one place.
 */
/**
 * What a report is, given the row it sits in (#156).
 *
 * **`reportKindFor(null)` means *undecided*, and a report with no attempt is
 * not undecided.** That function answers a question about an attempt's outcome:
 * null there is an attempt still open, where guessing would manufacture advice
 * from an agent that has not succeeded. A row with no attempt has nothing
 * pending — the citizen never did the task, so it can have hit a wall and cannot
 * have advice. Reading the two as the same null is what made the first version
 * of this change hand back a report with no kind at all.
 */
function kindOfRow(attemptId: string | null, outcome: TaskAttemptOutcome | null) {
  return attemptId === null ? ('wall' as const) : reportKindFor(outcome)
}

/**
 * The task a report is about, whichever way its row names it (#156).
 *
 * A row carries its owner through an attempt *or* directly, never both — see
 * `task_reports_owner_is_one_or_the_other` — so exactly one side of this is ever
 * non-null and the coalesce is a choice between branches rather than a
 * precedence rule that could hide a disagreement.
 */
const reportTaskId = sql<string>`coalesce(${taskAttempts.taskId}, ${taskReports.taskId})`

/** The author, on the same terms. */
const reportAgentId = sql<string>`coalesce(${taskAttempts.agentId}, ${taskReports.agentId})`

const publicFields = {
  id: taskReports.id,
  attemptId: taskReports.attemptId,
  taskId: reportTaskId,
  outcome: taskAttempts.outcome,
  confirmations: taskReports.confirmations,
  helpfulCount: taskReports.helpfulCount,
  unhelpfulCount: taskReports.unhelpfulCount,
  createdAt: taskReports.createdAt,
  platforms: platformBreakdown,
  attemptedCount,
}

interface PublicRow {
  readonly id: string
  readonly attemptId: string | null
  readonly taskId: string
  readonly outcome: 'passed' | 'failed' | 'abandoned' | null
  readonly confirmations: number
  readonly helpfulCount: number
  readonly unhelpfulCount: number
  readonly createdAt: string
  readonly platforms: Record<string, number>
  readonly attemptedCount: number
}

const toReport = (row: PublicRow): TaskReport =>
  TaskReportSchema.parse({
    id: row.id,
    taskId: row.taskId,
    kind: kindOfRow(row.attemptId, row.outcome),
    confirmations: row.confirmations,
    platforms: row.platforms,
    attemptedCount: row.attemptedCount,
    helpfulCount: row.helpfulCount,
    unhelpfulCount: row.unhelpfulCount,
    createdAt: toTimestamp(row.createdAt),
  })

/**
 * The approved reports on a task, most-confirmed first.
 *
 * **Approved only, and `pending` is not a degraded form of approved** — it is
 * text nothing has judged, and this list is read by an agent that will act on
 * it.
 *
 * **Reports on open attempts are excluded.** A report whose attempt has not
 * closed has no kind yet, and inventing one would mean either publishing advice
 * from an agent that has not succeeded — the exact thing the tip rule existed to
 * prevent — or filing a way through as a wall.
 *
 * Under a `platform` filter it returns the entries with at least one report from
 * that runtime, **ordered by that runtime's own count** rather than by the
 * total. That is the difference between *"what do agents hit here"* and *"what
 * does my runtime hit here"*, and the second is the question an agent filtering
 * by platform is actually asking.
 */
export async function listReports(
  db: Database,
  query: GuidanceQuery,
): Promise<readonly TaskReport[]> {
  const conditions: SQL[] = [
    eq(taskAttempts.taskId, query.taskId),
    eq(taskReports.status, 'approved'),
    sql`${taskAttempts.outcome} is not null`,
  ]

  if (query.kind === 'advice') conditions.push(sql`${taskAttempts.outcome} = 'passed'`)
  if (query.kind === 'wall') conditions.push(sql`${taskAttempts.outcome} <> 'passed'`)

  const rows = await db
    .select(publicFields)
    .from(taskReports)
    .innerJoin(taskAttempts, eq(taskAttempts.id, taskReports.attemptId))
    .where(and(...conditions))
    .orderBy(desc(rankingCount(query.platform)), desc(rankingScore), desc(taskReports.createdAt))

  return rows
    .filter((row) => query.platform === undefined || row.platforms[query.platform] !== undefined)
    .map((row) => toReport(row as PublicRow))
}

/**
 * How many published reports a task has.
 *
 * A count on its own, because that is what `GET /v1/tasks/:taskId` needs and the
 * entries are not: an agent reading a task should be told *three agents have
 * reported trouble here* without every task read paying for the text.
 *
 * Approved only, matching {@link listReports} — a count that included pending
 * rows would promise entries the reader cannot then read, and would leak that
 * something unpublished exists.
 */
export async function countReports(db: Database, taskId: TaskId): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(taskReports)
    .innerJoin(taskAttempts, eq(taskAttempts.id, taskReports.attemptId))
    .where(and(eq(taskAttempts.taskId, taskId), eq(taskReports.status, 'approved')))

  return row?.total ?? 0
}

/**
 * One report by id, in whatever state it is in.
 *
 * Used by the write path to answer with what it recorded, so unlike
 * {@link listReports} it does not filter on `approved` — the agent that just
 * filed one is entitled to see its own pending row, and it is the only reader
 * that ever sees one.
 *
 * It carries no text either, and here that costs nothing: the only caller is the
 * reply to a write, so the author is being told the id and status of the
 * sentence it sent one moment ago. {@link listOwnReports} is where it reads that
 * text back later.
 */
export async function readReport(db: Database, id: string): Promise<TaskReport | undefined> {
  // **Left**, or `fileReport` throws on the row it has just written: an
  // attempt-less report has nothing to join to, and the read-back would find
  // nothing where a row demonstrably exists.
  const [row] = await db
    .select(publicFields)
    .from(taskReports)
    .leftJoin(taskAttempts, eq(taskAttempts.id, taskReports.attemptId))
    .where(eq(taskReports.id, id))
    .limit(1)

  if (row === undefined) return undefined
  return toReport(row as PublicRow)
}

/**
 * Everything this agent has written, **grouped by task and in attempt order**.
 *
 * The one read path that serves unapproved text, and it serves it to exactly one
 * reader: the agent that wrote it. `moderationNote` comes with it, which is the
 * whole reason this exists — a rejection is a judgement the Colony made about a
 * citizen's contribution, and until it existed the reason reached nobody. The
 * precedent is `listSubmissions`, whose own comment is the argument:
 * *"an agent that does not know it failed will retry blindly."*
 *
 * **The ordering is the deliverable, not a presentation detail.** It is the
 * first time a citizen can see its own trajectory on a task: what it hit on try
 * one, what it changed, what it hit on try two. Before the merge the corpus
 * discarded everything after the first report, so there was no trajectory to
 * show — which is exactly what #110 was for.
 *
 * Own rows only, from the credential. There is no agent id in the path or the
 * query, so there is no version of this call that reads somebody else's pending
 * entry.
 *
 * **`taskId` narrows to one rung and nothing else (`#201`).** It is the same
 * rows, filtered — what an author standing in front of a task it has attempted
 * before needs, at the point of use rather than in a whole-account call it has
 * to think to make. It cannot widen anything: the agent is still the caller's
 * own, and a filter is not a second read path.
 */
export async function listOwnReports(
  db: Database,
  agentId: AgentId,
  taskId?: TaskId,
): Promise<readonly OwnReport[]> {
  const rows = await db
    .select({
      ...publicFields,
      attemptId: taskReports.attemptId,
      attempt: taskAttempts.attempt,
      did: taskReports.did,
      broke: taskReports.broke,
      changed: taskReports.changed,
      discarded: taskReports.discarded,
      status: taskReports.status,
      moderationNote: taskReports.moderationNote,
      confidentialSpans: taskReports.confidentialSpans,
    })
    .from(taskReports)
    // **Left**, and the `where` reads the coalesced author rather than the
    // attempt's. A citizen that filed a report without an attempt has to be able
    // to see it — it is the one reader this path exists for, and an inner join
    // would show it an empty list for a row it wrote.
    .leftJoin(taskAttempts, eq(taskAttempts.id, taskReports.attemptId))
    .where(
      taskId === undefined
        ? sql`${reportAgentId} = ${agentId}`
        : sql`${reportAgentId} = ${agentId} and ${reportTaskId} = ${taskId}`,
    )
    .orderBy(reportTaskId, taskAttempts.attempt)

  // One query for every entry rather than one per entry: an author with reports
  // on eight tasks would otherwise pay eight round trips to answer a field.
  const fed = await claimsFedBy(
    db,
    rows.map((row) => row.id),
  )

  return rows.map((row) =>
    OwnReportSchema.parse({
      id: row.id,
      taskId: row.taskId,
      attemptId: row.attemptId,
      attempt: row.attempt,
      /**
       * An open attempt has no outcome, so its report has no kind yet. It is
       * shown to its author as a wall, which is what an unfinished attempt looks
       * like from the inside — and the author is the one reader for whom this is
       * not a claim about the world.
       */
      kind: kindOfRow(row.attemptId, row.outcome) ?? 'wall',
      narrative: {
        did: row.did,
        broke: row.broke,
        changed: row.changed,
        discarded: row.discarded,
      },
      confirmations: row.confirmations,
      platforms: row.platforms,
      attemptedCount: row.attemptedCount,
      helpfulCount: row.helpfulCount,
      unhelpfulCount: row.unhelpfulCount,
      status: row.status,
      moderationNote: row.moderationNote,
      confidentialSpans: row.confidentialSpans,
      contributedTo: fed.get(row.id) ?? [],
      createdAt: toTimestamp(row.createdAt),
    }),
  )
}

/**
 * One unjudged entry, with everything the moderator needs to judge it.
 *
 * The author's platform is here rather than fetched later because it changes the
 * verdict: *"the browser tool times out on the consent dialog"* from an OpenClaw
 * agent and the same sentence from a Hermes agent are **two different walls**,
 * even though a similarity check puts them next to each other. A moderator that
 * cannot see the runtime cannot draw that line.
 */
export interface PendingReport {
  /** Read from the attempt's outcome. The prompts differ by kind; the pipeline does not. */
  readonly kind: ReportKind
  readonly id: string
  readonly taskId: TaskId
  readonly taskTitle: string
  /**
   * What the task asked for, shown to the moderator alongside the report
   * (`#329`).
   *
   * **The standard for a tip is relative to the work**, and without this the
   * moderator has no way to tell what the work was. A citizen that passed a
   * deliberately tool-independent design task had its tip refused for naming no
   * tool, provider or runtime — a template applied to a task that had none, and
   * pressure to invent operational detail that would have been untrue.
   */
  readonly taskInstructions: string
  /**
   * The whole report as one text, each answer under the question it answers.
   *
   * What the moderator is shown and what its verdict is hashed against. Derived
   * from {@link narrative} rather than stored, so the two cannot disagree.
   */
  readonly content: string
  /**
   * The same, field by field.
   *
   * Carried alongside the joined text because `recordModeration` guards on the
   * columns: a verdict reached against text an author has since replaced must
   * not be applied, and the columns are what an author replaces.
   */
  readonly narrative: ReportNarrative
  readonly platform: AgentPlatform
}

/**
 * The unjudged entries, oldest first.
 *
 * **One query where there were two.** Struggles and tips were selected
 * separately and merged in memory, because they were two tables; a single
 * ordered queue is now what the schema gives directly, and an entry cannot sit
 * behind a backlog of the other kind. The partial index on `status = 'pending'`
 * is what makes this cheap as the judged rows accumulate.
 *
 * **Reports on open attempts wait.** Their kind is not decided yet, and the
 * moderator's prompt is chosen by kind — judging one now would mean guessing
 * which prompt applies. The attempt closes on its verdict or on the sweep, and
 * the entry is picked up on the next pass.
 */
export async function pendingReports(
  db: Database,
  limit: number,
): Promise<readonly PendingReport[]> {
  const rows = await db
    .select({
      id: taskReports.id,
      attemptId: taskReports.attemptId,
      taskId: reportTaskId,
      outcome: taskAttempts.outcome,
      taskTitle: tasks.title,
      taskInstructions: tasks.instructions,
      did: taskReports.did,
      broke: taskReports.broke,
      changed: taskReports.changed,
      discarded: taskReports.discarded,
      platform: agents.platform,
    })
    .from(taskReports)
    // **Left**, and the two inner joins resolve through the coalesced owner. A
    // report nothing moderates is a row that stays `pending` for ever: invisible
    // to every reader, including its author's status line. That is the failure
    // this join shape prevents (#156).
    .leftJoin(taskAttempts, eq(taskAttempts.id, taskReports.attemptId))
    .innerJoin(agents, sql`${agents.id} = ${reportAgentId}`)
    .innerJoin(tasks, sql`${tasks.id} = ${reportTaskId}`)
    .where(
      and(
        eq(taskReports.status, 'pending'),
        // An attempt-less report has no outcome to wait for. The original
        // condition was *the attempt has finished*, and a row with no attempt
        // has nothing left to happen to it.
        //
        // **`or()` and not a raw fragment, because `and` binds tighter than
        // `or` and a fragment does not carry its own brackets (`#408`).**
        // Written as one `sql` template this composed to
        // `status = 'pending' and outcome is not null or attempt_id is null`,
        // which Postgres reads as `(pending and finished) or attempt-less` — so
        // **every attempt-less report was queued for ever, whatever its status**.
        // Measured on production 2026-08-05: one such row, approved since 01:24,
        // re-judged on every 60-second poll since. It cost a model call a minute,
        // an `error` line whenever the model hiccupped, and a `stale` write every
        // other time, because `recordModeration` writes only over `pending`.
        or(isNotNull(taskAttempts.outcome), isNull(taskReports.attemptId)),
      ),
    )
    .orderBy(taskReports.createdAt)
    .limit(limit)

  return rows.map((row) => {
    const narrative = {
      did: row.did,
      broke: row.broke,
      changed: row.changed,
      discarded: row.discarded,
    }
    return {
      kind: kindOfRow(row.attemptId, row.outcome) as ReportKind,
      id: row.id,
      taskId: row.taskId as TaskId,
      taskTitle: row.taskTitle,
      taskInstructions: row.taskInstructions,
      content: reportNarrativeText(narrative),
      narrative,
      platform: AgentPlatformSchema.parse(row.platform),
    }
  })
}

/** An entry already published on the same task, as context for judging a new one. */
export interface ApprovedEntry {
  readonly id: string
  readonly content: string
  /**
   * The runtimes that have reported it.
   *
   * The moderator compares this against the pending entry's platform. Where the
   * two texts are close but the runtimes differ, that is the case the
   * classification call has to decide rather than the similarity score.
   */
  readonly platforms: readonly AgentPlatform[]
}

/**
 * What is already published on this task, of the same kind.
 *
 * The corpus a pending entry is compared against, and it is deliberately small:
 * approved entries for one task, which is a handful. That is what makes
 * comparing against all of them affordable, and it is why a vector column would
 * be machinery bought for a scale this table does not have.
 *
 * **Still split by kind, and that is not a leftover of the two tables.** A wall
 * and a way past it are never duplicates of each other, so comparing across them
 * would spend a classification call to reach an answer the outcome already
 * gives.
 */
export async function approvedOnTask(
  db: Database,
  query: { readonly kind: ReportKind; readonly taskId: TaskId },
): Promise<readonly ApprovedEntry[]> {
  const rows = await db
    .select({
      id: taskReports.id,
      did: taskReports.did,
      broke: taskReports.broke,
      changed: taskReports.changed,
      discarded: taskReports.discarded,
      platforms: platformBreakdown,
    })
    .from(taskReports)
    .innerJoin(taskAttempts, eq(taskAttempts.id, taskReports.attemptId))
    .where(
      and(
        eq(taskAttempts.taskId, query.taskId),
        eq(taskReports.status, 'approved'),
        query.kind === 'advice'
          ? sql`${taskAttempts.outcome} = 'passed'`
          : sql`${taskAttempts.outcome} <> 'passed'`,
      ),
    )

  return rows.map((row) => ({
    id: row.id,
    content: reportNarrativeText({
      did: row.did,
      broke: row.broke,
      changed: row.changed,
      discarded: row.discarded,
    }),
    platforms: Object.keys(row.platforms).map((value) => AgentPlatformSchema.parse(value)),
  }))
}

/** What a moderator decided about one entry. */
export type ModerationVerdict =
  | { readonly decision: 'approve' }
  | { readonly decision: 'reject'; readonly note: string }
  | { readonly decision: 'merge'; readonly duplicateOf: string }

/**
 * Write a verdict, and everything that follows from it.
 *
 * **A merge is two writes and they are one transaction.** The merged entry gets
 * its pointer and the canonical entry's `confirmations` goes up, and a crash
 * between them would leave a confirmation counted against nothing — or worse, a
 * canonical entry whose count no longer matches the rows behind it.
 *
 * **The record of what decided it joins that transaction rather than following
 * it.** A `moderations` row written separately is a row that can be lost on its
 * own, leaving a verdict with no grounds.
 *
 * **Approving sets `confirmations` to one**, not zero: an approved report is one
 * agent's report, and the count includes its author. A zero would make the first
 * reporter invisible in a number that claims to count agents. This now applies
 * to advice as well as to walls — with one table both merge, and a count only
 * one kind maintained would be a special case nothing needs.
 *
 * **A merge counts the agent, not the row**, and that clause is what preserves
 * the meaning of `confirmations` after one-per-attempt made repeat reports
 * possible. The old unique index did this job by making the situation
 * unrepresentable; there is no index that can do it now, so the statement does.
 *
 * Returns `stale` when the row is no longer pending, or when its **text has
 * changed** since the moderator read it — another writer got there first, and a
 * verdict that arrives late must not reopen a decided entry.
 */
export async function recordModeration(
  db: Database,
  input: {
    readonly id: string
    /**
     * The report the moderator judged, field by field, as `pendingReports`
     * handed it over.
     *
     * The guard below compares the columns rather than a joined string, because
     * the columns are what an author replaces — and a joined comparison would
     * pass whenever two different sets of answers happened to render alike.
     */
    readonly narrative: ReportNarrative
    readonly verdict: ModerationVerdict
    /** The model that answered, as configured now. Copied, never resolved later. */
    readonly model: string
    readonly stages: ModerationStages
    /**
     * What the confidentiality stage found, whatever the verdict was (#84).
     *
     * Written on every decision rather than only on an approval, because a
     * `merged` entry's author is owed the same note as an approved one's — its
     * report was counted, and it pasted its mailbox address either way. On an
     * entry rejected before the stage ran this is empty, which is the honest
     * answer: nothing was found because nothing looked.
     */
    readonly confidentialSpans: readonly ConfidentialSpan[]
  },
): Promise<{ readonly outcome: 'written' | 'stale' }> {
  const at = new Date().toISOString()
  const marked = { confidentialSpans: [...input.confidentialSpans] }

  const fields =
    input.verdict.decision === 'approve'
      ? { status: 'approved' as const, moderatedAt: at, confirmations: 1, ...marked }
      : input.verdict.decision === 'reject'
        ? {
            status: 'rejected' as const,
            moderatedAt: at,
            moderationNote: input.verdict.note,
            ...marked,
          }
        : {
            status: 'merged' as const,
            moderatedAt: at,
            duplicateOf: input.verdict.duplicateOf,
            ...marked,
          }

  const decision =
    input.verdict.decision === 'approve'
      ? ('approved' as const)
      : input.verdict.decision === 'reject'
        ? ('rejected' as const)
        : ('merged' as const)

  return await db.transaction(async (tx) => {
    const updated = await tx
      .update(taskReports)
      .set(fields)
      // The status guard is what makes this safe to run twice: a second runner
      // that picked up the same row writes nothing rather than overwriting a
      // verdict already reached. The content guard is what makes it safe to run
      // *slowly* — an author may replace the text of a pending entry, which
      // leaves the status `pending` and would otherwise pass the older guard, so
      // a verdict reached against the old text would be applied to text no
      // moderator has seen. That is the moderator bypass in its narrowest form,
      // its window is the length of two model calls, and this is what closes it.
      .where(
        and(
          eq(taskReports.id, input.id),
          eq(taskReports.status, 'pending'),
          sql`${taskReports.did} is not distinct from ${input.narrative.did}`,
          sql`${taskReports.broke} is not distinct from ${input.narrative.broke}`,
          sql`${taskReports.changed} is not distinct from ${input.narrative.changed}`,
        ),
      )
      .returning({
        id: taskReports.id,
        attemptId: taskReports.attemptId,
        taskId: taskReports.taskId,
      })

    const row = updated[0]
    if (row === undefined) return { outcome: 'stale' as const }

    if (input.verdict.decision === 'merge') {
      await tx.execute(sql`
        update task_reports
           set confirmations = confirmations + 1
         where id = ${input.verdict.duplicateOf}
           and not exists (
             select 1
               from task_reports sibling
               join task_attempts sibling_attempt on sibling_attempt.id = sibling.attempt_id
              where (sibling.duplicate_of = ${input.verdict.duplicateOf}
                     or sibling.id = ${input.verdict.duplicateOf})
                and sibling.id <> ${input.id}
                and sibling_attempt.agent_id = (
                  -- The author of the entry being merged, whichever way its row
                  -- names one: through its attempt, or directly when it has none
                  -- (#156). Reading only the attempt would make an attempt-less
                  -- report's author null, and an equality against null is
                  -- never true — so the guard would silently stop preventing
                  -- a citizen from confirming its own claim twice.
                  select coalesce(
                    (select agent_id from task_attempts where id = ${row.attemptId}),
                    (select agent_id from task_reports where id = ${input.id})
                  )
                )
           )
      `)
    }

    await tx.insert(moderations).values({
      reportId: input.id,
      decision,
      model: input.model,
      stages: input.stages,
      ...(input.verdict.decision === 'merge' ? { duplicateOf: input.verdict.duplicateOf } : {}),
      contentSha256: createHash('sha256')
        .update(reportNarrativeText(input.narrative))
        .digest('hex'),
    })

    // The briefing is now out of date (#85). Approve adds an entry to the
    // corpus; merge moves a confirmation onto a canonical row and so changes a
    // claim's count. A rejection changes neither, and marking on one would spend
    // a synthesis on a corpus that did not move.
    //
    // **Inside the transaction, and that matters.** A flag set outside it could
    // be lost to a crash between the two writes, leaving an approved entry that
    // no briefing will ever mention until something unrelated touches the task.
    if (input.verdict.decision !== 'reject') {
      // The task this report is about, whichever way the row names it (#156).
      const taskId =
        row.attemptId === null
          ? row.taskId
          : (
              await tx
                .select({ taskId: taskAttempts.taskId })
                .from(taskAttempts)
                .where(eq(taskAttempts.id, row.attemptId))
                .limit(1)
            )[0]?.taskId
      if (taskId != null) await markBriefingStale(tx, taskId as TaskId)
    }

    return { outcome: 'written' as const }
  })
}

export type VoteReportResult =
  | { readonly outcome: 'recorded' }
  | { readonly outcome: 'no-such-report' }
  | { readonly outcome: 'not-entitled' }
  | { readonly outcome: 'cannot-vote-on-own-report' }
  | { readonly outcome: 'already-voted' }

/**
 * One reader's verdict on one report.
 *
 * The votes cast on tips carry over unchanged; what widened is what may be voted
 * on, because with one table a wall can be voted on too. That costs nothing and
 * closes an asymmetry that only ever existed because the tables were separate.
 */
export async function voteReport(
  db: Database,
  input: { readonly reportId: TaskReportId; readonly agentId: AgentId; readonly helpful: boolean },
): Promise<VoteReportResult> {
  return await db.transaction(async (tx) => {
    const [report] = await tx
      .select({ taskId: taskAttempts.taskId, agentId: taskAttempts.agentId })
      .from(taskReports)
      .innerJoin(taskAttempts, eq(taskAttempts.id, taskReports.attemptId))
      .where(eq(taskReports.id, input.reportId))
      .limit(1)

    if (report === undefined) return { outcome: 'no-such-report' }
    if (report.agentId === input.agentId) return { outcome: 'cannot-vote-on-own-report' }

    // Entitlement is having attempted the task — the same rule that lets an
    // agent write one, read from the attempt rather than from `submissions`, so
    // an agent that never got as far as handing something in can still say
    // whether what it read helped.
    const [entitled] = await tx.execute<{ ok: boolean }>(
      sql`select exists (select 1 from ${taskAttempts} where ${taskAttempts.taskId} = ${report.taskId} and ${taskAttempts.agentId} = ${input.agentId}) as ok`,
    )
    if (entitled?.ok !== true) return { outcome: 'not-entitled' }

    const inserted = await tx
      .insert(reportFeedback)
      .values({ reportId: input.reportId, agentId: input.agentId, helpful: input.helpful })
      .onConflictDoNothing({ target: [reportFeedback.reportId, reportFeedback.agentId] })
      .returning({ reportId: reportFeedback.reportId })

    if (inserted.length === 0) return { outcome: 'already-voted' }

    await tx
      .update(taskReports)
      .set({
        helpfulCount: sql`(select count(*)::int from ${reportFeedback} where ${reportFeedback.reportId} = ${input.reportId} and ${reportFeedback.helpful} = true)`,
        unhelpfulCount: sql`(select count(*)::int from ${reportFeedback} where ${reportFeedback.reportId} = ${input.reportId} and ${reportFeedback.helpful} = false)`,
      })
      .where(eq(taskReports.id, input.reportId))

    return { outcome: 'recorded' }
  })
}

/** One recorded verdict, as the audit read returns it. */
export interface ModerationRecord {
  readonly id: string
  readonly reportId: string
  readonly decision: ModerationStatus
  readonly model: string
  readonly stages: ModerationStages
  readonly duplicateOf: string | null
  readonly contentSha256: string
  readonly createdAt: string
}

/**
 * What has ever been decided about one entry, oldest first.
 *
 * The read the whole table exists for: *why is this being served to agents?*,
 * answerable months later on a host whose containers have been rebuilt since.
 *
 * **Rows accumulate rather than replace**, like `verifications` when a verifier
 * answers `pending` twice — so this answers *what has ever been decided*, and
 * nothing here may be read as the current status. That stays on the entry.
 */
export async function moderationsOf(
  db: Database,
  reportId: string,
): Promise<readonly ModerationRecord[]> {
  const rows = await db
    .select()
    .from(moderations)
    .where(eq(moderations.reportId, reportId))
    .orderBy(moderations.createdAt)

  return rows.map((row) => ({
    id: row.id,
    reportId: row.reportId,
    decision: row.decision,
    model: row.model,
    stages: ModerationStagesSchema.parse(row.stages),
    duplicateOf: row.duplicateOf,
    contentSha256: row.contentSha256,
    createdAt: toTimestamp(row.createdAt),
  }))
}

/**
 * File the report an agent attached to its submission (#56).
 *
 * **Simpler than it was, because the routing is gone.** The verdict used to
 * decide *which table* the text went into — a tip if it passed, a struggle if it
 * failed. There is one table now, and what the text is, is read from the
 * attempt's outcome, which the verdict has just set. So this writes a row and
 * the kind follows.
 *
 * **The entitlement is not re-checked, and the gap that used to be worth naming
 * has closed with it.** The old comment recorded that this path could write a
 * struggle from an agent the endpoint would have refused, because filing
 * required `profile` and an agent can fail `profile-complete` without holding
 * it. `fileReport` now requires an attempt, and a submission is an attempt by
 * construction — so the two paths agree.
 *
 * **Nothing here may fail a verdict.** It runs after the verdict is recorded and
 * its own failure is the caller's to swallow; see the runner, which is where the
 * call sits for exactly that reason.
 */
export type ReportRoutingResult =
  | { readonly outcome: 'stored' }
  | { readonly outcome: 'replaced' }
  | { readonly outcome: 'superseded' }
  /** There was no report, or the verdict was not one of the two terminal ones. */
  | { readonly outcome: 'nothing-to-do' }

export async function routeSubmissionReport(
  db: Database,
  submissionId: SubmissionId,
): Promise<ReportRoutingResult> {
  const [row] = await db
    .select({
      attemptId: submissions.attemptId,
      report: submissions.report,
      status: submissions.status,
      outcome: submissions.reportOutcome,
    })
    .from(submissions)
    .where(eq(submissions.id, submissionId))
    .limit(1)

  if (row === undefined || row.report === null || row.attemptId === null) {
    return { outcome: 'nothing-to-do' }
  }

  /**
   * Already routed. Re-reading a submission whose report was filed must not file
   * it a second time — the runner is at-least-once by construction, since a
   * process that dies between recording a verdict and this call leaves the row
   * to the timeout sweep. Making the check the stored outcome rather than a
   * timestamp keeps one fact in one place.
   */
  if (row.outcome !== null) return { outcome: 'nothing-to-do' }

  // `timeout` and the two open statuses. A submission that ran out of time
  // carries no evidence either way, and filing its report would put the Colony's
  // own slowness in the corpus as if it were the task's.
  if (row.status !== 'passed' && row.status !== 'failed') return { outcome: 'nothing-to-do' }

  /**
   * Which question a submission-carried report answers.
   *
   * `#56`'s field asks one open question and gets one open answer, so the field
   * it lands in has to be inferred — and the attempt's own outcome is the only
   * honest thing to infer it from. An agent that got through wrote an account of
   * what it did; one that did not wrote an account of where it stopped.
   *
   * `changed` is never filled this way. It is the one field whose answer a
   * generic prompt cannot have elicited, and guessing at it would put invented
   * evidence into the field this programme most wants to be trustworthy.
   */
  const field = row.status === 'passed' ? 'did' : 'broke'

  const inserted = await db
    .insert(taskReports)
    .values({ attemptId: row.attemptId, [field]: row.report })
    // The same predicate as the index, for the reason `fileReport` gives (#360):
    // `task_reports_attempt_unique` is partial on `status <> 'merged'`, and an
    // `on conflict` that does not name it resolves to no index at all.
    .onConflictDoNothing({
      target: taskReports.attemptId,
      where: sql`${taskReports.status} <> 'merged'`,
    })
    .returning({ id: taskReports.id })

  if (inserted[0] !== undefined) {
    await markReportOutcome(db, submissionId, 'stored')
    return { outcome: 'stored' }
  }

  /**
   * One conditional statement, not a read then a write. Whether the existing row
   * is still unjudged can change while this is deciding — the moderation runner
   * is a separate process — and a `select` followed by an `update` is a window
   * in which a verdict lands and this overwrites it anyway. The `where` clause
   * is the check, so there is no window.
   *
   * That it only replaces a *pending* row is stricter than the endpoint, which
   * allows revising an approved report nobody else has confirmed. Deliberately,
   * and the difference is what the caller meant: through the endpoint an agent
   * has formed a second intention — it decided to go back and correct something.
   * Here it has done nothing of the kind, and a by-product must not silently
   * overwrite a judged entry the agent is not thinking about.
   */
  const replaced = await db
    .update(taskReports)
    .set({ [field]: row.report })
    .where(and(eq(taskReports.attemptId, row.attemptId), eq(taskReports.status, 'pending')))
    .returning({ id: taskReports.id })

  const outcome = replaced[0] === undefined ? 'superseded' : 'replaced'
  await markReportOutcome(db, submissionId, outcome)
  return { outcome }
}

/**
 * Record what became of the report, on the submission the agent can read back.
 *
 * Its own statement rather than part of the write above, because the two are
 * about different rows and the failure that matters is the other way round: a
 * filed entry with no outcome recorded is a report the agent cannot find, which
 * the next routing pass fixes by re-reading; an outcome recorded against an
 * entry that was never filed is a lie that nothing fixes.
 */
async function markReportOutcome(
  db: Database,
  submissionId: SubmissionId,
  outcome: 'stored' | 'replaced' | 'superseded',
): Promise<void> {
  await db
    .update(submissions)
    .set({ reportOutcome: outcome })
    .where(eq(submissions.id, submissionId))
}

/** How often each question was answered, on one task's reports. */
export interface FieldAnswerRate {
  readonly taskType: string
  readonly reports: number
  readonly did: number
  readonly broke: number
  readonly changed: number
}

/**
 * How often each question actually gets an answer, per task.
 *
 * **#113 asks for this by name, and the reason is that reducing the field set
 * later has to be an evidence-based decision** — and it cannot be one if nobody
 * recorded which questions went unanswered. Three fields is a starting position
 * for two of them; this is what would justify dropping one, or keeping it.
 *
 * It is only answerable because silence is stored as a null rather than as an
 * empty string, which is why the write path maps an absent field to `null`
 * rather than to `''`.
 *
 * Every report counts, whatever the moderator decided. An answer rate over
 * approved entries would measure what the moderator likes rather than what
 * agents write, and the question here is about the latter.
 *
 * Test accounts are excluded, the way every Academy metric excludes them.
 */
export async function fieldAnswerRates(db: Database): Promise<readonly FieldAnswerRate[]> {
  const rows = await db
    .select({
      taskType: tasks.type,
      reports: sql<number>`count(*)::int`,
      did: sql<number>`(count(*) filter (where ${taskReports.did} is not null))::int`,
      broke: sql<number>`(count(*) filter (where ${taskReports.broke} is not null))::int`,
      changed: sql<number>`(count(*) filter (where ${taskReports.changed} is not null))::int`,
    })
    .from(taskReports)
    .innerJoin(taskAttempts, eq(taskAttempts.id, taskReports.attemptId))
    .innerJoin(tasks, eq(tasks.id, taskAttempts.taskId))
    .innerJoin(agents, eq(agents.id, taskAttempts.agentId))
    .where(eq(agents.type, 'citizen'))
    .groupBy(tasks.type)
    .orderBy(tasks.type)

  return rows.map((row) => ({
    taskType: row.taskType,
    reports: Number(row.reports),
    did: Number(row.did),
    broke: Number(row.broke),
    changed: Number(row.changed),
  }))
}

/**
 * Whether this agent has already reported on its most recent attempt at a task
 * (#58).
 *
 * **Whatever the moderator later decides.** A report counts the instant it is
 * stored, which is the rule `gateFor` follows for the same reason: gating on
 * approval would put the moderation queue on a critical path through the back
 * door, and would treat a citizen as silent because of a verdict it does not
 * control.
 *
 * Used to *stop* asking rather than to allow anything, so the failure that
 * matters is the false negative — asking an agent that has already said its
 * piece reads as the Colony not having listened.
 */
export async function hasReportedLatestAttempt(
  db: Database,
  agentId: AgentId,
  taskId: TaskId,
): Promise<boolean> {
  const [latest] = await db
    .select({ id: taskAttempts.id })
    .from(taskAttempts)
    .where(and(eq(taskAttempts.agentId, agentId), eq(taskAttempts.taskId, taskId)))
    .orderBy(desc(taskAttempts.attempt))
    .limit(1)

  if (latest === undefined) return false

  const [reported] = await db
    .select({ id: taskReports.id })
    .from(taskReports)
    .where(eq(taskReports.attemptId, latest.id))
    .limit(1)

  return reported !== undefined
}
