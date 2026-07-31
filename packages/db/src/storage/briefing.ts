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
  type ReportKind,
  type TaskBriefing,
  type TaskId,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { taskAttempts, taskBriefings, taskReports, tasks } from '../schema/index.js'
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
      outcome: taskAttempts.outcome,
      did: taskReports.did,
      broke: taskReports.broke,
      changed: taskReports.changed,
      reports: taskReports.confirmations,
      platforms: reportPlatforms,
      lastSupportedAt: reportLastSupported,
    })
    .from(taskReports)
    .innerJoin(taskAttempts, eq(taskAttempts.id, taskReports.attemptId))
    .where(
      and(
        eq(taskAttempts.taskId, taskId),
        eq(taskReports.status, 'approved'),
        sql`${taskAttempts.outcome} is not null`,
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
    kind: reportKindFor(row.outcome) as ReportKind,
    content: reportNarrativeText({ did: row.did, broke: row.broke, changed: row.changed }),
    reports: row.reports,
    platforms: row.platforms as Readonly<Partial<Record<AgentPlatform, number>>>,
    lastSupportedAt: toTimestamp(row.lastSupportedAt),
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
 */
const reportPlatforms = sql<Record<string, number>>`(
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
    })
    .from(taskBriefings)
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
  const [row] = await db
    .select({ title: tasks.title })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)

  return row?.title
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
 * Quest pays coins — `governance/economy.md` §2 is absolute that no coin is ever
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
