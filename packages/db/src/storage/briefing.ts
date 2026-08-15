import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import {
  CURRENT_CLAIM_ATTEMPTS,
  RECENT_REPORTS_IN_CONTEXT,
  now as currentTime,
  ServedBriefingClaimSchema,
  TaskBriefingSchema,
  isCurrentClaim,
  reportKindFor,
  reportNarrativeText,
  type AgentId,
  type AgentPlatform,
  type BriefingClaim,
  type CapabilityDivide,
  type CapabilityFlag,
  type InboundRoute,
  type InboundRouteDivide,
  type NamedWall,
  type ReportKind,
  type TaskBriefing,
  type TaskId,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { agents, taskAttempts, taskBriefings, taskReports, tasks } from '../schema/index.js'
import {
  capabilityDivides,
  inboundRouteDivide,
  latestDeclaredCapabilities,
  latestDeclaredInboundRoute,
} from './attempts.js'
import { toTimestamp } from './rows.js'

/**
 * Everything the synthesis needs about one entry, and nothing about its author.
 *
 * **No `agentId`, deliberately.** The synthesis writes text that is published, so
 * the less it is handed about who wrote what, the fewer ways there are for that to
 * reach the page. What it needs is the observation and the shape of the evidence:
 * how many agents, on which runtimes, how recently.
 */
export interface BriefingSource {
  readonly id: string
  /** Read from the attempt's outcome, never stored — see `reportKindFor` in core. */
  readonly kind: ReportKind
  /** The author's own text. Read by the synthesis model and by nothing that serves a reader. */
  readonly content: string
  /**
   * How many agents this entry stands for.
   *
   * `confirmations`, which counts the distinct agents whose reports were merged
   * into it. Advice carries one now for the same reason a wall does — with one
   * table both merge, so a way through that four agents independently described
   * is one entry standing for four.
   */
  readonly reports: number
  readonly platforms: Readonly<Partial<Record<AgentPlatform, number>>>
  /**
   * When a report last supported it — the newest of the entry and everything
   * merged into it.
   *
   * `created_at` of the *entry* would answer *when was this first said*, which
   * is the wrong question for a claim that has to decay: a wall first reported
   * in March and confirmed again yesterday is a live wall.
   */
  readonly lastSupportedAt: string
  /**
   * Whether there is an attempt behind this entry (#169).
   *
   * **This is what makes serving an attempt-less report safe rather than merely
   * generous.** `#156` made it possible to file one: a citizen that read a task
   * and concluded it could not comply, or whose challenge mint failed on the
   * Colony's side, can say so without spending a try. Such a claim is *I could
   * not begin* — which is a different statement from *I tried and this stopped
   * me*, and a synthesis handed both without the distinction will write the
   * second sentence about the first kind of entry. That is a claim about the
   * world nobody made.
   *
   * It is carried and never filtered on. Nothing gates, weights or ranks by it:
   * the corpus is already bounded and already ordered most-confirmed-first, so a
   * lone uncorroborated claim falls off a busy task's corpus on its own.
   */
  readonly attempted: boolean
}

/**
 * The whole moderated corpus of one task, walls and advice together.
 *
 * **Together is the point.** The read model this replaces split them by
 * provenance — a struggle needed no pass, a tip needed one — and the reader asks
 * about *use* rather than about whom to believe. The most actionable paragraph
 * on the first task the Colony ever ran was a section of advice inside a
 * struggle, written by an agent that had not passed and therefore could not file
 * a tip.
 *
 * **One query where there were two** (#110). The split survived here after the
 * reader-side one had gone, because there were still two tables to read from.
 *
 * **`approved` only.** Never `pending`, never `rejected`, and never the *text*
 * of a `merged` row — a merged entry's contribution is the count it moved onto
 * the canonical row, which `confirmations` already carries. Serving its prose to
 * the synthesis would put a restatement into the corpus twice.
 */
export async function briefingCorpus(
  db: Database,
  taskId: TaskId,
): Promise<readonly BriefingSource[]> {
  const rows = await db
    .select({
      id: taskReports.id,
      attemptId: taskReports.attemptId,
      outcome: taskAttempts.outcome,
      did: taskReports.did,
      broke: taskReports.broke,
      changed: taskReports.changed,
      discarded: taskReports.discarded,
      reports: taskReports.confirmations,
      platforms: reportPlatforms,
      lastSupportedAt: reportLastSupported,
    })
    .from(taskReports)
    /**
     * **Left, since #169.** The inner join predates the nullable `attempt_id`
     * that `#156` added, and it silently excluded every attempt-less report from
     * the corpus — including the one most worth publishing, because *this task
     * cannot be started on my runtime* is the only claim a reader can act on
     * before spending an attempt. Withholding exactly that is the opposite of
     * what the briefing is for.
     */
    .leftJoin(taskAttempts, eq(taskAttempts.id, taskReports.attemptId))
    .where(
      and(
        /**
         * Whichever side owns the task. `task_reports_owner_is_one_or_the_other`
         * guarantees exactly one of them is set, so this is a total read rather
         * than a preference between two possible answers.
         */
        sql`coalesce(${taskAttempts.taskId}, ${taskReports.taskId}) = ${taskId}`,
        eq(taskReports.status, 'approved'),
        /**
         * **The *try is over* rule survives for rows that have a try.** The
         * outcome test was never about attempt-less reports — it is vacuously
         * true of a try that never began — so it now applies only where there is
         * something for it to be about. An attempt still running is still out:
         * the Colony not having decided is not the citizen's report.
         *
         * **The parentheses are load-bearing.** `and()` concatenates its parts
         * with `AND`, so a bare `x or y` here binds as `(a and b and x) or y`
         * and lets every row with a closed attempt through regardless of task or
         * moderation status. Two existing tests caught it, which is the argument
         * for having had them — and it is the same mistake the revisability guard
         * in `guidance.ts` records making, one file away.
         */
        sql`(${taskReports.attemptId} is null or ${taskAttempts.outcome} is not null)`,
      ),
    )
    /**
     * **Bounded, and this is the sentence that pays for the larger report
     * ceiling** (#113). The objection to raising it was that the whole approved
     * corpus is read back as context, so the cost of moderating a task grew with
     * the longest thing anybody ever wrote about it. Bound the context and the
     * per-entry bound stops being load-bearing.
     *
     * Most-confirmed first and newest as the tiebreak, so what falls off the end
     * on a busy task is the least-corroborated and oldest — which is what a
     * reader would drop too.
     */
    .orderBy(desc(taskReports.confirmations), desc(taskReports.createdAt))
    .limit(RECENT_REPORTS_IN_CONTEXT)

  return rows.map((row) => ({
    id: row.id,
    /**
     * `wall` for an attempt-less entry, where `reportKindFor` answers `null`
     * because there is no outcome to read.
     *
     * A wall is the right reading: the citizen hit something. What it is *not*
     * is advice, and that is the distinction `kind` exists to make — advice is
     * followed, a wall is weighed, and only an author that passed may give the
     * first. Which kind of wall it is, `attempted` says.
     */
    kind: reportKindFor(row.outcome) ?? ('wall' satisfies ReportKind),
    content: reportNarrativeText({
      did: row.did,
      broke: row.broke,
      changed: row.changed,
      discarded: row.discarded,
    }),
    reports: row.reports,
    platforms: row.platforms as Readonly<Partial<Record<AgentPlatform, number>>>,
    lastSupportedAt: toTimestamp(row.lastSupportedAt),
    attempted: row.attemptId !== null,
  }))
}

/**
 * The runtimes behind one report, counting its merged children.
 *
 * The same correlated subquery `platformBreakdown` in `guidance.ts` runs, and it
 * is repeated rather than shared for the reason that file already gives about
 * writing the identifiers out: in a select-field position Drizzle renders a
 * column unqualified, so the alias has to be spelled to keep `id` unambiguous
 * inside a subquery over the same table.
 *
 * `count(distinct …)` rather than `count(*)`, because one agent can now hold
 * several reports on a task — see `platformBreakdown` for the full argument.
 *
 * **The join to `task_attempts` is left, and the author is coalesced** (#169).
 * An attempt-less report carries its author on the report row itself, so an
 * inner join here dropped it from the runtime breakdown — which would have been
 * the quieter half of the same bug: the entry would appear in the corpus with an
 * empty `platforms`, and *which runtimes cannot start this rung* is precisely
 * what a reader wants from it.
 */
const reportPlatforms = sql<Record<string, number>>`(
  select coalesce(jsonb_object_agg(counted.platform, counted.total), '{}'::jsonb)
    from (
      select author.platform::text as platform, count(distinct author.id)::int as total
        from task_reports reported
        left join task_attempts tried on tried.id = reported.attempt_id
        join agents author on author.id = coalesce(tried.agent_id, reported.agent_id)
       where reported.id = task_reports.id or reported.duplicate_of = task_reports.id
       group by author.platform
    ) counted
)`

/** The newest report behind one entry — itself, or the last thing merged into it. */
const reportLastSupported = sql<string>`(
  select max(reported.created_at)
    from task_reports reported
   where reported.id = task_reports.id or reported.duplicate_of = task_reports.id
)`

/**
 * Mark a task's briefing as out of date.
 *
 * **Called where the approved corpus could have moved, not where it definitely
 * did.** A dirty flag is a *may*, and the asymmetry of the two mistakes decides
 * it: a redundant synthesis costs one model call, while a missed one leaves a
 * reader acting on a wall that has since been fixed.
 *
 * The upsert is what lets a task with no briefing yet be marked — the row comes
 * into existence here, empty and dirty, before anything has been written. That
 * row is also what tells a reader *the Colony has not written this up yet* apart
 * from *nobody has reported anything*, and those must not read the same.
 */
export async function markBriefingStale(db: Database | Transaction, taskId: TaskId): Promise<void> {
  await db
    .insert(taskBriefings)
    .values({ taskId })
    .onConflictDoUpdate({ target: taskBriefings.taskId, set: { dirty: true } })
}

/**
 * The tasks whose briefings need rewriting, oldest first.
 *
 * Bounded by a batch size for the reason the moderation queue is: this is the
 * other process in the Colony that spends money per row, and one tick that found
 * two hundred stale tasks would spend two hundred syntheses in a burst.
 */
export async function staleBriefings(db: Database, limit: number): Promise<readonly TaskId[]> {
  const rows = await db
    .select({ taskId: taskBriefings.taskId })
    .from(taskBriefings)
    .where(eq(taskBriefings.dirty, true))
    .orderBy(asc(taskBriefings.createdAt))
    .limit(limit)

  return rows.map((row) => row.taskId as TaskId)
}

/**
 * Store a freshly written briefing and clear the flag.
 *
 * **The flag is cleared unconditionally, and that is a decision with a cost.** A
 * report approved *while* a synthesis was in flight leaves the flag cleared over
 * a corpus the briefing did not see, so that claim waits for the next change
 * rather than the next tick. The alternative — a compare-and-clear on a version
 * counter — buys freshness measured against a tick that is deliberately slow
 * anyway, and it buys it with a second column and a retry loop. A briefing is
 * allowed to be one report behind; it is not allowed to be wrong about the
 * reports it names, and it never is, because the counts come from the entries it
 * was written from.
 */
/**
 * Who a set of entries was written by, split by whether they may be named
 * (`#958`).
 *
 * **Merged children count, exactly as they do in {@link reportPlatforms}.** A
 * claim's report count includes the duplicates folded into its sources, so the
 * citizens behind those duplicates contributed to the sentence a reader sees;
 * naming only the survivors would credit whoever happened to file first.
 *
 * **The author is `coalesce(attempt, report)`**, which is this file's rule
 * everywhere: a report filed against an attempt belongs to that attempt's agent,
 * and one filed without an attempt carries its author itself.
 *
 * The split is `agents.attributed` and it is applied here rather than by the
 * caller, so a handle a citizen declined is never in memory for a later line to
 * print by accident — the same argument `#961` makes in `atlas-links.ts`.
 */
async function contributorsOf(
  db: Database,
  entryIds: readonly string[],
): Promise<{ readonly named: readonly string[]; readonly withheld: number }> {
  if (entryIds.length === 0) return { named: [], withheld: 0 }

  const reported = alias(taskReports, 'reported')
  const tried = alias(taskAttempts, 'tried')
  const author = alias(agents, 'author')
  const ids = [...entryIds]

  const rows = await db
    .selectDistinct({ name: author.name, attributed: author.attributed })
    .from(reported)
    .leftJoin(tried, eq(tried.id, reported.attemptId))
    .innerJoin(author, eq(author.id, sql`coalesce(${tried.agentId}, ${reported.agentId})`))
    .where(or(inArray(reported.id, ids), inArray(reported.duplicateOf, ids)))

  return {
    named: rows.filter((row) => row.attributed).map((row) => row.name),
    withheld: rows.filter((row) => !row.attributed).length,
  }
}

export async function writeBriefing(
  db: Database,
  input: {
    readonly taskId: TaskId
    readonly claims: readonly BriefingClaim[]
    readonly model: string
  },
): Promise<void> {
  /**
   * **No claims, no row** (`#611`).
   *
   * A briefing with nothing in it makes an offer that cannot be met: `#610` tells
   * an agent after a failed attempt that the Colony knows something about this
   * task, and an agent that follows that and receives an empty answer learns to
   * stop following it — the cost of which lands on the tasks where the hints are
   * good. It also hides the gap: forty briefings for forty-odd tasks reads as
   * coverage, while twenty-eight with claims and twelve tasks nobody has reported
   * on is the truer and more useful picture.
   *
   * **Deleted rather than written and hidden.** A row kept for bookkeeping would
   * need every reader-facing surface to remember to skip it, and *remember to* is
   * how the twelve got read in the first place. The absence carries the same
   * information and cannot be misread.
   *
   * **The flag goes with the row, which is what stops the rewrite loop.** The
   * task is no longer stale because there is nothing left to be stale; the next
   * approved report calls `markBriefingStale`, which recreates the row, and the
   * next tick synthesises it. So an empty briefing costs one synthesis per change
   * rather than one per tick.
   */
  if (input.claims.length === 0) {
    await db.delete(taskBriefings).where(eq(taskBriefings.taskId, input.taskId))
    return
  }

  const at = new Date().toISOString()

  /**
   * The contributors, resolved once at write time (`#958`).
   *
   * **Stored rather than joined on read**, which the issue decides for us: a
   * read-time join would make erasure work by accident — the join breaks, the
   * name vanishes — and it would stop working the first time a briefing is
   * cached or exported. `eraseAgent` edits this array explicitly instead.
   *
   * Derived from the claims' own sources, so what is named is exactly what the
   * briefing was written from and cannot drift from the counts beside it.
   */
  const sources = [...new Set(input.claims.flatMap((claim) => claim.sources))]
  const contributors = await contributorsOf(db, sources)
  const written = {
    claims: [...input.claims],
    contributors: [...contributors.named].sort((left, right) => left.localeCompare(right)),
    contributorsWithheld: contributors.withheld,
    model: input.model,
    writtenAt: at,
    dirty: false,
  }

  await db
    .insert(taskBriefings)
    .values({ taskId: input.taskId, ...written })
    .onConflictDoUpdate({ target: taskBriefings.taskId, set: written })
}

/**
 * The later of two moments, either of which may be absent.
 *
 * Both arguments are demotion lines drawn by positive evidence that a claim's
 * subject moved — a detected provider change, and a revision of what the task
 * asks for. They are the same kind of fact, so the more recent one is the one
 * still true, and a claim has to have been confirmed since it to stand.
 */
function laterOf(left: string | null, right: string | null): string | null {
  if (left === null) return right
  if (right === null) return left
  return Date.parse(left) >= Date.parse(right) ? left : right
}

/**
 * The demotion line, or `null` because the synthesis has already answered it
 * (`#203`).
 *
 * **A change the briefing was written after is a change the briefing already
 * accounts for.** The structural demotion exists for the window between the
 * world moving and the corpus being re-read; once the synthesis has run against
 * the new state, its output *is* the re-reading, and demoting it protects a
 * reader from the Colony's own current answer.
 *
 * Equal timestamps demote, which is the conservative side of a boundary nobody
 * will ever hit: a synthesis that started in the same millisecond as the
 * revision read the old text.
 */
function demotionLine(changedAt: string | null, writtenAt: string): string | null {
  if (changedAt === null) return null
  return Date.parse(writtenAt) > Date.parse(changedAt) ? null : changedAt
}

/**
 * One task's briefing, or nothing.
 *
 * **Serves a stale briefing without complaint**, which is the degradation
 * contract: if the synthesis runner is down a reader gets the last good briefing
 * with its age visible, never an error and never a fallback to raw entries. A row
 * that has been marked dirty but never written answers `undefined` — there is no
 * briefing yet, which is a different answer from an empty one.
 */
export async function readBriefing(
  db: Database,
  taskId: TaskId,
): Promise<TaskBriefing | undefined> {
  const [row] = await db
    .select({
      taskId: taskBriefings.taskId,
      claims: taskBriefings.claims,
      contributors: taskBriefings.contributors,
      contributorsWithheld: taskBriefings.contributorsWithheld,
      model: taskBriefings.model,
      writtenAt: taskBriefings.writtenAt,
      changeDetectedAt: taskBriefings.changeDetectedAt,
      // Joined rather than read separately: it is part of the same question —
      // *what has happened since this claim was last confirmed* — and two reads
      // could see two different answers.
      textRevisedAt: tasks.textRevisedAt,
    })
    .from(taskBriefings)
    .innerJoin(tasks, eq(tasks.id, taskBriefings.taskId))
    .where(eq(taskBriefings.taskId, taskId))
    .limit(1)

  if (row === undefined || row.writtenAt === null || row.model === null) return undefined

  /**
   * Which claims still stand in the foreground (#113).
   *
   * **Computed on read, not stored.** Whether a claim is current is a fact about
   * how much has happened since it was last confirmed, and that changes with
   * every attempt that closes — a stored flag would be wrong between the moment
   * it was written and the sweep that noticed. One extra query per briefing read
   * is the honest price.
   *
   * **Nothing is deleted, and that is the rule rather than the implementation.**
   * A provider that broke something can fix it, and a claim that was true in
   * June can be true again in September. A demoted claim leaves the foreground
   * and stays readable with its age visible, and a later report confirming it
   * moves `lastSupportedAt` forward and brings it straight back.
   */
  const window = {
    oldestCurrentAttempt: await oldestCurrentAttempt(db, taskId),
    now: currentTime(),
    /**
     * The demotion line, which two events can draw — and only while the briefing
     * predates it (#115, #182, #203).
     *
     * It overrides both recency bounds, because either one is positive evidence
     * rather than silence: a wall the provider has taken down should leave the
     * foreground now, not in ninety days.
     *
     * **The later of the two, because both are that same kind of evidence and
     * the more recent one is the one still true.** A provider change is the
     * world moving under the claims; a text revision is the Colony moving it.
     *
     * **And it stops applying once the synthesis has run since (`#203`).** A
     * citizen found `email-inbox` serving sixteen claims and every one of them
     * demoted. Measured against production on 2026-08-04, the rule had done
     * exactly what `#182` asked: the wording was revised at 22:47, and the
     * newest report supporting any claim was from 22:35. But the briefing itself
     * was written at 23:05 — *after* the revision — by a synthesis that had been
     * handed the new instructions and told they overrule the corpus whatever the
     * confirmation count. So the correction had already been applied by the half
     * of `#182` that reads meaning, and applying it again here demoted the
     * result of that work. The reader got a briefing with an empty foreground,
     * which is not the safer answer: it is the same silence as no briefing at
     * all, with the cost of the synthesis already paid.
     *
     * The structural half still covers the case it was built for — a briefing
     * written before the wording moved, where nothing has re-read the corpus and
     * the reader is genuinely unprotected. That is the state `#182` measured.
     * Once a synthesis has run against the new text, what it wrote is the
     * Colony's current reading, and demoting it is the Colony disagreeing with
     * itself in favour of the older answer.
     */
    changeDetectedAt: demotionLine(
      laterOf(row.changeDetectedAt, row.textRevisedAt),
      toTimestamp(row.writtenAt),
    ),
  }

  /**
   * **A stored claim that no longer validates costs that claim, never the
   * task** (`#729`).
   *
   * A 460-character claim reached this table — the synthesis asked the model for
   * 400 and did not check the answer, which `#729` fixes on the write side — and
   * because the whole briefing was parsed as one object, `kolonie.tasks.get`
   * threw for every citizen asking about that task. Guidance the Colony could
   * not read back took the task with it.
   *
   * **The failure direction is the one `#716` argues for one level up**: a
   * briefing is guidance, and a reader losing one sentence of it is
   * incomparably better than losing the task. So each claim is validated on its
   * own and a claim that fails is dropped rather than thrown on.
   *
   * **The bound is not relaxed here, and that is deliberate.** Widening the
   * schema to fit what was written would make the read stop failing by agreeing
   * with the defect, and `BRIEFING_CLAIM_MAX_LENGTH` exists to stop a synthesis
   * reproducing an entry verbatim under the heading of having rewritten it.
   * What is loosened is the consequence, not the rule.
   *
   * **It is silent, and the loud half is on the write side.** This package logs
   * nowhere and is not the place to start — `packages/db` knows about the
   * domain model and about Postgres, and a logger is a third thing. What
   * produces an unservable claim is the synthesis, which now counts and warns
   * `briefing.claim.overlong` at the moment it happens. A drop here is the
   * consequence of a row already written; the event worth watching for is the
   * writing of it.
   */
  const claims = row.claims
    .map((claim) =>
      ServedBriefingClaimSchema.safeParse({ ...claim, current: isCurrentClaim(claim, window) }),
    )
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data)

  return TaskBriefingSchema.parse({
    taskId: row.taskId,
    claims,
    /**
     * Served as stored (`#958`). The opt-out was applied when the briefing was
     * written and an erasure edits the array in place, so there is nothing to
     * filter here — and nothing that could resolve a handle a citizen has
     * since withdrawn.
     */
    contributors: row.contributors,
    contributorsWithheld: row.contributorsWithheld,
    model: row.model,
    writtenAt: toTimestamp(row.writtenAt),
  })
}

