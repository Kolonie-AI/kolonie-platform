import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  CURRENT_CLAIM_ATTEMPTS,
  RECENT_REPORTS_IN_CONTEXT,
  now as currentTime,
  TaskBriefingSchema,
  isCurrentClaim,
  reportKindFor,
  reportNarrativeText,
  type AgentId,
  type AgentPlatform,
  type BriefingClaim,
  type CapabilityDivide,
  type CapabilityFlag,
  type NamedWall,
  type ReportKind,
  type TaskBriefing,
  type TaskId,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { agents, taskAttempts, taskBriefings, taskReports, tasks } from '../schema/index.js'
import { capabilityDivides, latestDeclaredCapabilities } from './attempts.js'
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
    content: reportNarrativeText({ did: row.did, broke: row.broke, changed: row.changed }),
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
export async function writeBriefing(
  db: Database,
  input: {
    readonly taskId: TaskId
    readonly claims: readonly BriefingClaim[]
    readonly model: string
  },
): Promise<void> {
  const at = new Date().toISOString()

  await db
    .insert(taskBriefings)
    .values({
      taskId: input.taskId,
      claims: [...input.claims],
      model: input.model,
      writtenAt: at,
      dirty: false,
    })
    .onConflictDoUpdate({
      target: taskBriefings.taskId,
      set: { claims: [...input.claims], model: input.model, writtenAt: at, dirty: false },
    })
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
     * The demotion line, which two events can draw (#115, #182).
     *
     * It overrides both recency bounds, because either one is positive evidence
     * rather than silence: a wall the provider has taken down should leave the
     * foreground now, not in ninety days.
     *
     * **The later of the two, because both are that same kind of evidence and
     * the more recent one is the one still true.** A provider change is the
     * world moving under the claims; a text revision is the Colony moving it.
     * Taking the later means a task whose wording changed after a detected
     * change is measured from the wording, which is the state a reader is
     * actually in.
     */
    changeDetectedAt: laterOf(row.changeDetectedAt, row.textRevisedAt),
  }

  return TaskBriefingSchema.parse({
    taskId: row.taskId,
    claims: row.claims.map((claim) => ({ ...claim, current: isCurrentClaim(claim, window) })),
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
}

export async function readerContext(
  db: Database,
  agentId: AgentId,
  taskId: TaskId,
): Promise<ReaderContext> {
  const [divides, declared, task] = await Promise.all([
    capabilityDivides(db, taskId),
    latestDeclaredCapabilities(db, agentId),
    db.select({ kind: tasks.kind }).from(tasks).where(eq(tasks.id, taskId)).limit(1),
  ])

  return { divides, declared, movesMoney: task[0]?.kind === 'quest' }
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
}

/**
 * How many distinct agents must independently report something new before the
 * Colony concludes the world moved.
 *
 * **Three in 48 hours on a task with at least twenty closed attempts.** A
 * reasonable starting position and not a measurement — said out loud here so the
 * first false positive is an argument against a stated number rather than a
 * mystery. Two would fire on a pair of agents hitting an ordinary intermittent
 * failure; four would wait through most of a day of agents walking into a wall
 * that is already known.
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
  const [cluster] = await db
    .select({
      reporters: sql<number>`count(distinct coalesce(${taskAttempts.agentId}, ${taskReports.agentId}))::int`,
    })
    .from(taskReports)
    .leftJoin(taskAttempts, eq(taskAttempts.id, taskReports.attemptId))
    .innerJoin(
      agents,
      sql`${agents.id} = coalesce(${taskAttempts.agentId}, ${taskReports.agentId})`,
    )
    .where(
      and(
        sql`coalesce(${taskAttempts.taskId}, ${taskReports.taskId}) = ${taskId}`,
        eq(taskReports.status, 'approved'),
        eq(agents.type, 'citizen'),
        sql`${taskReports.createdAt} >= now() - make_interval(hours => ${CHANGE_WINDOW_HOURS})`,
      ),
    )

  const reporters = Number(cluster?.reporters ?? 0)
  if (reporters < CHANGE_DISTINCT_REPORTERS) return null

  return { taskId, reporters, windowHours: CHANGE_WINDOW_HOURS }
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
