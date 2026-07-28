import { and, asc, eq, inArray, lte, sql, type SQL } from 'drizzle-orm'
import {
  AcademyLevelSchema,
  TaskIdSchema,
  type AcademyLevel,
  type Page,
  type Task,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { tasks } from '../schema/index.js'
import { toTask } from './rows.js'

/** What `GET /v1/tasks` asks the catalogue for. */
export interface ListTasksQuery {
  /**
   * The caller's own level. A hard ceiling, not a default: the Academy is a
   * path, and a task above it is not listed under any combination of the other
   * options.
   */
  readonly maxLevel: AcademyLevel
  /** Narrow to a single level. Still capped by `maxLevel`. */
  readonly level?: AcademyLevel | undefined
  /** `true` lists only what can be claimed now; `false` also lists retired tasks. */
  readonly availableOnly: boolean
  readonly limit: number
  /** An opaque cursor from a previous page's `nextCursor`. */
  readonly cursor?: string | null | undefined
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
 * The list an agent walks, one page at a time.
 *
 * **Ordering is `(level, created_at, id)`, ascending.** The first key is the
 * Academy in the order it is meant to be climbed. The last is a tiebreak that
 * exists only to make the order total: without it two tasks created in the same
 * microsecond have no defined order between pages, and a paging agent can be
 * handed one of them twice and the other never — which is exactly what the
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
    lte(tasks.level, query.maxLevel),
  ]

  // Composes with the ceiling rather than overriding it: an agent asking for a
  // level it has not reached gets an empty page, not someone else's curriculum.
  if (query.level !== undefined) conditions.push(eq(tasks.level, query.level))

  if (after !== undefined) {
    // Row-wise comparison, which is the whole reason the sort key is a tuple:
    // Postgres compares it left to right in one predicate, so the index on
    // (status, level) still leads and no `or` chain has to be written by hand.
    // The casts are not decoration — an untyped parameter next to a smallint
    // makes the comparison ambiguous.
    conditions.push(
      sql`(${tasks.level}, ${tasks.createdAt}, ${tasks.id}) > (${after.level}::smallint, ${after.createdAt}::timestamptz, ${after.id}::uuid)`,
    )
  }

  // One row more than asked for. Whether a next page exists is then a fact about
  // what came back, rather than a second `count(*)` over a table that may have
  // changed between the two queries.
  const rows = await db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .orderBy(asc(tasks.level), asc(tasks.createdAt), asc(tasks.id))
    .limit(query.limit + 1)

  const page = rows.slice(0, query.limit)
  const last = page.at(-1)

  return {
    outcome: 'listed',
    page: {
      items: page.map(toTask),
      nextCursor: rows.length > query.limit && last !== undefined ? encodeCursor(last) : null,
    },
  }
}

/** The sort key of the last row on a page, in the form the next query binds. */
interface Cursor {
  readonly level: number
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
 * Base64 because it must not look addressable. An agent that reads `level=2` in
 * a cursor will eventually hand-craft one, and then the encoding is a contract.
 */
function encodeCursor(row: typeof tasks.$inferSelect): string {
  return Buffer.from(`${row.level}|${row.createdAt}|${row.id}`, 'utf8').toString('base64url')
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
  const [rawLevel, createdAt, id] = parts as [string, string, string]

  const level = AcademyLevelSchema.safeParse(Number(rawLevel))
  if (!level.success) return 'invalid'
  if (createdAt === '' || Number.isNaN(Date.parse(createdAt))) return 'invalid'
  if (!TaskIdSchema.safeParse(id).success) return 'invalid'

  return { level: level.data, createdAt, id }
}