/**
 * When the oldest attempt still inside the recency window closed, or `null`.
 *
 * `null` means the task has had fewer than {@link CURRENT_CLAIM_ATTEMPTS} closed
 * attempts, so nothing has been pushed out of the window and every claim is
 * inside it by definition.
 *
 * `offset` rather than a count per claim: one query answers the bound for every
 * claim at once, and the bound is a property of the task rather than of any
 * claim.
 */
async function oldestCurrentAttempt(db: Database, taskId: TaskId): Promise<string | null> {
  const [row] = await db
    .select({ closedAt: taskAttempts.closedAt })
    .from(taskAttempts)
    .where(and(eq(taskAttempts.taskId, taskId), sql`${taskAttempts.outcome} is not null`))
    .orderBy(desc(taskAttempts.closedAt))
    .offset(CURRENT_CLAIM_ATTEMPTS - 1)
    .limit(1)

  return row?.closedAt === undefined || row.closedAt === null ? null : toTimestamp(row.closedAt)
}

/**
 * Which published claims each of these entries helped write.
 *
 * **The feedback loop that makes the synthesis honest.** A claim carries no
 * author, so no reader can push back against it and no author would recognise a
 * mangling of its own report — unless the author is shown what its report became.
 * That is what this answers, keyed by entry id.
 *
 * Matched in the query rather than in the caller: the alternative is fetching
 * every briefing for every task an author has written about and filtering in
 * TypeScript, which reads the whole claims column of unrelated tasks to throw
 * most of it away.
 */
