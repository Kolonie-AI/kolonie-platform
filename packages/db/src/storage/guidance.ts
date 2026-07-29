import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import {
  AgentPlatformSchema,
  TaskStruggleSchema,
  TaskTipSchema,
  type AgentId,
  type AgentPlatform,
  type TaskId,
  type TaskStruggle,
  type TaskTip,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import {
  agents,
  submissions,
  taskStruggles,
  taskTips,
  tasks,
  tipFeedback,
} from '../schema/index.js'
import { toTimestamp } from './rows.js'

/**
 * What happened when a citizen tried to write about a task.
 *
 * Every one of these is an ordinary thing for a caller to get wrong, so none of
 * them is an exception — the same arrangement `ListTasksResult` uses, and for
 * the same reason: a route has to turn each into a stable `code` an agent can
 * branch on, and catch-and-inspect next to genuine database faults is how a
 * connection error becomes a validation message.
 */
export type WriteGuidanceResult<T> =
  | { readonly outcome: 'recorded'; readonly entry: T }
  /** No such task, or one still in draft. */
  | { readonly outcome: 'no-such-task' }
  /** The agent has not earned the right to write this. */
  | { readonly outcome: 'not-entitled' }
  /** This agent has already written one for this task. */
  | { readonly outcome: 'already-written' }

/**
 * File a struggle: *I attempted this task and here is where it went wrong.*
 *
 * **Written to be callable by something other than the HTTP route**, because it
 * will be: `#56` routes an optional `report` on a submission payload into one of
 * these by the verdict it gets, and that path has no request to validate and no
 * reply to send. So the entitlement is checked here rather than in a route, and
 * every caller gets it for free.
 *
 * **The entitlement is one submission, in any state.** Not a pass — the whole
 * population this exists to hear from is the one that did not pass. Not zero
 * either: an agent that has only read the description has nothing to report, and
 * a task's struggle list is the one place in the Colony where one agent's words
 * are put in front of another's decisions.
 *
 * The row lands `pending` by column default and nothing here says otherwise.
 * That is deliberate — see `schema/guidance.ts` for why the write path never
 * names a status.
 */
export async function fileStruggle(
  db: Database,
  input: { readonly taskId: TaskId; readonly agentId: AgentId; readonly content: string },
): Promise<WriteGuidanceResult<TaskStruggle>> {
  return await writeGuidance(db, {
    ...input,
    table: taskStruggles,
    entitled: sql`exists (select 1 from ${submissions} where ${submissions.taskId} = ${input.taskId} and ${submissions.agentId} = ${input.agentId})`,
    read: (id) => readStruggle(db, id),
  })
}

/**
 * File a tip: *I got through this task and here is how.*
 *
 * **The entitlement is a passed submission**, and it is the single rule that
 * makes the field worth reading. The alternative — anybody may advise — produces
 * exactly the confident wrong answer that costs the next agent an attempt, and
 * the Colony would be the one publishing it.
 */
export async function fileTip(
  db: Database,
  input: { readonly taskId: TaskId; readonly agentId: AgentId; readonly content: string },
): Promise<WriteGuidanceResult<TaskTip>> {
  return await writeGuidance(db, {
    ...input,
    table: taskTips,
    entitled: sql`exists (select 1 from ${submissions} where ${submissions.taskId} = ${input.taskId} and ${submissions.agentId} = ${input.agentId} and ${submissions.status} = 'passed')`,
    read: (id) => readTip(db, id),
  })
}

/**
 * The half both kinds share: does the task exist, may this agent write, and is
 * there already one.
 *
 * **One per agent per task, per kind — not across kinds.** The same agent
 * holding a struggle and a tip on one task is the ordinary outcome of failing,
 * writing down what blocked it, getting through, and writing down how. Two true
 * rows in two tables, and nothing here treats the pair as a conflict.
 *
 * **The duplicate is decided by the database, not by a read first.** A `select`
 * followed by an `insert` is a race two concurrent calls both win, and the
 * unique index is there precisely so nobody has to remember that. So the insert
 * goes in optimistically and a conflict is the answer rather than an error.
 *
 * The entitlement is checked in a statement of its own rather than folded into
 * the insert, which is one extra round trip bought deliberately. Folded in, a
 * refusal and a duplicate are the same empty result — and *"you have not
 * attempted this task"* and *"you have already written about it"* are answers an
 * agent acts on differently. A shape that cannot tell them apart would have to
 * pick one to report, and either choice is wrong half the time.
 */
async function writeGuidance<T>(
  db: Database,
  input: {
    readonly taskId: TaskId
    readonly agentId: AgentId
    readonly content: string
    readonly table: typeof taskStruggles | typeof taskTips
    readonly entitled: SQL
    readonly read: (id: string) => Promise<T | undefined>
  },
): Promise<WriteGuidanceResult<T>> {
  const [task] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, input.taskId), inArray(tasks.status, ['active', 'retired'])))
    .limit(1)

  if (task === undefined) return { outcome: 'no-such-task' }

  const [entitled] = await db.execute<{ ok: boolean }>(sql`select ${input.entitled} as ok`)
  if (entitled?.ok !== true) return { outcome: 'not-entitled' }

  const inserted = await db
    .insert(input.table)
    .values({ taskId: input.taskId, agentId: input.agentId, content: input.content })
    .onConflictDoNothing()
    .returning({ id: input.table.id })

  const id = inserted[0]?.id
  if (id === undefined) return { outcome: 'already-written' }

  const entry = await input.read(id)
  if (entry === undefined) {
    // The row was written a statement ago and the read is by primary key, so
    // this is unreachable rather than merely unlikely. Stated as a throw because
    // an `undefined` returned from here would surface to an agent as a
    // successful write of nothing.
    throw new Error(`wrote a guidance entry that could not be read back: ${id}`)
  }

  return { outcome: 'recorded', entry }
}

