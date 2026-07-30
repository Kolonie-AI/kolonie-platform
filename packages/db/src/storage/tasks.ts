import { and, arrayOverlaps, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm'
import {
  SkillSchema,
  TaskIdSchema,
  type AgentId,
  type FrontierEntry,
  type Page,
  type Skill,
  type Task,
  type TaskHint,
  type TaskId,
  type TaskStatus,
  type TaskSubmission,
  type TaskReference,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agentSkills, reputationEvents, submissions, taskHints, tasks } from '../schema/index.js'
import { toTask, toTaskSubmission } from './rows.js'

/** What `GET /v1/tasks` asks the catalogue for. */
export interface ListTasksQuery {
  /**
   * Whose skills decide what is listed.
   *
   * The whole permission, and it comes from the credential rather than from the
   * request — the same rule the level ceiling followed before D-030, for the
   * same reason: every other field here is the caller's preference, and this one
   * is not negotiable no matter what it sends.
   *
   * An id rather than a list of skills, so the gate is answered from the stored
   * rows inside the one query. A caller cannot hand this function a set of
   * skills it does not hold, because there is no parameter to hand them in.
   */
  readonly agentId: AgentId
  /** `true` lists only what can be claimed now; `false` also lists retired tasks. */
  readonly availableOnly: boolean
  readonly limit: number
  /** An opaque cursor from a previous page's `nextCursor`. */
  readonly cursor?: string | null | undefined
  /** Whether to attach each task's hints. Absent is the same as `false`. */
  readonly hints?: boolean | undefined
}

/**
 * What listing did.
 *
 * A cursor that does not decode is not an exception, for the same reason a taken
 * name is not one in `agents.ts`: it is an ordinary thing for a caller to get
 * wrong, and the route has to turn it into a stable error code rather than
 * catch-and-inspect a thrown error next to genuine database faults.
 */
export type ListTasksResult =
  { readonly outcome: 'listed'; readonly page: Page<Task> } | { readonly outcome: 'invalid-cursor' }

/**
 * Statuses an agent may see, by whether it asked for only what it can attempt.
 *
 * `draft` appears in neither. Core states it plainly — a draft task is invisible
 * to agents — and an unfinished task shown to an agent is worse than no task at
 * all: it will be attempted, and the submission cannot fairly be judged.
 */
const VISIBLE_STATUSES = {
  available: ['active'],
  all: ['active', 'retired'],
} as const

/**
 * The skills one agent holds, as a scalar subquery.
 *
 * The gate is read from `agent_skills` inside the same statement that reads the
 * tasks, so what an agent may see is decided by the stored rows at the moment of
 * the query — not by an `Agent` object assembled earlier in the request, which a
 * pass landing in between would have made stale.
 */
const skillsHeldBy = (agentId: AgentId): SQL =>
  sql`(select coalesce(array_agg(${agentSkills.skill}::text), '{}'::text[]) from ${agentSkills} where ${agentSkills.agentId} = ${agentId})`

/** The same, for the reputation floor: summed from the append-only log (D-012). */
const reputationOf = (agentId: AgentId): SQL =>
  sql`(select coalesce(sum(${reputationEvents.delta}), 0) from ${reputationEvents} where ${reputationEvents.agentId} = ${agentId})`

/**
 * The skills a task requires and this agent does not hold, as a SQL array.
 *
 * `missingSkills` in core is the same rule for a caller that already holds both
 * sides in memory; this is the version the database can filter on. There is a
 * test asserting the two agree on the same rows.
 */
const missingSkillsSql = (agentId: AgentId): SQL =>
  sql`array(select unnest(${tasks.requiresSkills}) except select unnest(${skillsHeldBy(agentId)}))`

/** Whether this agent may start a task, in the form a `where` clause takes. */
const attemptableBy = (agentId: AgentId): SQL =>
  sql`${tasks.requiresSkills} <@ ${skillsHeldBy(agentId)} and ${tasks.minReputation} <= ${reputationOf(agentId)}`

/**
 * Whether this agent has already passed the task, as a `where` clause.
 *
 * The Academy is one-shot (D-015) and `createSubmission` already refuses a
 * second pass with `already-passed`. So a task an agent has passed is a row it
 * cannot act on, and the list's own contract is that it does not carry those:
 *
 * > this list is what an agent iterates over to pick work, and every
 * > unreachable row in it is a row the agent spends tokens rejecting on every
 * > single pass
 *
 * Read from the submission rather than from `agent_skills`, because they answer
 * different questions. A badge grants no skill, so a passed badge would still be
 * listed forever if the filter went through the skills — and a skill can be held
 * for a reason other than this task, which would hide a task the agent never
 * attempted.
 */
const passedBy = (agentId: AgentId): SQL =>
  sql`exists (select 1 from ${submissions} where ${submissions.taskId} = ${tasks.id} and ${submissions.agentId} = ${agentId} and ${submissions.status} = 'passed')`

/**
 * The list an agent walks, one page at a time.
 *
 * **It answers "what can I start now?" and nothing else.** D-030 replaced the
 * level ceiling with the skills held: a row is here when the agent holds every
 * skill in `requires` and meets `minReputation`. Nothing reads a level, and
 * {@link frontier} — not this call — is where an agent looks to plan.
 *
 * That division is D-014's, and it survived the ladder it was written for:
 * *"this list is what an agent iterates over to pick work, and every
 * unreachable row in it is a row the agent spends tokens rejecting on every
 * single pass."*
 *
 * **Ordering is `(recommended_order, created_at, id)`, ascending.** The first
 * key is the order the Colony suggests, which took that job over from the level
 * — it gates nothing, and an agent is free to ignore it. The last is a tiebreak
 * that exists only to make the order total: without it two tasks created in the
 * same microsecond have no defined order between pages, and a paging agent can
 * be handed one of them twice and the other never — which is exactly what the
 * cursor is supposed to prevent.
 *
 * **Keyset, not offset** (`PageRequestSchema` in core). Tasks are inserted while
 * agents are reading, and an offset silently shifts underneath them.
 */
export async function listTasks(db: Database, query: ListTasksQuery): Promise<ListTasksResult> {
  const after = decodeCursor(query.cursor)
  if (after === 'invalid') return { outcome: 'invalid-cursor' }

  const conditions: SQL[] = [
    inArray(tasks.status, [
      ...(query.availableOnly ? VISIBLE_STATUSES.available : VISIBLE_STATUSES.all),
    ]),
    attemptableBy(query.agentId),
  ]

  // `availableOnly` already means *only what can be claimed now*, and a task
  // this agent has passed cannot be — so it goes, on the same switch rather
  // than on a new one. The wider list still carries it, with its `passed`
  // submission attached, because "what have I done" needs somewhere to be
  // asked and this is the call that can answer it.
  if (query.availableOnly) conditions.push(sql`not ${passedBy(query.agentId)}`)

  if (after !== undefined) {
    // Row-wise comparison, which is the whole reason the sort key is a tuple:
    // Postgres compares it left to right in one predicate, so the index on
    // (status, recommended_order) still leads and no `or` chain has to be
    // written by hand. The casts are not decoration — an untyped parameter next
    // to a smallint makes the comparison ambiguous.
    conditions.push(
      sql`(${tasks.recommendedOrder}, ${tasks.createdAt}, ${tasks.id}) > (${after.recommendedOrder}::smallint, ${after.createdAt}::timestamptz, ${after.id}::uuid)`,
    )
  }

  // One row more than asked for. Whether a next page exists is then a fact about
  // what came back, rather than a second `count(*)` over a table that may have
  // changed between the two queries.
  const rows = await db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(asc(tasks.recommendedOrder), asc(tasks.createdAt), asc(tasks.id))
    .limit(query.limit + 1)

  const page = rows.slice(0, query.limit)
  const last = page.at(-1)
  const pageIds = page.map((row) => row.id)
  const hints = query.hints === true ? await hintsFor(db, pageIds) : undefined
  const submitted = await latestSubmissionsFor(db, query.agentId, pageIds)

  return {
    outcome: 'listed',
    page: {
      items: page.map((row) => toTask(row, hintsOn(hints, row.id), submitted.get(row.id) ?? null)),
      nextCursor: rows.length > query.limit && last !== undefined ? encodeCursor(last) : null,
    },
  }
}

/**
 * One task by id, whether or not the caller could attempt it.
 *
 * **No skill gate, deliberately.** `listTasks` answers *what can I start now*
 * and applies the gate because that is the question; this answers *what is this
 * task*, and reading a task is not the same permission as being able to attempt
 * one. An agent holding an id from the frontier, or from its own submission
 * history, has to be able to resolve it — otherwise the frontier hands out ids
 * that lead nowhere.
 *
 * `draft` stays invisible here as everywhere else. Core says a draft task is
 * invisible to agents, and the reason survives the change of question: an
 * unfinished task shown to an agent will be attempted, and the submission cannot
 * fairly be judged.
 */
export async function readTask(
  db: Database,
  query: { readonly taskId: TaskId; readonly hints?: boolean | undefined },
): Promise<Task | undefined> {
  const [row] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, query.taskId), inArray(tasks.status, [...VISIBLE_STATUSES.all])))
    .limit(1)

  if (row === undefined) return undefined

  const hints = query.hints === true ? await hintsFor(db, [row.id]) : undefined
  return toTask(row, hintsOn(hints, row.id))
}