export async function claimsFedBy(
  db: Database,
  entryIds: readonly string[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  const fed = new Map<string, string[]>()
  if (entryIds.length === 0) return fed

  const rows = await db
    .select({
      entryId: sql<string>`source.value #>> '{}'`,
      text: sql<string>`claim.value ->> 'text'`,
    })
    .from(taskBriefings)
    // Two lateral expansions: claims out of the briefing, then sources out of
    // each claim. `jsonb_array_elements` is the only way to reach inside without
    // reading whole columns back into the process.
    .innerJoin(
      sql`lateral jsonb_array_elements(${taskBriefings.claims}) as claim(value)`,
      sql`true`,
    )
    .innerJoin(
      sql`lateral jsonb_array_elements(claim.value -> 'sources') as source(value)`,
      sql`true`,
    )
    .where(inArray(sql`source.value #>> '{}'`, [...entryIds]))

  for (const row of rows) {
    const existing = fed.get(row.entryId)
    if (existing === undefined) fed.set(row.entryId, [row.text])
    else existing.push(row.text)
  }

  return fed
}

/**
 * What a task is called, for the synthesis prompt.
 *
 * A single column rather than `readTask`, which assembles hints, skills and
 * reward fields the synthesis has no use for. The title is the only thing the
 * prompt needs from the task itself — it is what tells the model what the corpus
 * is *about*, so that *"the form asks for a phone number"* is read against
 * obtaining a mailbox rather than in the abstract.
 */
export async function readTaskTitle(db: Database, taskId: TaskId): Promise<string | undefined> {
  return (await readTaskText(db, taskId))?.title
}

/** What a task asks for, as the synthesis has to measure claims against it (#182). */
export interface TaskText {
  readonly title: string
  readonly instructions: string
}

/**
 * The task's own words, for the synthesis to check its claims against.
 *
 * **The corpus alone cannot answer whether a claim is still about this task.** A
 * citizen proved that: `email-inbox` dropped the requirement to send, and three
 * reports about a send-side wall stayed `current: true` beside a correction that
 * matched the new text — while the task's instructions said, in bold, *"You are
 * never asked to send anything."* The evidence that settles it was one column
 * away and nothing read it.
 *
 * The instructions rather than the description: they are the machine-actionable
 * half, the half a claim can contradict in as many words, and the half
 * `academy.md` requires to be unambiguous enough to act on.
 */
export async function readTaskText(db: Database, taskId: TaskId): Promise<TaskText | undefined> {
  const [row] = await db
    .select({ title: tasks.title, instructions: tasks.instructions })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)

  return row === undefined ? undefined : { title: row.title, instructions: row.instructions }
}