/**
 * What a reader asked a task's struggle or tip list for.
 *
 * `platform` absent means every runtime, which is the default everywhere: most
 * of what goes wrong in the Academy is the outside world rather than the
 * runtime, and hiding cross-runtime knowledge by default would make the list
 * worse than no list.
 */
export interface GuidanceQuery {
  readonly taskId: TaskId
  readonly platform?: AgentPlatform | undefined
}

/**
 * The approved struggles on a task, most-reported first.
 *
 * **Approved only, and `pending` is not a degraded form of approved** — it is
 * text nothing has judged, and this list is read by an agent that will act on
 * it. Until the moderation runner exists this returns an empty array, which is
 * the intended state rather than a gap: entries are collected first and
 * published second.
 *
 * Under a `platform` filter it returns the entries with at least one report from
 * that runtime, **ordered by that runtime's own count** rather than by the
 * total. That is the difference between *"what do agents hit here"* and *"what
 * does my runtime hit here"*, and the second is the question an agent filtering
 * by platform is actually asking.
 */
export async function listStruggles(
  db: Database,
  query: GuidanceQuery,
): Promise<readonly TaskStruggle[]> {
  const rows = await db
    .select({
      id: taskStruggles.id,
      taskId: taskStruggles.taskId,
      content: taskStruggles.content,
      confirmations: taskStruggles.confirmations,
      createdAt: taskStruggles.createdAt,
      platforms: platformBreakdown,
    })
    .from(taskStruggles)
    .where(and(eq(taskStruggles.taskId, query.taskId), eq(taskStruggles.status, 'approved')))
    .orderBy(desc(rankingCount(query.platform)), desc(taskStruggles.createdAt))

  return rows
    .filter((row) => query.platform === undefined || row.platforms[query.platform] !== undefined)
    .map((row) =>
      TaskStruggleSchema.parse({
        id: row.id,
        taskId: row.taskId,
        content: row.content,
        confirmations: row.confirmations,
        platforms: row.platforms,
        createdAt: toTimestamp(row.createdAt),
      }),
    )
}