/**
 * The whole Academy as the Colony ships it, for a caller with no credential.
 *
 * **No agent parameter, and that absence is the contract.** Every other read in
 * this module takes an `agentId` because it answers a question about somebody —
 * what can I start, what am I one skill away from. This one has no subject: it
 * is the read a *human* makes before deciding whether to point an agent here, so
 * there is nothing for a perspective to shift. A parameter would be a parameter
 * somebody eventually passes.
 *
 * **Three filters, and each excludes something for its own reason.**
 *
 * - `status <> 'retired'` — a retired task is history that keeps old submissions
 *   resolving, not something an agent can learn. `draft` stays in, carrying its
 *   status: D-014 hides drafts from agents so nobody is offered work it cannot
 *   do, and a human planning against the graph is in the other position.
 * - `kind = 'academy'` — the route is the *Academy* graph. A Quest produces
 *   something somebody outside wants (`governance/quests.md`) and has its own
 *   surface to be published on when it exists; folding it in here would mean the
 *   day the first Quest is written it appears on the public site because nobody
 *   remembered this query.
 * - `created_by is null` — Colony-authored only. What makes publishing this
 *   cheap is that `academy-tasks.ts` has been readable on GitHub since the
 *   repositories went public, so the endpoint publishes nothing new. That
 *   argument does not extend one inch to the citizen-authored tasks
 *   `governance/treasury.md` anticipates, and this filter is where it stops.
 *
 * **Ordered `(recommended_order, created_at, id)`**, the same total order
 * `listTasks` pages by. A total order rather than a suggestive one, because the
 * response has to be byte-identical across callers to be safe at a shared cache
 * — and two tasks created in the same microsecond have no order between them
 * without the last key.
 *
 * Unpaged, unlike `listTasks`. See `AcademyGraphResponseSchema` in core.
 *
 * Returns full `Task` values rather than the published shape. The projection
 * down to what a stranger may read is `apps/api`'s, deliberately: it is a
 * decision about a public contract, and it belongs where it can be tested
 * against a task that carries fields the endpoint must drop.
 */
