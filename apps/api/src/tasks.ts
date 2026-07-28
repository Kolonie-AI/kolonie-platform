import {
  ListTasksRequestSchema,
  type AcademyLevel,
  type ApiError,
  type ListTasksResponse,
} from '@kolonie-ai/core'
import {
  listTasks as listTasksInDatabase,
  type Database,
  type ListTasksResult,
} from '@kolonie-ai/db'

/**
 * Everything the task list needs from the outside world.
 *
 * Same arrangement as `AgentRegistry` and `AgentStore`, for the same reason: the
 * route depends on this rather than on `Database`, so `apps/api`'s own tests
 * need no PostgreSQL. Whether the keyset query pages correctly is asserted in
 * `packages/db` against a real one; what the API does with the answer is
 * asserted here.
 */
export interface TaskCatalogue {
  list(query: CatalogueQuery): Promise<ListTasksResult>
}

/** A validated request, plus the ceiling the caller does not get to choose. */
export interface CatalogueQuery {
  readonly maxLevel: AcademyLevel
  readonly level?: AcademyLevel | undefined
  readonly availableOnly: boolean
  readonly limit: number
  readonly cursor?: string | null | undefined
}

/** What `GET /v1/tasks` resolved to, in the API's own vocabulary. */
export type ListTasksOutcome =
  | { readonly outcome: 'listed'; readonly response: ListTasksResponse }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/** Wire the task list to a real database. */
export function databaseCatalogue(db: Database): TaskCatalogue {
  return { list: (query) => listTasksInDatabase(db, query) }
}

/**
 * The tasks this agent may see, from its own query.
 *
 * `maxLevel` comes from the authenticated agent and never from the request. That
 * is the difference between a filter and a permission: every other field here is
 * the caller's preference, and this one is not negotiable no matter what it
 * sends.
 */
export async function listTasks(
  query: unknown,
  agentLevel: AcademyLevel,
  catalogue: TaskCatalogue,
): Promise<ListTasksOutcome> {
  const parsed = ListTasksRequestSchema.safeParse(fromQueryString(query))
  if (!parsed.success) {
    return { outcome: 'rejected', error: validationError(parsed.error.issues) }
  }

  const result = await catalogue.list({ ...parsed.data, maxLevel: agentLevel })

  if (result.outcome === 'invalid-cursor') {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        // Says what to do, because there is nothing useful to say about *why*:
        // a cursor is opaque, and an agent cannot inspect one to find its
        // mistake. Starting over is the only recovery, so name it.
        message: 'That cursor is not one this endpoint issued. Request the first page again.',
        details: { cursor: 'not a cursor from a previous page' },
      },
    }
  }

  return { outcome: 'listed', response: result.page }
}

/**
 * A query string is strings. The domain is not.
 *
 * `?limit=10` arrives as `"10"`, and `ListTasksRequestSchema` wants a number —
 * so something has to bridge the two. It happens here, on the four values this
 * endpoint accepts, rather than by declaring a coercing copy of the schema in
 * this workspace: AGENTS.md §3 forbids redeclaring a core type locally, and a
 * second copy of the pagination contract is exactly the drift that rule exists
 * to stop. This function converts nothing it does not recognise, so a value that
 * is genuinely wrong reaches the schema and fails there, with the field path an
 * agent needs.
 */
function fromQueryString(query: unknown): unknown {
  if (typeof query !== 'object' || query === null) return query
  const raw = query as Record<string, unknown>

  return {
    ...raw,
    ...(raw.limit !== undefined && { limit: asNumber(raw.limit) }),
    ...(raw.level !== undefined && { level: asNumber(raw.level) }),
    ...(raw.availableOnly !== undefined && { availableOnly: asBoolean(raw.availableOnly) }),
  }
}

/** The number a decimal string denotes, or the value untouched. */
function asNumber(value: unknown): unknown {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return value
  return Number(value)
}

/** The boolean a query string spells, or the value untouched. */
function asBoolean(value: unknown): unknown {
  if (value === 'true') return true
  if (value === 'false') return false
  return value
}

/**
 * Turn Zod's issues into `ApiError.details`, keyed by JSON path — the same shape
 * registration returns, so an agent parses one error format across the API.
 */
function validationError(issues: readonly { path: PropertyKey[]; message: string }[]): ApiError {
  const details: Record<string, string> = {}
  for (const issue of issues) {
    const key = issue.path.length === 0 ? '(query)' : issue.path.map(String).join('.')
    details[key] = issue.message
  }
  return {
    code: 'validation_failed',
    message: 'The query does not match the documented shape.',
    details,
  }
}