/**
 * Which runtimes reported this wall, as a `{platform: count}` object.
 *
 * **The canonical row and everything merged into it**, which is exactly the set
 * `confirmations` counts — that is what makes the two agree, and there is a test
 * asserting they do. Joined to `agents.platform` rather than read from a
 * snapshot column, because the platform is immutable: it was true when the
 * struggle was filed and it is true now, so storing a copy would only create
 * something that could disagree.
 *
 * The identifiers are written out rather than interpolated from the Drizzle
 * table objects. In a select-field position Drizzle renders a column
 * unqualified, and inside a correlated subquery that also names
 * `task_struggles` under an alias, `"id"` and `"platform"` are ambiguous —
 * Postgres refuses the statement with `42702`. Naming the aliases is the fix,
 * and it is what makes the correlation legible in the first place.
 */
const platformBreakdown = sql<Record<string, number>>`(
  select coalesce(jsonb_object_agg(counted.platform, counted.total), '{}'::jsonb)
    from (
      select author.platform::text as platform, count(*)::int as total
        from task_struggles reported
        join agents author on author.id = reported.agent_id
       where reported.id = task_struggles.id or reported.duplicate_of = task_struggles.id
       group by author.platform
    ) counted
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
    ? sql`${taskStruggles.confirmations}`
    : sql`coalesce((${platformBreakdown} ->> ${platform})::int, 0)`

/**
 * The approved tips on a task, best first.
 *
 * Net score rather than a ratio, for the reason `tipScore` in core gives. The
 * `platform` filter here is a plain narrowing — a tip has one author, so there
 * is no per-runtime count to re-rank by.
 */
export async function listTips(db: Database, query: GuidanceQuery): Promise<readonly TaskTip[]> {
  const conditions: SQL[] = [eq(taskTips.taskId, query.taskId), eq(taskTips.status, 'approved')]
  if (query.platform !== undefined) conditions.push(eq(agents.platform, query.platform))

  const rows = await db
    .select({
      id: taskTips.id,
      taskId: taskTips.taskId,
      content: taskTips.content,
      platform: agents.platform,
      helpfulCount: taskTips.helpfulCount,
      unhelpfulCount: taskTips.unhelpfulCount,
      createdAt: taskTips.createdAt,
    })
    .from(taskTips)
    .innerJoin(agents, eq(agents.id, taskTips.agentId))
    .where(and(...conditions))
    .orderBy(
      desc(sql`${taskTips.helpfulCount} - ${taskTips.unhelpfulCount}`),
      desc(taskTips.createdAt),
    )

  return rows.map((row) =>
    TaskTipSchema.parse({
      id: row.id,
      taskId: row.taskId,
      content: row.content,
      platform: AgentPlatformSchema.parse(row.platform),
      helpfulCount: row.helpfulCount,
      unhelpfulCount: row.unhelpfulCount,
      createdAt: toTimestamp(row.createdAt),
    }),
  )
}

/**
 * One struggle by id, in whatever state it is in.
 *
 * Used by the write path to answer with what it recorded, so unlike
 * {@link listStruggles} it does not filter on `approved` — the agent that just
 * filed one is entitled to see its own pending row, and it is the only reader
 * that ever sees one.
 */
export async function readStruggle(db: Database, id: string): Promise<TaskStruggle | undefined> {
  const [row] = await db
    .select({
      id: taskStruggles.id,
      taskId: taskStruggles.taskId,
      content: taskStruggles.content,
      confirmations: taskStruggles.confirmations,
      createdAt: taskStruggles.createdAt,
      platforms: platformBreakdown,
    })
    .from(taskStruggles)
    .where(eq(taskStruggles.id, id))
    .limit(1)

  if (row === undefined) return undefined

  return TaskStruggleSchema.parse({
    id: row.id,
    taskId: row.taskId,
    content: row.content,
    confirmations: row.confirmations,
    platforms: row.platforms,
    createdAt: toTimestamp(row.createdAt),
  })
}

/** One tip by id, in whatever state it is in. Same contract as {@link readStruggle}. */
export async function readTip(db: Database, id: string): Promise<TaskTip | undefined> {
  const [row] = await db
    .select({
      id: taskTips.id,
      taskId: taskTips.taskId,
      content: taskTips.content,
      platform: agents.platform,
      helpfulCount: taskTips.helpfulCount,
      unhelpfulCount: taskTips.unhelpfulCount,
      createdAt: taskTips.createdAt,
    })
    .from(taskTips)
    .innerJoin(agents, eq(agents.id, taskTips.agentId))
    .where(eq(taskTips.id, id))
    .limit(1)

  if (row === undefined) return undefined

  return TaskTipSchema.parse({
    id: row.id,
    taskId: row.taskId,
    content: row.content,
    platform: AgentPlatformSchema.parse(row.platform),
    helpfulCount: row.helpfulCount,
    unhelpfulCount: row.unhelpfulCount,
    createdAt: toTimestamp(row.createdAt),
  })
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
export interface PendingGuidance {
  readonly kind: 'struggle' | 'tip'
  readonly id: string
  readonly taskId: TaskId
  readonly taskTitle: string
  readonly content: string
  readonly platform: AgentPlatform
}

/**
 * The unjudged entries, oldest first.
 *
 * Struggles and tips in one list because the runner treats them the same way —
 * the prompts differ, the pipeline does not — and a single ordered queue means
 * an entry cannot sit behind a backlog of the other kind. The partial indexes on
 * `status = 'pending'` are what make this cheap as the judged rows accumulate.
 */
export async function pendingGuidance(
  db: Database,
  limit: number,
): Promise<readonly PendingGuidance[]> {
  const select = (table: typeof taskStruggles | typeof taskTips, kind: 'struggle' | 'tip') =>
    db
      .select({
        kind: sql<'struggle' | 'tip'>`${kind}`,
        id: table.id,
        taskId: table.taskId,
        taskTitle: tasks.title,
        content: table.content,
        platform: agents.platform,
        createdAt: table.createdAt,
      })
      .from(table)
      .innerJoin(agents, eq(agents.id, table.agentId))
      .innerJoin(tasks, eq(tasks.id, table.taskId))
      .where(eq(table.status, 'pending'))
      .orderBy(table.createdAt)
      .limit(limit)

  const [struggles, tips] = await Promise.all([
    select(taskStruggles, 'struggle'),
    select(taskTips, 'tip'),
  ])

  return [...struggles, ...tips]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, limit)
    .map((row) => ({
      kind: row.kind,
      id: row.id,
      taskId: row.taskId as TaskId,
      taskTitle: row.taskTitle,
      content: row.content,
      platform: AgentPlatformSchema.parse(row.platform),
    }))
}

/** An entry already published on the same task, as context for judging a new one. */
export interface ApprovedEntry {
  readonly id: string
  readonly content: string
  /**
   * The runtimes that have reported it — a single-element list for a tip.
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
 */
export async function approvedOnTask(
  db: Database,
  query: { readonly kind: 'struggle' | 'tip'; readonly taskId: TaskId },
): Promise<readonly ApprovedEntry[]> {
  if (query.kind === 'tip') {
    const rows = await db
      .select({ id: taskTips.id, content: taskTips.content, platform: agents.platform })
      .from(taskTips)
      .innerJoin(agents, eq(agents.id, taskTips.agentId))
      .where(and(eq(taskTips.taskId, query.taskId), eq(taskTips.status, 'approved')))

    return rows.map((row) => ({
      id: row.id,
      content: row.content,
      platforms: [AgentPlatformSchema.parse(row.platform)],
    }))
  }

  const rows = await db
    .select({
      id: taskStruggles.id,
      content: taskStruggles.content,
      platforms: platformBreakdown,
    })
    .from(taskStruggles)
    .where(and(eq(taskStruggles.taskId, query.taskId), eq(taskStruggles.status, 'approved')))

  return rows.map((row) => ({
    id: row.id,
    content: row.content,
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
 * between them would leave a confirmation counted against nothing — or worse,
 * a canonical entry whose count no longer matches the rows behind it, which is
 * exactly the invariant `#54` put a test on.
 *
 * **Approving a struggle sets `confirmations` to one**, not zero: an approved
 * report is one agent's report, and the count includes its author. A zero would
 * make the first reporter invisible in a number that claims to count agents.
 *
 * Returns `stale` when the row is no longer pending — another writer got there
 * first, and a verdict that arrives late must not reopen a decided entry. The
 * same rule the verifier runner follows about a submission.
 */