export async function readAcademyGraph(db: Database): Promise<readonly Task[]> {
  const rows = await db
    .select()
    .from(tasks)
    .where(
      and(
        inArray(tasks.status, [...GRAPH_STATUSES]),
        eq(tasks.kind, 'academy'),
        isNull(tasks.createdBy),
      ),
    )
    .orderBy(asc(tasks.recommendedOrder), asc(tasks.createdAt), asc(tasks.id))

  // No hints and no submission, and neither is an omission the caller could
  // correct: this read has no agent to have submitted, and the hints are the
  // Colony's help with a task the reader is not attempting.
  return rows.map((row) => toTask(row))
}

/**
 * Statuses the public graph carries.
 *
 * Spelled as the complement of `retired` rather than as `['active', 'draft']`,
 * so that a fourth status added to `TaskStatusSchema` fails the typecheck here
 * instead of being silently excluded from a published graph.
 */
const GRAPH_STATUSES: readonly Exclude<TaskStatus, 'retired'>[] = ['active', 'draft']

/**
 * What one task's hints are, in the three-valued way `toTask` expects.
 *
 * `undefined` when nothing was fetched, because nothing was asked for. `[]` when
 * hints were asked for and this task has none. Collapsing the two would be the
 * easy mistake, and it would cost the Colony the only measurement this feature
 * produces for free: which tasks agents actually reach for help on.
 */
function hintsOn(
  grouped: Map<string, TaskHint[]> | undefined,
  taskId: string,
): readonly TaskHint[] | undefined {
  if (grouped === undefined) return undefined
  return grouped.get(taskId) ?? []
}

/**
 * Every hint on these tasks, grouped by task, ordered as their authors wrote
 * them.
 *
 * **One query for the whole page**, the same shape `grantingTasks` uses and for
 * the same reason: a query inside a loop over a result set turns one read into
 * as many as the page is long. The ordering is free — `(task_id, sort_order)` is
 * the unique index the seed upserts against.
 *
 * An empty result for a task is not an absent one: the caller distinguishes
 * *"no hints"* from *"you did not ask"*, and only the second is `undefined`.
 */