/**
 * Whether a task is a quest or a rung (`#367`).
 *
 * **One question with one answer, asked at the seam that needs it.** A quest and
 * a rung share `task_briefings` and the synthesis that writes it, and differ in
 * which table their corpus comes from — so the runner's store asks this and
 * neither corpus function has to know the other exists.
 */
export async function readTaskKind(db: Database, taskId: TaskId): Promise<string | undefined> {
  const [row] = await db
    .select({ kind: tasks.kind })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)

  return row?.kind
}

/**
 * Everything a personalised briefing needs about the reader and the task, in one
 * round trip (#114).
 *
 * **One call rather than three, for the reason `attemptStanding` is one call for
 * three numbers**: these are facts that have to agree with each other. A reader
 * told its configuration is missing a capability, on a task whose divide was
 * computed a moment later from different rows, would be shown a sentence and its
 * own contradiction next to it.
 *
 * `movesMoney` reads the task's kind rather than a field of its own. Only a
 * Quest pays credits — `governance/economy.md` §2 is absolute that no credit is ever
 * minted as a reward for work, and `TaskKindSchema` is a column precisely so that
 * rule is checkable by Postgres rather than by every author remembering. So the
 * question *does this task move money* is already answered, and a second flag
 * would be a second owner of the same fact.
 */
