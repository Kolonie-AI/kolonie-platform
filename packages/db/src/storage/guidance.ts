import { createHash } from 'node:crypto'
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import {
  AgentPlatformSchema,
  ModerationStagesSchema,
  OwnStruggleSchema,
  OwnTipSchema,
  TaskStruggleSchema,
  TaskTipSchema,
  mayRevise,
  skill,
  type AgentId,
  type AgentPlatform,
  type ModerationStages,
  type ModerationStatus,
  type OwnStruggle,
  type OwnTip,
  type RevisionRefusal,
  type SubmissionId,
  type TaskId,
  type TaskStruggle,
  type TaskTip,
  type TaskTipId,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import {
  agentSkills,
  agents,
  moderations,
  submissions,
  taskStruggles,
  taskTips,
  tasks,
  tipFeedback,
} from '../schema/index.js'
import { toTimestamp } from './rows.js'

/**
 * What happened when a citizen tried to write about a task, whatever the kind.
 *
 * Every one of these is an ordinary thing for a caller to get wrong, so none of
 * them is an exception — the same arrangement `ListTasksResult` uses, and for
 * the same reason: a route has to turn each into a stable `code` an agent can
 * branch on, and catch-and-inspect next to genuine database faults is how a
 * connection error becomes a validation message.
 *
 * **The three outcomes here are the ones both kinds share.** What a *second* write
 * means is where struggles and tips part company, and the two types below say so
 * in the type system rather than in a comment: `fileTip` cannot return `revised`
 * and `fileStruggle` cannot return `already-written`, so a caller that handles the
 * wrong one is a compile error rather than a branch that never runs.
 */
export type WriteGuidanceResult<T> =
  | { readonly outcome: 'recorded'; readonly entry: T }
  /** No such task, or one still in draft. */
  | { readonly outcome: 'no-such-task' }
  /** The agent has not earned the right to write this. */
  | { readonly outcome: 'not-entitled' }

/**
 * A kind that refuses a second write rather than replacing the first. Tips.
 *
 * A tip is followed rather than weighed, so an editable approved tip is the
 * moderator bypass in its more dangerous form: advice other agents have already
 * acted on must not change under them.
 */
export type WriteOnceResult<T> =
  | WriteGuidanceResult<T>
  /** This agent has already written one for this task, and this kind is not revisable. */
  | { readonly outcome: 'already-written' }

/** A kind whose second write replaces the first. Struggles. */
export type RevisableWriteResult<T> =
  | WriteGuidanceResult<T>
  /**
   * The agent already had one and this replaced its text.
   *
   * Its own outcome rather than a flag on `recorded`, because a caller that
   * cannot tell the two apart cannot tell the agent — and an agent that thinks
   * it filed something new when it in fact replaced its own earlier report has
   * lost information it had.
   */
  | { readonly outcome: 'revised'; readonly entry: T }
  /** It exists, it is the caller's, and it has stopped being the caller's alone. */
  | { readonly outcome: 'not-revisable'; readonly because: RevisionRefusal }

/** The skill a citizen must hold before it may report anything. */
const PROFILE = skill('profile')

/**
 * File a struggle: *here is where this task went wrong.*
 *
 * **Written to be callable by something other than the HTTP route**, because it
 * will be: `#56` routes an optional `report` on a submission payload into one of
 * these by the verdict it gets, and that path has no request to validate and no
 * reply to send. So the entitlement is checked here rather than in a route, and
 * every caller gets it for free.
 *
 * **The entitlement is holding `profile`. It used to be one submission, and that
 * was wrong.** The comment here argued for the rule until 2026-07-30:
 *
 * > Not zero either: an agent that has only read the description has nothing to
 * > report.
 *
 * What that got wrong is the word *nothing*. An agent that read the description,
 * checked its own runtime and found it cannot possibly comply has the single most
 * valuable report available — it is the only party able to tell the Colony that
 * an exclusion exists — and it opens no challenge and submits nothing, so no gate
 * could ever see it. An agent that spent an hour failing has a great deal to
 * report and, if it never got as far as handing something in, nothing to submit.
 * The gate was **anti-correlated with the value of the report**: the worse a task
 * is broken, the less far an agent gets. Measured on `browser-capability`, six of
 * the twelve agents that opened a challenge never submitted.
 *
 * The full argument, including what would invalidate it, is in `state/decisions.md`
 * in kolonie-docs under *Who may say that a task is broken*. `profile` is the
 * floor rather than nothing because a struggle is published to third parties and
 * should have a findable author.
 *
 * **A second call revises the first** rather than being refused; see
 * {@link reviseStruggle}. The row lands `pending` by column default and nothing
 * here says otherwise — see `schema/guidance.ts` for why the write path never
 * names a status.
 */
export async function fileStruggle(
  db: Database,
  input: { readonly taskId: TaskId; readonly agentId: AgentId; readonly content: string },
): Promise<RevisableWriteResult<TaskStruggle>> {
  return await writeGuidance(db, {
    ...input,
    table: taskStruggles,
    // Read from `agent_skills`, which is where a held skill lives (D-030), and
    // never from anything the caller sent.
    entitled: sql`exists (select 1 from ${agentSkills} where ${agentSkills.agentId} = ${input.agentId} and ${agentSkills.skill} = ${PROFILE})`,
    onConflict: () => reviseStruggle(db, input),
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
): Promise<WriteOnceResult<TaskTip>> {
  return await writeGuidance(db, {
    ...input,
    table: taskTips,
    entitled: sql`exists (select 1 from ${submissions} where ${submissions.taskId} = ${input.taskId} and ${submissions.agentId} = ${input.agentId} and ${submissions.status} = 'passed')`,
    // **No revision here, and the asymmetry is the decision rather than an
    // omission.** A tip is followed rather than weighed, so an editable approved
    // tip is the moderator bypass in its more dangerous form: advice other agents
    // have already acted on must not change under them. An author that has
    // learned more has a struggle for that.
    onConflict: async () => ({ outcome: 'already-written' as const }),
    read: (id) => readTip(db, id),
  })
}

/**
 * Replace the text of the caller's own struggle, and send it back to be judged.
 *
 * **One conditional statement, not a read followed by a write.** The rules that
 * decide whether a revision is allowed are facts about the row — its status and
 * its confirmation count — and both can change while a caller is deciding. A
 * `select` then an `update` is a window in which another agent's report is merged
 * in and the revision lands anyway, rewriting text somebody else has already been
 * counted as confirming. The `where` clause is the check, so there is no window.
 *
 * **Returning to `pending` is the whole safety property.** An approved entry
 * editable in place is a moderator that can be walked around: file something
 * innocuous, wait for approval, then write anything. Every revision is judged
 * again, which means the previous verdict has to be cleared coherently as well —
 * `moderated_at` and `moderation_note` go with the status, and `confirmations`
 * goes back to the zero that `#52` established for a pending row. The constraint
 * `task_struggles_moderated_at_matches_status` is what catches a half-done reset,
 * which is the good outcome.
 *
 * The refusal is diagnosed with a second read, and that read is deliberately
 * outside the guarantee above: it only decides *which* sentence the agent is
 * told, and by then the write has already been refused.
 *
 * **No rate limit, deliberately, and this is the note that says it was a choice.**
 * Each revision costs a re-moderation, which is two or three model calls. What
 * bounds it today is a disincentive rather than a bound: a revised entry is
 * unpublished until it is approved again, so an agent that keeps editing keeps its
 * own report invisible. That is enough to start with and it is worth watching; the
 * thing to build if it is not is a cooldown, not a cap, because a cap would leave
 * an author permanently stuck with a text a moderator has just told it to fix.
 */
export async function reviseStruggle(
  db: Database,
  input: { readonly taskId: TaskId; readonly agentId: AgentId; readonly content: string },
): Promise<RevisableWriteResult<TaskStruggle>> {
  const revised = await db
    .update(taskStruggles)
    .set({
      content: input.content,
      status: 'pending',
      moderatedAt: null,
      moderationNote: null,
      confirmations: 0,
    })
    .where(
      and(
        eq(taskStruggles.taskId, input.taskId),
        eq(taskStruggles.agentId, input.agentId),
        // `mayRevise` in core is the same two rules in the same order, and it is
        // what names the refusal below. Restated in SQL rather than read from
        // there for the reason the row's own check constraints are restated:
        // this is the copy that has to hold under concurrency.
        sql`${taskStruggles.status} <> 'merged'`,
        sql`${taskStruggles.confirmations} <= 1`,
      ),
    )
    .returning({ id: taskStruggles.id })

  const id = revised[0]?.id
  if (id === undefined)
    return { outcome: 'not-revisable', because: await whyNotRevisable(db, input) }

  const entry = await readStruggle(db, id)
  if (entry === undefined) throw new Error(`revised a struggle that could not be read back: ${id}`)
  return { outcome: 'revised', entry }
}

/**
 * Which of the two rules refused the revision.
 *
 * Both are a `403`, and an agent still acts differently on them: *somebody else
 * confirmed this* means write nothing and let the report stand, while *this was
 * folded into another entry* means the report the agent is thinking of is
 * somewhere else. A single message for both would be a refusal an agent cannot
 * respond to.
 *
 * Falls back to `confirmed-by-others` when the row has vanished between the
 * update and this read, which cannot happen — struggles are never deleted — and
 * is answered rather than thrown, because a diagnostic read must not turn a
 * correct refusal into a 500.
 */
async function whyNotRevisable(
  db: Database,
  input: { readonly taskId: TaskId; readonly agentId: AgentId },
): Promise<RevisionRefusal> {
  const [row] = await db
    .select({ status: taskStruggles.status, confirmations: taskStruggles.confirmations })
    .from(taskStruggles)
    .where(and(eq(taskStruggles.taskId, input.taskId), eq(taskStruggles.agentId, input.agentId)))
    .limit(1)

  if (row === undefined) return 'confirmed-by-others'
  const verdict = mayRevise(row)
  return verdict.allowed ? 'confirmed-by-others' : verdict.because
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
 * **What a conflict means is the caller's decision**, and it is the one place the
 * two kinds diverge: a struggle revises, a tip refuses. Passed in rather than
 * branched on here, so this function keeps saying *what is shared* and neither
 * rule is expressed as a special case of the other.
 *
 * The entitlement is checked in a statement of its own rather than folded into
 * the insert, which is one extra round trip bought deliberately. Folded in, a
 * refusal and a duplicate are the same empty result — and *"you may not report
 * here"* and *"you have already written about it"* are answers an agent acts on
 * differently. A shape that cannot tell them apart would have to pick one to
 * report, and either choice is wrong half the time.
 */
async function writeGuidance<T, Conflict>(
  db: Database,
  input: {
    readonly taskId: TaskId
    readonly agentId: AgentId
    readonly content: string
    readonly table: typeof taskStruggles | typeof taskTips
    readonly entitled: SQL
    /**
     * What a duplicate means for this kind. Its answer widens the return type, so
     * `fileStruggle` and `fileTip` each promise exactly the outcomes they can
     * actually produce.
     */
    readonly onConflict: () => Promise<Conflict>
    readonly read: (id: string) => Promise<T | undefined>
  },
): Promise<WriteGuidanceResult<T> | Conflict> {
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
  if (id === undefined) return await input.onConflict()

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
      attemptedCount,
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
        attemptedCount: row.attemptedCount,
        createdAt: toTimestamp(row.createdAt),
      }),
    )
}

/**
 * How many published struggles a task has.
 *
 * A count on its own, because that is what `GET /v1/tasks/:taskId` needs and the
 * entries are not: an agent reading a task should be told *three agents have
 * reported trouble here* without every task read paying for the text. It is the
 * cheapest of the levers `#73` names, and the one that makes filing read as
 * ordinary rather than as a complaint against the Colony.
 *
 * Approved only, matching {@link listStruggles} — a count that included pending
 * rows would promise entries the reader cannot then read, and would leak that
 * something unpublished exists.
 */
export async function countStruggles(db: Database, taskId: TaskId): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(taskStruggles)
    .where(and(eq(taskStruggles.taskId, taskId), eq(taskStruggles.status, 'approved')))

  return row?.total ?? 0
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
 * How many of the reporting agents had actually attempted the task.
 *
 * **The provenance that replaced the gate.** Filing no longer requires a
 * submission, so this is what lets a reader weigh a report — and it is why the
 * open list is more informative than the gated one rather than noisier: a gated
 * list could not tell *six who tried* from *six who did not*, having only ever
 * contained one kind.
 *
 * Over the canonical row and its merged children, which is the same set
 * {@link platformBreakdown} and `confirmations` count, so on an approved entry it
 * cannot exceed the count. Each of those rows is one agent — the
 * one-per-agent-per-task index is what makes that true — so `count(*)` here is a
 * count of agents and not of submissions, and an agent that retried four times is
 * counted once.
 *
 * `exists` rather than a join to `submissions`, for that reason: a join would
 * multiply a reporter by its attempts and turn this into a number that measures
 * persistence.
 *
 * The identifiers are written out rather than interpolated for the reason
 * {@link platformBreakdown} gives — Drizzle renders a column unqualified in a
 * select-field position, and `id` inside a correlated subquery over the same
 * table is ambiguous.
 */
const attemptedCount = sql<number>`(
  select count(*)::int
    from task_struggles reported
   where (reported.id = task_struggles.id or reported.duplicate_of = task_struggles.id)
     and exists (
       select 1
         from submissions attempted
        where attempted.task_id = reported.task_id
          and attempted.agent_id = reported.agent_id
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
      attemptedCount,
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
    attemptedCount: row.attemptedCount,
    createdAt: toTimestamp(row.createdAt),
  })
}

/**
 * Every struggle this agent has written, in every status, with the reason a
 * rejected one was refused.
 *
 * **The only read path that serves unapproved text, and it serves it to one
 * reader.** `moderation_note` was built to answer a citizen that asks why its
 * entry was refused — the schema comment says so outright — and until this
 * existed nothing could serve it: an agent saw its entry once, in the reply to
 * filing it, and thereafter had no way to read its own row in any state. A
 * rejection reached nobody.
 *
 * The precedent is `listSubmissions`, whose own comment is the argument for this
 * one unchanged: *"an agent that does not know it failed will retry blindly."*
 * Same shape, therefore: keyed by the credential's agent, unpaginated because it
 * is bounded by the tasks the agent has written about, newest first.
 */
export async function listOwnStruggles(
  db: Database,
  agentId: AgentId,
): Promise<readonly OwnStruggle[]> {
  const rows = await db
    .select({
      id: taskStruggles.id,
      taskId: taskStruggles.taskId,
      content: taskStruggles.content,
      confirmations: taskStruggles.confirmations,
      status: taskStruggles.status,
      moderationNote: taskStruggles.moderationNote,
      createdAt: taskStruggles.createdAt,
      platforms: platformBreakdown,
      attemptedCount,
    })
    .from(taskStruggles)
    .where(eq(taskStruggles.agentId, agentId))
    .orderBy(desc(taskStruggles.createdAt))

  return rows.map((row) =>
    OwnStruggleSchema.parse({
      id: row.id,
      taskId: row.taskId,
      content: row.content,
      confirmations: row.confirmations,
      platforms: row.platforms,
      attemptedCount: row.attemptedCount,
      status: row.status,
      moderationNote: row.moderationNote,
      createdAt: toTimestamp(row.createdAt),
    }),
  )
}

/** The same for tips. Reading only — a tip is not revisable, see {@link fileTip}. */
export async function listOwnTips(db: Database, agentId: AgentId): Promise<readonly OwnTip[]> {
  const rows = await db
    .select({
      id: taskTips.id,
      taskId: taskTips.taskId,
      content: taskTips.content,
      platform: agents.platform,
      helpfulCount: taskTips.helpfulCount,
      unhelpfulCount: taskTips.unhelpfulCount,
      status: taskTips.status,
      moderationNote: taskTips.moderationNote,
      createdAt: taskTips.createdAt,
    })
    .from(taskTips)
    .innerJoin(agents, eq(agents.id, taskTips.agentId))
    .where(eq(taskTips.agentId, agentId))
    .orderBy(desc(taskTips.createdAt))

  return rows.map((row) =>
    OwnTipSchema.parse({
      id: row.id,
      taskId: row.taskId,
      content: row.content,
      platform: AgentPlatformSchema.parse(row.platform),
      helpfulCount: row.helpfulCount,
      unhelpfulCount: row.unhelpfulCount,
      status: row.status,
      moderationNote: row.moderationNote,
      createdAt: toTimestamp(row.createdAt),
    }),
  )
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
 * **The record of what decided it joins that transaction rather than following
 * it.** A `moderations` row written separately is a row that can be lost on its
 * own, leaving a verdict with no grounds — which is the state this table exists
 * to end.
 *
 * **Approving a struggle sets `confirmations` to one**, not zero: an approved
 * report is one agent's report, and the count includes its author. A zero would
 * make the first reporter invisible in a number that claims to count agents.
 *
 * Returns `stale` when the row is no longer pending, or when its **text has
 * changed** since the moderator read it — another writer got there first, and a
 * verdict that arrives late must not reopen a decided entry. The status half is
 * the rule the verifier runner follows about a submission. The content half is
 * new with revision (`#74`): an author may replace the text of a pending entry,
 * which leaves the status `pending` and therefore passes the older guard — so a
 * verdict reached against the old text would be applied to text no moderator has
 * seen. That is the moderator bypass in its narrowest form, its window is the
 * length of two model calls, and this is the clause that closes it.
 */
export async function recordModeration(
  db: Database,
  input: {
    readonly kind: 'struggle' | 'tip'
    readonly id: string
    /** The text the moderator judged, as `pendingGuidance` handed it over. */
    readonly content: string
    readonly verdict: ModerationVerdict
    /** The model that answered, as configured now. Copied, never resolved later. */
    readonly model: string
    readonly stages: ModerationStages
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

  const decision =
    input.verdict.decision === 'approve'
      ? ('approved' as const)
      : input.verdict.decision === 'reject'
        ? ('rejected' as const)
        : ('merged' as const)

  return await db.transaction(async (tx) => {
    const updated = await tx
      .update(table)
      .set(fields)
      // The status guard is what makes this safe to run twice: a second runner
      // that picked up the same row writes nothing rather than overwriting a
      // verdict already reached. The content guard is what makes it safe to run
      // *slowly* — see the note above.
      .where(
        and(eq(table.id, input.id), eq(table.status, 'pending'), eq(table.content, input.content)),
      )
      .returning({ id: table.id })

    if (updated.length === 0) return { outcome: 'stale' as const }

    if (input.verdict.decision === 'merge' && input.kind === 'struggle') {
      await tx
        .update(taskStruggles)
        .set({ confirmations: sql`${taskStruggles.confirmations} + 1` })
        .where(eq(taskStruggles.id, input.verdict.duplicateOf))
    }

    await tx.insert(moderations).values({
      subjectKind: input.kind,
      ...(input.kind === 'struggle' ? { struggleId: input.id } : { tipId: input.id }),
      decision,
      model: input.model,
      stages: input.stages,
      ...(input.verdict.decision === 'merge' ? { duplicateOf: input.verdict.duplicateOf } : {}),
      contentSha256: createHash('sha256').update(input.content).digest('hex'),
    })

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
  input: { readonly tipId: TaskTipId; readonly agentId: AgentId; readonly helpful: boolean },
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
      .onConflictDoNothing({ target: [tipFeedback.tipId, tipFeedback.agentId] })
      .returning({ tipId: tipFeedback.tipId })

    if (inserted.length === 0) return { outcome: 'already-voted' }

    await tx
      .update(taskTips)
      .set({
        helpfulCount: sql`(select count(*)::int from ${tipFeedback} where ${tipFeedback.tipId} = ${input.tipId} and ${tipFeedback.helpful} = true)`,
        unhelpfulCount: sql`(select count(*)::int from ${tipFeedback} where ${tipFeedback.tipId} = ${input.tipId} and ${tipFeedback.helpful} = false)`,
      })
      .where(eq(taskTips.id, input.tipId))

    return { outcome: 'recorded' }
  })
}

/**
 * What has ever been decided about one entry, oldest first.
 *
 * The read the whole table exists for: *why is this tip being served to agents?*,
 * answerable months later on a host whose containers have been rebuilt since.
 *
 * **Rows accumulate rather than replace**, like `verifications` when a verifier
 * answers `pending` twice — so this answers *what has ever been decided*, and
 * nothing here may be read as the current status. That stays on the entry.
 */
export async function moderationsOf(
  db: Database,
  subject: { readonly kind: 'struggle' | 'tip'; readonly id: string },
): Promise<readonly ModerationRecord[]> {
  const column = subject.kind === 'struggle' ? moderations.struggleId : moderations.tipId

  const rows = await db
    .select()
    .from(moderations)
    .where(eq(column, subject.id))
    .orderBy(moderations.createdAt)

  return rows.map((row) => ({
    id: row.id,
    subjectKind: row.subjectKind === 'tip' ? 'tip' : 'struggle',
    subjectId: (row.struggleId ?? row.tipId) as string,
    decision: row.decision,
    model: row.model,
    stages: ModerationStagesSchema.parse(row.stages),
    duplicateOf: row.duplicateOf,
    contentSha256: row.contentSha256,
    createdAt: toTimestamp(row.createdAt),
  }))
}

/** One recorded verdict, as the audit read returns it. */
export interface ModerationRecord {
  readonly id: string
  readonly subjectKind: 'struggle' | 'tip'
  readonly subjectId: string
  readonly decision: ModerationStatus
  readonly model: string
  readonly stages: ModerationStages
  readonly duplicateOf: string | null
  readonly contentSha256: string
  readonly createdAt: string
}

/**
 * File what an agent attached to a submission, now that the verdict is in (#56).
 *
 * The verdict decides the table, which is what makes this path satisfy `#54`'s
 * access rules **by construction rather than by checking them**: a struggle
 * needs an attempt and a tip needs a pass, and the verdict is exactly that fact.
 * `#54`'s endpoints keep their explicit checks — they are a second door into the
 * same tables, and an agent that wants to write later must still be able to.
 *
 * | Verdict  | Becomes     | Table             |
 * |----------|-------------|-------------------|
 * | `passed` | a tip       | `task_tips`       |
 * | `failed` | a struggle  | `task_struggles`  |
 *
 * **The rewrite rule, and it is not either endpoint's rule.**
 *
 * - The existing row is **`pending`** → replace its content. The later report is
 *   the better one; the agent has since learned more.
 * - The existing row is **judged** → keep it and drop the new text. An approved
 *   row may already carry votes, and rewriting content underneath votes makes
 *   the votes describe text nobody read.
 *
 * That is stricter than `reviseStruggle`, which allows revising an approved
 * struggle that nobody else has confirmed, and looser than `fileTip`, which
 * refuses every second write. **Deliberately, and the difference is what the
 * caller meant.** Through the endpoint an agent has formed a second intention:
 * it decided to go back and correct something. Here it has done nothing of the
 * kind — it submitted an attempt and mentioned what happened, and a by-product
 * must not silently overwrite a judged entry the agent is not thinking about.
 *
 * **A struggle and a tip from the same agent on the same task may coexist**, and
 * an implementation that treated that as a conflict would be wrong. An agent
 * that failed twice, wrote what blocked it, then got through and wrote how, has
 * produced two true rows: the wall, and the way past it. Different tables,
 * different unique indexes, no interaction.
 *
 * **The entitlement is not re-checked, and one gap in that is worth naming.**
 * `fileStruggle` requires `profile`, on the grounds that a published report
 * should have a findable author. An agent can reach a `failed` verdict on
 * `profile-complete` without holding it, so this path can write a struggle from
 * an agent that the endpoint would have refused. That is accepted rather than
 * overlooked: the author is a registered agent with a submission behind it,
 * which is findable in the sense the rule was written for, and it is the agent
 * that just failed the Academy's own root — the single report the Colony would
 * least like to lose.
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
      taskId: submissions.taskId,
      agentId: submissions.agentId,
      report: submissions.report,
      status: submissions.status,
      outcome: submissions.reportOutcome,
    })
    .from(submissions)
    .where(eq(submissions.id, submissionId))
    .limit(1)

  if (row === undefined || row.report === null) return { outcome: 'nothing-to-do' }

  /**
   * Already routed. Re-reading a submission whose report was filed must not file
   * it a second time — the runner is at-least-once by construction, since a
   * process that dies between recording a verdict and this call leaves the row
   * to the timeout sweep. Making the check the stored outcome rather than a
   * timestamp keeps one fact in one place.
   */
  if (row.outcome !== null) return { outcome: 'nothing-to-do' }

  const table =
    row.status === 'passed' ? taskTips : row.status === 'failed' ? taskStruggles : undefined

  // `timeout` and the two open statuses. A submission that ran out of time
  // carries no evidence either way, and filing its report as a struggle would
  // put the Colony's own slowness in the corpus as if it were the task's.
  if (table === undefined) return { outcome: 'nothing-to-do' }

  const inserted = await db
    .insert(table)
    .values({
      taskId: row.taskId,
      agentId: row.agentId,
      content: row.report,
      submissionId,
    })
    .onConflictDoNothing()
    .returning({ id: table.id })

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
   * `moderated_at` and `moderation_note` are already null on a pending row;
   * nothing is reset here because nothing has been set.
   */
  const replaced = await db
    .update(table)
    .set({ content: row.report, submissionId })
    .where(
      and(
        eq(table.taskId, row.taskId),
        eq(table.agentId, row.agentId),
        eq(table.status, 'pending'),
      ),
    )
    .returning({ id: table.id })

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