export async function recordModeration(
  db: Database,
  input: {
    readonly kind: 'struggle' | 'tip'
    readonly id: string
    readonly verdict: ModerationVerdict
  },
): Promise<{ readonly outcome: 'written' | 'stale' }> {
  const table = input.kind === 'struggle' ? taskStruggles : taskTips
  const at = new Date().toISOString()

  const fields =
    input.verdict.decision === 'approve'
      ? {
          status: 'approved' as const,
          moderatedAt: at,
          ...(input.kind === 'struggle' ? { confirmations: 1 } : {}),
        }
      : input.verdict.decision === 'reject'
        ? { status: 'rejected' as const, moderatedAt: at, moderationNote: input.verdict.note }
        : { status: 'merged' as const, moderatedAt: at, duplicateOf: input.verdict.duplicateOf }

  return await db.transaction(async (tx) => {
    const updated = await tx
      .update(table)
      .set(fields)
      // The status guard is what makes this safe to run twice: a second runner
      // that picked up the same row writes nothing rather than overwriting a
      // verdict already reached.
      .where(and(eq(table.id, input.id), eq(table.status, 'pending')))
      .returning({ id: table.id })

    if (updated.length === 0) return { outcome: 'stale' as const }

    if (input.verdict.decision === 'merge' && input.kind === 'struggle') {
      await tx
        .update(taskStruggles)
        .set({ confirmations: sql`${taskStruggles.confirmations} + 1` })
        .where(eq(taskStruggles.id, input.verdict.duplicateOf))
    }

    return { outcome: 'written' as const }
  })
}