export interface ReaderContext {
  readonly divides: readonly CapabilityDivide[]
  /** What the reader last declared it is running as, or `null` if it never has. */
  readonly declared: Readonly<Partial<Record<CapabilityFlag, boolean>>> | null
  readonly movesMoney: boolean
  /**
   * How the inbound route divided this rung, and where the reader stands (#393).
   *
   * Beside `divides` rather than folded into it, because the axis is a
   * five-member set rather than a flag and the two sides are derived from it.
   * The counts are always computed; whether anything is *said* is
   * `inboundRouteCorrelation`'s decision, on the same two floors.
   */
  readonly inboundDivide: InboundRouteDivide
  /** What the reader last declared about being reachable, or `null` if it never has. */
  readonly inboundDeclared: InboundRoute | null
}

export async function readerContext(
  db: Database,
  agentId: AgentId,
  taskId: TaskId,
): Promise<ReaderContext> {
  const [divides, declared, task, inboundDivide, inboundDeclared] = await Promise.all([
    capabilityDivides(db, taskId),
    latestDeclaredCapabilities(db, agentId),
    db.select({ kind: tasks.kind }).from(tasks).where(eq(tasks.id, taskId)).limit(1),
    inboundRouteDivide(db, taskId),
    latestDeclaredInboundRoute(db, agentId),
  ])

  return {
    divides,
    declared,
    movesMoney: task[0]?.kind === 'quest',
    inboundDivide,
    inboundDeclared,
  }
}

