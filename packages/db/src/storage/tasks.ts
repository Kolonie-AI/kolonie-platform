import { and, arrayOverlaps, asc, eq, inArray, sql, type SQL } from 'drizzle-orm'
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
  type TaskReference,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agentSkills, reputationEvents, taskHints, tasks } from '../schema/index.js'
import { toTask } from './rows.js'

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
  const hints =
    query.hints === true
      ? await hintsFor(
          db,
          page.map((row) => row.id),
        )
      : undefined

  return {
    outcome: 'listed',
    page: {
      items: page.map((row) => toTask(row, hintsOn(hints, row.id))),
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
