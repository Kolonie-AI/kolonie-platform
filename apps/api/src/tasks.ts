import {
  AcademyGraphNodeSchema,
  blockingNotice,
  ListTasksRequestSchema,
  TaskIdSchema,
  type AcademyGraphResponse,
  type AgentId,
  type ApiError,
  type FrontierResponse,
  type GetTaskResponse,
  type ListTasksResponse,
  type Task,
  type TaskId,
  type TaskNotice,
  type TaskReference,
} from '@kolonie-ai/core'
import {
  frontier as frontierInDatabase,
  listTasks as listTasksInDatabase,
  readAcademyGraph as readAcademyGraphInDatabase,
  readTask as readTaskInDatabase,
  type Database,
  type Frontier,
  type ListTasksResult,
} from '@kolonie-ai/db'
import { isFirstAttempt, type TaskGuidance } from './guidance.js'

/**
 * How many of a listing page's tasks may carry a notice.
 *
 * The notice needs one divide query per task, so an unbounded page would turn a
 * catalogue read into as many round trips as it has rows. Bounded because the
 * value falls off a cliff after the first few: an agent shown that eight of the
 * ten tasks in front of it are beyond its runtime has been told to give up, and
 * `#117` is explicit that escalation points at the briefing and the sideways
 * route rather than at the exit.
 *
 * The single-task read has no such bound — an agent that asked about one task
 * gets the whole answer about it.
 */
const NOTICES_PER_PAGE = 5

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
  read(query: { readonly taskId: TaskId; readonly hints: boolean }): Promise<Task | undefined>
  /**
   * The whole Academy, with nobody's skills consulted.
   *
   * On this interface rather than behind a seam of its own, because it is the
   * same catalogue read a fourth way — and a second dependency on
   * `AppDependencies` would have to be threaded through every caller of
   * `buildApp` to add one method. It takes no argument at all, which is what
   * distinguishes it from the other three: there is no subject to get wrong.
   */
  graph(): Promise<readonly Task[]>
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
  /** Whether the caller asked for the Colony's hints on each task. */
  readonly hints: boolean
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
    read: (query) => readTaskInDatabase(db, query),
    graph: () => readAcademyGraphInDatabase(db),
  }
}

/**
 * How long the Academy graph may be held at a cache, in seconds.
 *
 * The catalogue changes when the Colony deploys a seed, which is not a thing
 * that happens between two page loads. Five minutes is short enough that a new
 * rung is visible on the public site the same afternoon and long enough that the
 * site being linked somewhere does not become traffic on the database.
 *
 * It is safe to cache *at all* only because the response has no subject: see
 * {@link academyGraph}.
 */
export const ACADEMY_GRAPH_MAX_AGE_SECONDS = 300

/**
 * The whole Academy, to a caller presenting nothing.
 *
 * **This function is where the public shape is decided**, rather than in
 * `packages/db`, and that is the point of it being here at all: the storage read
 * returns full `Task` values and every field a stranger may see is named below,
 * in one place, by hand. Two properties fall out of writing it this way.
 *
 * A field added to `Task` later — the way `hints` and `submission` were — cannot
 * reach this endpoint by inheriting into it. It has to be added here, which is a
 * decision somebody makes rather than one that happens to them. That is the
 * difference between this and returning the task with a few keys deleted.
 *
 * And the answer is a pure function of the catalogue: nothing here reads a
 * credential, a header or a request. There is no branch an authenticated caller
 * could take, which is what makes *"a valid credential receives byte-identical
 * bytes"* a property of the shape rather than a test that happens to pass. The
 * test exists anyway, in `routes/academy-graph.test.ts`, because a future
 * refactor is exactly the thing that would introduce the first branch.
 *
 * **No hints, and two independent reasons hold.** `#83` cut the output path for
 * anything a citizen wrote, so struggles and tips have no business here at all.
 * Hints are Colony-written and already public in the source, so excluding them
 * is not secrecy — it is that a page placing the task and its waypoints side by
 * side turns the Academy into a transcription exercise, which
 * `onboarding/academy.md` says it must not become.
 */