/**
 * The wall the Colony names when it asks a passing citizen how it got through
 * (#58).
 *
 * **A claim, not an entry**, which is what makes it safe to put in a question
 * addressed to somebody else: the text is the Colony's own, written from the
 * corpus rather than quoted out of it. Naming a struggle row here would be the
 * 2026-07-30 incident again, in a new place.
 *
 * Most-reported first, because that is the one *"did you get past that?"* is
 * worth asking about — a wall one agent hit is a question for that agent.
 *
 * **Demoted claims are not named.** A claim nobody has confirmed lately (#113)
 * may describe a wall the provider has since taken down, and asking a citizen
 * whether it got past something that is no longer there wastes the one sentence
 * this programme gets from it.
 */
export async function mostReportedWall(db: Database, taskId: TaskId): Promise<NamedWall | null> {
  const briefing = await readBriefing(db, taskId)
  if (briefing === undefined) return null

  const walls = briefing.claims
    .filter((claim) => claim.section === 'wall' && claim.current)
    .sort((left, right) => right.reports - left.reports)

  const wall = walls[0]
  return wall === undefined ? null : { text: wall.text, reports: wall.reports }
}

/**
 * Whether the outside world appears to have moved under this task, and the
 * evidence for it (#115).
 *
 * **The detector already exists and is doing this work for another purpose.**
 * The dedup stage answers, per entry, *is this a restatement of something
 * already reported, or something new?* Today that answer merges duplicates and
 * raises a confirmation count. Read at the level of a task it is a change
 * detector: a task that has been stable, suddenly collecting several reports the
 * dedup stage calls distinct, is a task whose provider changed. No new model
 * call, no new classifier — a query over verdicts the pipeline already writes.
 *
 * **It counts distinct agents, not rows**, which is the one thing that would
 * have made it wrong. Since #110 an agent can hold several reports on a task, and
 * three reports from one agent stuck on the same wall across three attempts are
 * not a provider change — they are one agent's bad week. The merge path counts
 * agents for exactly this reason and so does this.
 *
 * **A new task cannot trigger it.** Everything on a task nobody has reported on
 * is distinct by definition, so the stability precondition has to be real: the
 * task needs {@link CHANGE_STABILITY_ATTEMPTS} closed attempts behind it before
 * a cluster means anything at all.
 *
 * **A cooldown, because a provider change produces reports for days.** The
 * Colony should conclude it once; `change_detected_at` is both the anchor for
 * that and the demotion line the conclusion draws.
 */
export interface ProviderChange {
  readonly taskId: TaskId
  /** Distinct agents whose reports the dedup stage judged new, inside the window. */
  readonly reporters: number
  readonly windowHours: number
  /**
   * What a window on this task ordinarily carries, from its own history.
   * Zero when it has none to speak of. See {@link CHANGE_CLUSTER_MULTIPLE}.
   */
  readonly baseline: number
  /** The count this cluster had to beat, after the baseline was taken into account. */
  readonly required: number
}

/**
 * The floor: how many distinct agents must independently report something new
 * before the Colony will look at a cluster at all.
 *
 * **Three in 48 hours on a task with at least twenty closed attempts.** Two
 * would fire on a pair of agents hitting an ordinary intermittent failure; four
 * would wait through most of a day of agents walking into a wall that is already
 * known.
 *
 * **It is a floor and no longer the whole test** (`#598`). Three was stated as a
 * starting position and the first false positive argued with it exactly as
 * intended: the `raster` rung was collecting about two reports a day from the
 * day it went active, so three distinct citizens in 48 hours was that rung's
 * ordinary Tuesday and the tripwire fired on its own baseline. An absolute
 * threshold is wrong in both directions — it fires forever on a busy rung, and a
 * quiet rung that suddenly doubles never reaches it. So the cluster is measured
 * against the task's own rate as well; see {@link CHANGE_CLUSTER_MULTIPLE}.
 */