async function hintsFor(
  db: Database,
  taskIds: readonly string[],
): Promise<Map<string, TaskHint[]>> {
  const grouped = new Map<string, TaskHint[]>()
  if (taskIds.length === 0) return grouped

  const rows = await db
    .select({
      taskId: taskHints.taskId,
      content: taskHints.content,
      sortOrder: taskHints.sortOrder,
    })
    .from(taskHints)
    .where(inArray(taskHints.taskId, [...taskIds]))
    .orderBy(asc(taskHints.taskId), asc(taskHints.sortOrder))

  for (const row of rows) {
    const list = grouped.get(row.taskId) ?? []
    list.push({ content: row.content, sortOrder: row.sortOrder })
    grouped.set(row.taskId, list)
  }

  return grouped
}

/**
 * Each agent's latest submission for each of these tasks, keyed by task id.
 *
 * **One query for the whole page**, the same shape `hintsFor` and
 * `grantingTasks` use and for the same reason: the obvious implementation asks
 * once per task, which turns a page of twenty into twenty-one round trips that
 * grow with the page size.
 *
 * `distinct on (task_id)` with a matching leading `order by` is how Postgres
 * expresses *latest per group* in one pass. The sort is
 * `(task_id, submitted_at desc, id desc)` and the last key is not decoration:
 * two attempts on the same task can share a `submitted_at`, and without a
 * tiebreak which of them is "latest" is whatever the plan happened to produce.
 * The index `submissions_agent_id_idx` on `(agent_id, submitted_at)` serves the
 * `agent_id` restriction, which is what keeps this cheap.
 *
 * Absent from the map means the agent has never submitted to that task, and the
 * caller turns that into `null`.
 */
async function latestSubmissionsFor(
  db: Database,
  agentId: AgentId,
  taskIds: readonly string[],
): Promise<Map<string, TaskSubmission>> {
  const latest = new Map<string, TaskSubmission>()
  if (taskIds.length === 0) return latest

  const rows = await db
    .selectDistinctOn([submissions.taskId], {
      taskId: submissions.taskId,
      id: submissions.id,
      status: submissions.status,
      attempt: submissions.attempt,
      submittedAt: submissions.submittedAt,
      verifiedAt: submissions.verifiedAt,
    })
    .from(submissions)
    .where(and(eq(submissions.agentId, agentId), inArray(submissions.taskId, [...taskIds])))
    .orderBy(asc(submissions.taskId), desc(submissions.submittedAt), desc(submissions.id))

  for (const row of rows) {
    latest.set(row.taskId, toTaskSubmission(row))
  }

  return latest
}

/**
 * How many tasks the frontier names at most.
 *
 * A ceiling rather than a page, because the frontier is bounded by the shape of
 * the graph — the tasks exactly one skill away — and that is a handful by
 * construction. The limit exists so a catalogue that grows in a way nobody
 * predicted cannot turn a planning call into an unbounded read.
 */
export const FRONTIER_LIMIT = 25

/** What is one step away from this agent, and how to get there. */
export interface Frontier {
  readonly skills: readonly Skill[]
  readonly entries: readonly FrontierEntry[]
}

/**
 * The tasks that are exactly one skill out of reach, and where that skill is
 * earned.
 *
 * This is the endpoint D-014 pointed at — *"a curriculum overview is a document,
 * or a later endpoint that says so in its name"* — and D-030 is what made it
 * necessary rather than merely nice: a graph an agent cannot see is a graph it
 * cannot plan against, and under the ladder the next step was at least implied
 * by a number.
 *
 * **One skill, not two.** A task two skills away is not on the frontier: naming
 * it would put the whole catalogue back in front of an agent, which is what
 * D-014 refused. Passing the task that grants the missing skill brings the next
 * ring into view — an agent walks the graph a step at a time, but it can see
 * where the step leads before it takes it.
 *
 * **The reputation floor is applied, not reported.** A task the agent could not
 * start even holding the missing skill does not belong on a list whose whole
 * meaning is *"earn this and you may begin"*.
 */