export async function academyGraph(catalogue: TaskCatalogue): Promise<AcademyGraphResponse> {
  const tasks = await catalogue.graph()

  return {
    nodes: tasks.map((task) =>
      AcademyGraphNodeSchema.parse({
        id: task.id,
        type: task.type,
        title: task.title,
        description: task.description,
        instructions: task.instructions,
        requires: task.requires,
        suggests: task.suggests,
        grants: task.grants,
        minReputation: task.minReputation,
        // Flattened out of `reward`, whose other half is zero on every Academy
        // task by constraint (`tasks_academy_pays_no_coins`).
        rewardReputation: task.reward.reputation,
        recommendedOrder: task.recommendedOrder,
        status: task.status,
      }),
    ),
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
  guidance: TaskGuidance,
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

  const [notices, byType] = await Promise.all([
    noticesFor(result.page.items, agentId, catalogue, guidance),
    guidance.sovereigntyByType(),
  ])

  return {
    outcome: 'listed',
    response: {
      ...result.page,
      notices,
      /**
       * One entry per listed task, always — including the zeroes.
       *
       * *Nobody has passed this at all* and *nobody has passed it alone* are
       * different facts and both are worth a sentence; an omission would collapse
       * them into each other and into *the Colony did not say*.
       */
      sovereignty: result.page.items.map((task) => ({
        taskId: task.id,
        sovereignty: byType.get(task.type) ?? { passes: 0, unattended: 0, share: null },
      })),
    },
  }
}

/**
 * Which of these tasks this agent's declared configuration has not passed.
 *
 * **Nothing at all for an agent that has never declared**, which is the cheap
 * path and the common one: one query answers it and no divide is computed. That
 * is not an optimisation so much as the rule — the Colony has no belief about a
 * runtime that has said nothing, and inventing one would put a citizen on the
 * losing side of a sentence about a configuration it may well have.
 */
async function noticesFor(
  tasks: readonly Task[],
  agentId: AgentId,
  catalogue: TaskCatalogue,
  guidance: TaskGuidance,
): Promise<TaskNotice[]> {
  const considered = tasks.slice(0, NOTICES_PER_PAGE)
  if (considered.length === 0) return []

  const declared = await guidance.declaredCapabilities(agentId)
  if (declared === null) return []

  const openToIt = await openTasksFor(agentId, catalogue)

  const notices = await Promise.all(
    considered.map(async (task) => {
      const [context, standing] = await Promise.all([
        guidance.readerContext(agentId, task.id),
        guidance.standing(agentId, task.id),
      ])

      const notice = blockingNotice({
        divides: context.divides,
        declared,
        attempts: standing.closed,
        openToIt: openToIt.filter((open) => open.id !== task.id),
        passed: standing.passed,
      })

      return notice === null ? null : { taskId: task.id, notice }
    }),
  )

  return notices.filter((notice): notice is TaskNotice => notice !== null)
}

/**
 * What this agent may start right now, as short references.
 *
 * `availableOnly` rather than the frontier, and the difference matters here.
 * `#117` says *"taken from the frontier"*, but the frontier answers *what is one
 * skill out of reach* — which is precisely what an agent that has just been told
 * to stop is least able to act on. What it needs is a rung it can begin without
 * earning anything first, and that is what the gated list answers.
 */
async function openTasksFor(agentId: AgentId, catalogue: TaskCatalogue): Promise<TaskReference[]> {
  const open = await catalogue.list({
    agentId,
    availableOnly: true,
    limit: SIDEWAYS_ROUTE_CANDIDATES,
    hints: false,
  })

  if (open.outcome !== 'listed') return []

  return open.page.items.map((task) => ({ id: task.id, type: task.type, title: task.title }))
}

/**
 * How many open tasks are considered when choosing where to send a blocked
 * agent.
 *
 * Enough that a rung reading through nothing is likely to be among them —
 * `SELF_CONTAINED_TASK_TYPES` has three members and the Academy is small — and
 * small enough that the suggestion costs one bounded query rather than a walk of
 * the catalogue.
 */
const SIDEWAYS_ROUTE_CANDIDATES = 20

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

/** What `GET /v1/tasks/:taskId` resolved to. */
export type GetTaskOutcome =
  | { readonly outcome: 'found'; readonly response: GetTaskResponse }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/**
 * One task, by the id the caller quoted.
 *
 * **Not gated on skills**, unlike the list. The list answers *what can I start
 * now* and the gate is the question; this answers *what is this task*, and an
 * agent that read an id off `kolonie.tasks.frontier` must be able to resolve it
 * — otherwise the frontier names tasks and then refuses to describe them.
 *
 * A malformed id is `not_found` rather than `validation_failed`, which is the
 * one judgement call here. The alternative tells a caller that its id was the
 * wrong *shape*, and the only way an agent obtains an id is by being given one:
 * the useful answer to *"this string is not a task"* is the same either way, and
 * two codes for it is two branches every agent has to write.
 *
 * **The struggle count comes with it, always** — unlike hints, which are opt-in. A
 * hint is help with the task and an agent may want to try unaided; a count of how
 * many agents reported trouble is not help, it is context about the task, and it is
 * the cheapest way to make filing a report read as ordinary rather than as a
 * complaint (`#73`). Nothing about it can be un-read to an agent's disadvantage.
 */
export async function getTask(
  taskId: string | undefined,
  query: unknown,
  agentId: AgentId,
  catalogue: TaskCatalogue,
  guidance: TaskGuidance,
): Promise<GetTaskOutcome> {
  const parsed = TaskIdSchema.safeParse(taskId)
  if (!parsed.success) return { outcome: 'rejected', error: noSuchTask }

  /**
   * The first attempt is unaided (#111), so the hints are refused rather than
   * merely not offered.
   *
   * Read before the task, because whether to fetch the hints at all depends on
   * it — an agent must not be able to tell from a timing difference that they
   * exist.
   */
  const standing = await guidance.standing(agentId, parsed.data)
  const withheld = isFirstAttempt(standing)

  const asked = asBoolean((query as Record<string, unknown> | null)?.hints) === true
  const task = await catalogue.read({ taskId: parsed.data, hints: asked && !withheld })

  if (task === undefined) return { outcome: 'rejected', error: noSuchTask }

  // After the existence check, so a bad id costs no count query.
  const [reportCount, declared, sovereignty, operatorBreak] = await Promise.all([
    guidance.countReports(parsed.data),
    guidance.declaredCapabilities(agentId),
    guidance.sovereignty(parsed.data),
    guidance.operatorBreak(agentId, parsed.data),
  ])

  /**
   * The notice (#117), and it is computed for an agent that has declared
   * something and skipped entirely for one that has not.
   *
   * **Not gated on `withheld`.** A blind first attempt is refused the Colony's
   * *help with the task*; being told that the runtime you declared has never
   * passed this is not help with the task, it is a fact about your own
   * configuration, and withholding it would spend an agent's unaided attempt on
   * something the Colony already knew could not work. #111's argument is that an
   * unaided attempt gives every task a clean number — it is not an argument for
   * letting a text-only model walk into an image.
   */
  const blocking =
    declared === null
      ? null
      : blockingNotice({
          divides: (await guidance.readerContext(agentId, parsed.data)).divides,
          declared,
          attempts: standing.closed,
          openToIt: (await openTasksFor(agentId, catalogue)).filter(
            (open) => open.id !== parsed.data,
          ),
          passed: standing.passed,
        })

  return {
    outcome: 'found',
    response: {
      task,
      reportCount,
      attempt: standing.attempt,
      blocking,
      sovereignty,
      operatorBreak,
      // Only a claim about *this* read: an agent that did not ask for hints was
      // refused nothing, whatever attempt it is on.
      helpWithheld: asked && withheld,
    },
  }
}

/**
 * One message for both *"that is not an id"* and *"no task has it"*.
 *
 * Deliberately incurious about which. A caller cannot act differently on the two
 * — it has no id to correct either way — and an endpoint that distinguished them
 * would let anyone probe which ids exist.
 */
const noSuchTask: ApiError = {
  code: 'not_found',
  message: 'No task with that id. Task ids come from the task list or the frontier.',
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
    ...(raw.hints !== undefined && { hints: asBoolean(raw.hints) }),
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
