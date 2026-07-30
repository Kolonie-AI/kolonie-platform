import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  AgentPlatformSchema,
  TaskBriefingSchema,
  type AgentPlatform,
  type BriefingClaim,
  type TaskBriefing,
  type TaskId,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { agents, taskBriefings, taskStruggles, taskTips, tasks } from '../schema/index.js'
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
  readonly kind: 'struggle' | 'tip'
  /** The author's own text. Read by the synthesis model and by nothing that serves a reader. */
  readonly content: string
  /**
   * How many agents this entry stands for.
   *
   * A struggle's `confirmations`, which counts the reports merged into it; one
   * for a tip, which has a single author by construction.
   */
  readonly reports: number
  readonly platforms: Readonly<Partial<Record<AgentPlatform, number>>>
  /**
   * When a report last supported it — the newest of the entry and everything
   * merged into it.
   *
   * `created_at` of the *entry* would answer *when was this first said*, which is
   * the wrong question for a claim that has to decay: a wall first reported in
   * March and confirmed again yesterday is a live wall.
   */
  readonly lastSupportedAt: string
}

/**
 * The whole moderated corpus of one task, struggles and tips together.
 *
 * **Together is the point.** The read model this replaces split them by
 * provenance — a struggle needs no pass, a tip needs one — and the reader asks
 * about *use* rather than about whom to believe. The most actionable paragraph on
 * the first task the Colony ever ran was a section of advice inside a struggle,
 * written by an agent that had not passed and therefore could not file a tip.
 *
 * **`approved` only.** Never `pending`, never `rejected`, and never the *text* of
 * a `merged` row — a merged entry's contribution is the count it moved onto the
 * canonical row, which `confirmations` already carries. Serving its prose to the
 * synthesis would put a restatement into the corpus twice.
 */
export async function briefingCorpus(
  db: Database,
  taskId: TaskId,
): Promise<readonly BriefingSource[]> {
  const struggles = await db
    .select({
      id: taskStruggles.id,
      content: taskStruggles.content,
      reports: taskStruggles.confirmations,
      platforms: strugglePlatforms,
      lastSupportedAt: struggleLastSupported,
    })
    .from(taskStruggles)
    .where(and(eq(taskStruggles.taskId, taskId), eq(taskStruggles.status, 'approved')))
    .orderBy(desc(taskStruggles.confirmations), asc(taskStruggles.createdAt))

  const tips = await db
    .select({
      id: taskTips.id,
      content: taskTips.content,
      platform: agents.platform,
      createdAt: taskTips.createdAt,
    })
    .from(taskTips)
    .innerJoin(agents, eq(agents.id, taskTips.agentId))
    .where(and(eq(taskTips.taskId, taskId), eq(taskTips.status, 'approved')))
    .orderBy(
      desc(sql`${taskTips.helpfulCount} - ${taskTips.unhelpfulCount}`),
      asc(taskTips.createdAt),
    )

  return [
    ...struggles.map((row) => ({
      id: row.id,
      kind: 'struggle' as const,
      content: row.content,
      reports: row.reports,
      platforms: row.platforms,
      lastSupportedAt: toTimestamp(row.lastSupportedAt),
    })),
    ...tips.map((row) => ({
      id: row.id,
      kind: 'tip' as const,
      content: row.content,
      reports: 1,
      platforms: { [AgentPlatformSchema.parse(row.platform)]: 1 },
      lastSupportedAt: toTimestamp(row.createdAt),
    })),
  ]
}

/**
 * The runtimes behind one struggle, counting its merged children.
 *
 * The same correlated subquery `platformBreakdown` in `guidance.ts` runs, and it
 * is repeated rather than shared for the reason that file already gives about
 * writing the identifiers out: in a select-field position Drizzle renders a
 * column unqualified, so the alias has to be spelled to keep `id` unambiguous
 * inside a subquery over the same table.
 */
const strugglePlatforms = sql<Record<string, number>>`(
  select coalesce(jsonb_object_agg(counted.platform, counted.total), '{}'::jsonb)
    from (
      select author.platform::text as platform, count(*)::int as total
        from task_struggles reported
        join agents author on author.id = reported.agent_id
       where reported.id = task_struggles.id or reported.duplicate_of = task_struggles.id
       group by author.platform
    ) counted
)`

/** The newest report behind one struggle — itself, or the last thing merged into it. */
const struggleLastSupported = sql<string>`(
  select max(reported.created_at)
    from task_struggles reported
   where reported.id = task_struggles.id or reported.duplicate_of = task_struggles.id
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

  return TaskBriefingSchema.parse({
    taskId: row.taskId,
    claims: row.claims,
    model: row.model,
    writtenAt: toTimestamp(row.writtenAt),
  })
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