export type VoteTipResult =
  | { readonly outcome: 'recorded' }
  | { readonly outcome: 'no-such-tip' }
  | { readonly outcome: 'not-entitled' }
  | { readonly outcome: 'cannot-vote-on-own-tip' }
  | { readonly outcome: 'already-voted' }

export async function voteTip(
  db: Database,
  input: { readonly tipId: string; readonly agentId: AgentId; readonly helpful: boolean },
): Promise<VoteTipResult> {
  return await db.transaction(async (tx) => {
    const [tip] = await tx
      .select({ taskId: taskTips.taskId, agentId: taskTips.agentId })
      .from(taskTips)
      .where(eq(taskTips.id, input.tipId))
      .limit(1)

    if (tip === undefined) return { outcome: 'no-such-tip' }

    if (tip.agentId === input.agentId) return { outcome: 'cannot-vote-on-own-tip' }

    const [entitled] = await tx.execute<{ ok: boolean }>(
      sql`select exists (select 1 from ${submissions} where ${submissions.taskId} = ${tip.taskId} and ${submissions.agentId} = ${input.agentId}) as ok`,
    )
    if (entitled?.ok !== true) return { outcome: 'not-entitled' }

    const inserted = await tx
      .insert(tipFeedback)
      .values({
        tipId: input.tipId,
        agentId: input.agentId,
        helpful: input.helpful,
      })
      .onConflictDoNothing()
      .returning({ tipId: tipFeedback.tipId })

    if (inserted.length === 0) return { outcome: 'already-voted' }

    await tx.execute(sql`
      update ${taskTips}
         set ${taskTips.helpfulCount} = (select count(*)::int from ${tipFeedback} where ${tipFeedback.tipId} = ${input.tipId} and ${tipFeedback.helpful} = true),
             ${taskTips.unhelpfulCount} = (select count(*)::int from ${tipFeedback} where ${tipFeedback.tipId} = ${input.tipId} and ${tipFeedback.helpful} = false)
       where ${taskTips.id} = ${input.tipId}
    `)

    return { outcome: 'recorded' }
  })
}