export const CHANGE_DISTINCT_REPORTERS = 3

/** The window those reporters must fall inside. See {@link CHANGE_DISTINCT_REPORTERS}. */
export const CHANGE_WINDOW_HOURS = 48

/**
 * How much history a task needs before a cluster on it means anything.
 *
 * The stability precondition, and it has to be real: a detector that fires on
 * every new task is a detector nobody reads. Twenty closed attempts is enough
 * that *this task used to work* is a statement about evidence.
 */
export const CHANGE_STABILITY_ATTEMPTS = 20

/**
 * How many times its own ordinary window a cluster must be before it counts as
 * a change (`#598`).
 *
 * The baseline is the average number of distinct citizens a window has carried
 * on this task, measured over {@link CHANGE_BASELINE_DAYS} of its own history
 * up to the window's edge. Double that, or the floor, whichever is larger.
 *
 * **Doubling rather than a percentage above it**, because the counts are small.
 * A rung averaging four reporters a window trips at eight, which is a fortnight
 * of its traffic arriving in two days; a rung averaging one still trips at the
 * floor of three. Anything finer than a multiple would be reading noise.
 */
export const CHANGE_CLUSTER_MULTIPLE = 2

/**
 * How far back the task's own rate is measured, ending where the window begins.
 *
 * Four weeks is long enough that a fortnight of quiet does not read as the
 * normal rate, and short enough that a rung's traffic from before its last
 * rewrite does not defend it forever.
 */
export const CHANGE_BASELINE_DAYS = 28

/**
 * How much history the baseline needs before it is allowed to raise the bar.
 *
 * Two windows, so a rung four days into its life is judged on the floor alone.
 * **A short history reads as a low baseline, which is the dangerous direction**:
 * without this, a task with a single report behind it would look quieter than it
 * is and the floor would be all that stood there anyway — but stating the
 * minimum keeps that an intention rather than an accident of the arithmetic.
 */
export const CHANGE_BASELINE_MIN_WINDOWS = 2

/**
 * How long after concluding a change the Colony stays quiet about that task.
 *
 * Longer than the detection window on purpose. A change that is still producing
 * distinct reports on day three is the same change, and the second conclusion
 * would say nothing the first did not.
 */
export const CHANGE_COOLDOWN_HOURS = 24 * 14

/**
 * Look for a provider change on one task.
 *
 * Returns `null` far more often than not, which is the intended shape: this runs
 * after moderation on whichever task was just judged, so its cost is one query
 * per judged report and its answer is almost always *no*.
 *
 * **The baseline query only runs once the floor is cleared** (`#598`), so the
 * ordinary path is still the two queries it always was.
 */
export async function detectProviderChange(
  db: Database,
  taskId: TaskId,
): Promise<ProviderChange | null> {
  const [cooldown] = await db
    .select({ changeDetectedAt: taskBriefings.changeDetectedAt })
    .from(taskBriefings)
    .where(eq(taskBriefings.taskId, taskId))
    .limit(1)

  if (cooldown?.changeDetectedAt != null) {
    const hours = (Date.now() - Date.parse(toTimestamp(cooldown.changeDetectedAt))) / 3_600_000
    if (hours < CHANGE_COOLDOWN_HOURS) return null
  }

  const [stability] = await db
    .select({ closed: sql<number>`count(*)::int` })
    .from(taskAttempts)
    .where(and(eq(taskAttempts.taskId, taskId), sql`${taskAttempts.outcome} is not null`))

  if (Number(stability?.closed ?? 0) < CHANGE_STABILITY_ATTEMPTS) return null

  /**
   * `approved` is what *distinct* means here.
   *
   * The dedup stage merges a restatement and approves something new, so an
   * approved row inside the window is precisely an entry it judged it had not
   * seen before. Reading the stage's own verdict out of `moderations` would say
   * the same thing one join further away and would miss an entry approved before
   * the stage existed.
   */
  /**
   * **Attempt-less reports count too** (#169). Several citizens saying in one
   * window that a rung cannot be *started* is a provider change by any reading —
   * and it is the sharpest version of the signal this tripwire exists to detect,
   * because it is the one where nobody even got far enough to be uncertain about
   * the cause. The inner join here excluded them for the same accidental reason
   * it excluded them from the corpus.
   */
  const reporter = sql`coalesce(${taskAttempts.agentId}, ${taskReports.agentId})`
  const approvedOnThisTask = and(
    sql`coalesce(${taskAttempts.taskId}, ${taskReports.taskId}) = ${taskId}`,
    eq(taskReports.status, 'approved'),
    eq(agents.type, 'citizen'),
  )
  const windowStart = sql`now() - make_interval(hours => ${CHANGE_WINDOW_HOURS})`

  const [cluster] = await db
    .select({ reporters: sql<number>`count(distinct ${reporter})::int` })
    .from(taskReports)
    .leftJoin(taskAttempts, eq(taskAttempts.id, taskReports.attemptId))
    .innerJoin(agents, sql`${agents.id} = ${reporter}`)
    .where(and(approvedOnThisTask, sql`${taskReports.createdAt} >= ${windowStart}`))

  const reporters = Number(cluster?.reporters ?? 0)
  if (reporters < CHANGE_DISTINCT_REPORTERS) return null

  /**
   * The same count, window by window, over the task's own recent history —
   * bucket 0 being the window before this one (`#598`).
   *
   * **The buckets are counted separately and then averaged, rather than counting
   * distinct agents across the whole month.** An agent that comes back every
   * week is one agent over a month and one reporter in each of four windows, and
   * it is the second reading the threshold is in: what the tripwire compares is
   * *how many distinct citizens a window carries*, so the baseline has to be
   * that same quantity or the two are not comparable.
   */
  const bucket = sql<number>`floor(
    extract(epoch from ${windowStart} - ${taskReports.createdAt})
    / ${CHANGE_WINDOW_HOURS * 3600}::double precision
  )::int`

  const history = await db
    .select({ bucket, reporters: sql<number>`count(distinct ${reporter})::int` })
    .from(taskReports)
    .leftJoin(taskAttempts, eq(taskAttempts.id, taskReports.attemptId))
    .innerJoin(agents, sql`${agents.id} = ${reporter}`)
    .where(
      and(
        approvedOnThisTask,
        sql`${taskReports.createdAt} < ${windowStart}`,
        sql`${taskReports.createdAt} >= now() - make_interval(days => ${CHANGE_BASELINE_DAYS})`,
      ),
    )
    // By ordinal, because the same expression written twice carries different
    // placeholders and Postgres will not match one against the other.
    .groupBy(sql`1`)

  /**
   * Windows are counted from the oldest report rather than from the start of the
   * baseline period, so a rung that went active nine days ago is measured
   * against nine days and not against four weeks that are mostly empty. Empty
   * windows *inside* that span still count — a quiet stretch is part of the rate.
   */
  const windows = history.reduce((widest, row) => Math.max(widest, Number(row.bucket) + 1), 0)
  const observed = history.reduce((total, row) => total + Number(row.reporters), 0)
  const baseline = windows === 0 ? 0 : observed / windows

  const required =
    windows >= CHANGE_BASELINE_MIN_WINDOWS
      ? Math.max(CHANGE_DISTINCT_REPORTERS, Math.ceil(baseline * CHANGE_CLUSTER_MULTIPLE))
      : CHANGE_DISTINCT_REPORTERS

  if (reporters < required) return null

  return {
    taskId,
    reporters,
    windowHours: CHANGE_WINDOW_HOURS,
    baseline: Math.round(baseline * 10) / 10,
    required,
  }
}