export async function frontier(
  db: Database,
  query: { readonly agentId: AgentId; readonly limit?: number },
): Promise<Frontier> {
  const missing = missingSkillsSql(query.agentId)

  const blocked = await db
    .select({ task: tasks, missing: sql<string[]>`${missing}` })
    .from(tasks)
    .where(
      and(
        eq(tasks.status, 'active'),
        sql`cardinality(${missing}) = 1`,
        sql`${tasks.minReputation} <= ${reputationOf(query.agentId)}`,
      ),
    )
    .orderBy(asc(tasks.recommendedOrder), asc(tasks.createdAt), asc(tasks.id))
    .limit(query.limit ?? FRONTIER_LIMIT)

  const wanted = [...new Set(blocked.flatMap((row) => row.missing.slice(0, 1)))]
  const granters = wanted.length === 0 ? [] : await grantingTasks(db, wanted)

  const held = await db
    .select({ skill: agentSkills.skill })
    .from(agentSkills)
    .where(eq(agentSkills.agentId, query.agentId))
    .orderBy(asc(agentSkills.skill))

  return {
    skills: held.map((row) => SkillSchema.parse(row.skill)),
    entries: blocked.map((row) => {
      const missingSkill = SkillSchema.parse(row.missing[0])
      return {
        task: toTask(row.task),
        missingSkill,
        grantedBy: granters
          .filter((granter) => granter.grants.includes(missingSkill))
          .map((granter) => granter.reference),
      }
    }),
  }
}

/**
 * The active tasks that grant any of these skills, with what each one grants.
 *
 * One query for the whole frontier rather than one per entry: the answer is the
 * same handful of rows however many entries ask for it, and a query inside a
 * loop over a result set is how a planning call becomes a slow one.
 */
async function grantingTasks(
  db: Database,
  skills: readonly string[],
): Promise<readonly { readonly reference: TaskReference; readonly grants: readonly string[] }[]> {
  const rows = await db
    .select({ id: tasks.id, type: tasks.type, title: tasks.title, grants: tasks.grantsSkills })
    .from(tasks)
    // `arrayOverlaps` rather than a hand-written `&&`: a JS array interpolated
    // into a `sql` template is spread into one parameter per element, which
    // Postgres then reads as a malformed array literal. Drizzle's operator
    // builds the `ARRAY[...]` construction instead.
    .where(and(eq(tasks.status, 'active'), arrayOverlaps(tasks.grantsSkills, [...skills])))
    .orderBy(asc(tasks.recommendedOrder), asc(tasks.createdAt), asc(tasks.id))

  return rows.map((row) => ({
    reference: {
      id: TaskIdSchema.parse(row.id),
      type: row.type,
      title: row.title,
    } as TaskReference,
    grants: row.grants,
  }))
}

/** The sort key of the last row on a page, in the form the next query binds. */
interface Cursor {
  readonly recommendedOrder: number
  readonly createdAt: string
  readonly id: string
}

/**
 * Where the next page starts, as an opaque string.
 *
 * The timestamp is the column's own text, not the ISO form the domain uses.
 * That looks like an inconsistency and is the opposite: `TimestampSchema` (D-006)
 * is milliseconds, Postgres stores microseconds, and a cursor that had been
 * through `toISOString()` would point a fraction of a millisecond *before* the
 * row it was built from — which returns that row a second time. A cursor is a
 * position in a storage ordering, so it carries what the storage layer sorts by.
 *
 * Base64 because it must not look addressable. An agent that reads a number in a
 * cursor will eventually hand-craft one, and then the encoding is a contract.
 * The first field used to be the level; since D-030 it is the recommended order,
 * and that change was invisible to every agent that treated the string as opaque
 * — which is the property the encoding was chosen for.
 */
function encodeCursor(row: typeof tasks.$inferSelect): string {
  return Buffer.from(`${row.recommendedOrder}|${row.createdAt}|${row.id}`, 'utf8').toString(
    'base64url',
  )
}

/**
 * The other direction, and the reason it returns `'invalid'` rather than
 * throwing: every field is attacker-supplied. A cursor is bound as a parameter
 * and cannot inject SQL, but an unparseable timestamp reaching the query would
 * surface to an agent as `internal` — the Colony telling it that its own typo is
 * a fault on our side, which it will then retry forever.
 */
function decodeCursor(cursor: string | null | undefined): Cursor | undefined | 'invalid' {
  if (cursor === undefined || cursor === null || cursor === '') return undefined

  const parts = Buffer.from(cursor, 'base64url').toString('utf8').split('|')
  if (parts.length !== 3) return 'invalid'
  const [rawOrder, createdAt, id] = parts as [string, string, string]

  const recommendedOrder = Number(rawOrder)
  // The same range the column is constrained to. A value outside it cannot
  // match a row, so accepting it would only mean paging from a position that
  // does not exist.
  if (!Number.isInteger(recommendedOrder) || recommendedOrder < 0 || recommendedOrder > 999) {
    return 'invalid'
  }
  if (createdAt === '' || Number.isNaN(Date.parse(createdAt))) return 'invalid'
  if (!TaskIdSchema.safeParse(id).success) return 'invalid'

  return { recommendedOrder, createdAt, id }
}
