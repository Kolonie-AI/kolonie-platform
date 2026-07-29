import {
  ListTasksRequestSchema,
  type AgentId,
  type ApiError,
  type FrontierResponse,
  type ListTasksResponse,
} from '@kolonie-ai/core'
import {
  frontier as frontierInDatabase,
  listTasks as listTasksInDatabase,
  type Database,
  type Frontier,
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
  frontier(agentId: AgentId): Promise<Frontier>
}

/** A validated request, plus the agent whose skills decide what is in it. */
export interface CatalogueQuery {
  /**
   * Whose skills the gate is answered from. Taken from the credential, never
   * from the request — the same rule the level ceiling followed before D-030,
   * and the reason this parameter exists at all: it is the difference between a
   * filter and a permission.
   */
  readonly agentId: AgentId
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
  return {
    list: (query) => listTasksInDatabase(db, query),
    frontier: (agentId) => frontierInDatabase(db, { agentId }),
  }
}

/**
 * The tasks this agent may start now, from its own query.
 *
 * The agent id comes from the authenticated credential and never from the
 * request, and the gate is answered from the skills stored against it (D-030).
 * That is the difference between a filter and a permission: every other field
 * here is the caller's preference, and this one is not negotiable no matter what
 * it sends.
 *
 * An empty list is not a refusal and not the end of the Academy — it means
 * nothing is open with the skills held right now. {@link frontier} is where an
 * agent finds out what would open something.
 */
export async function listTasks(
  query: unknown,
  agentId: AgentId,
  catalogue: TaskCatalogue,
): Promise<ListTasksOutcome> {
  const parsed = ListTasksRequestSchema.safeParse(fromQueryString(query))
  if (!parsed.success) {
    return { outcome: 'rejected', error: validationError(parsed.error.issues) }
  }

  const result = await catalogue.list({ ...parsed.data, agentId })

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
 * What this agent could reach with one more skill.
 *
 * A separate call rather than a wider list, which is D-014's division and the
 * reason `GET /v1/tasks` stays narrow: an agent polls the list to pick work and
 * pays for every unreachable row in it on every pass, while it asks this
 * question when it is planning. It takes no arguments beyond the credential —
 * there is nothing here for a caller to get wrong, and nothing to page.
 */
export async function frontier(
  agentId: AgentId,
  catalogue: TaskCatalogue,
): Promise<FrontierResponse> {
  const { skills, entries } = await catalogue.frontier(agentId)
  return { skills: [...skills], entries: [...entries] }
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