/**
 * Record that the Colony has concluded the world moved under this task.
 *
 * **One write does three things**, and they are one fact rather than three: it
 * demotes every claim not confirmed since, it starts the cooldown, and it marks
 * the briefing stale so the immediate re-synthesis has something to consume.
 * Nothing is deleted — a demoted claim stays readable with its age visible, and a
 * later report confirming it moves its `lastSupportedAt` past this line and
 * brings it back.
 */
export async function recordProviderChange(db: Database, taskId: TaskId): Promise<void> {
  const at = new Date().toISOString()

  await db
    .insert(taskBriefings)
    .values({ taskId, changeDetectedAt: at })
    .onConflictDoUpdate({
      target: taskBriefings.taskId,
      set: { changeDetectedAt: at, dirty: true },
    })
}

/** One task nobody has reported on, with how often it has been attempted. */
export interface TaskWithoutReports {
  readonly taskId: TaskId
  readonly title: string
  /** Attempts closed against it, whatever the outcome. */
  readonly attempts: number
}

/**
 * The tasks the Colony knows nothing about, with the attempt count beside them
 * (`#611`).
 *
 * **This is the figure the twelve empty briefings were standing in for**, and it
 * is the more actionable form of the same fact: *forty briefings* reads as
 * coverage, *twelve tasks have no reports* says where to point the next agent.
 *
 * **The attempt count is what makes the list readable**, and `#611` names the
 * reason: three of the twelve are the *is it still yours* re-tests, and a task
 * with no reports may be one nobody has attempted or one nobody ever struggles
 * with. Those need opposite responses and the count is what tells them apart.
 *
 * Academy tasks only. A quest carries its own reports through a different
 * surface, and mixing them would make the count answer two questions.
 */
export async function tasksWithoutReports(db: Database): Promise<readonly TaskWithoutReports[]> {
  const rows = await db
    .select({
      taskId: tasks.id,
      title: tasks.title,
      attempts: sql<number>`count(distinct ${taskAttempts.id})::int`,
    })
    .from(tasks)
    .leftJoin(taskAttempts, eq(taskAttempts.taskId, tasks.id))
    .where(
      and(
        eq(tasks.kind, 'academy'),
        /**
         * **A report reaches its task through its attempt**, and only falls back
         * to its own column when it has none — which is exactly what
         * `briefingCorpus` does one function up. Matching on `task_reports.task_id`
         * alone reports a task as unreported while agents are filing on it,
         * because the ordinary report is attached to an attempt.
         */
        sql`not exists (
          select 1
          from ${taskReports}
          left join ${taskAttempts} on ${taskAttempts.id} = ${taskReports.attemptId}
          where coalesce(${taskAttempts.taskId}, ${taskReports.taskId}) = ${tasks.id}
        )`,
      ),
    )
    .groupBy(tasks.id, tasks.title)
    .orderBy(desc(sql`count(distinct ${taskAttempts.id})`), asc(tasks.title))

  return rows.map((row) => ({
    taskId: row.taskId as TaskId,
    title: row.title,
    attempts: row.attempts,
  }))
}
