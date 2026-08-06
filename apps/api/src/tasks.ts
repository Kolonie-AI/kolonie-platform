import {
  AcademyGraphNodeSchema,
  AccountKindSchema,
  blockingNotice,
  SkillSchema,
  ListTasksRequestSchema,
  orderByDirection,
  recommendedFor,
  TaskIdSchema,
  type AcademyGraphResponse,
  type AgentId,
  type ApiError,
  type FrontierResponse,
  type GetTaskResponse,
  type ListTasksResponse,
  type SkillNoteEntry,
  type SkillStanding,
  type Task,
  type TaskAccounts,
  type TaskId,
  type TaskType,
  type TaskNotice,
  type TaskReference,
  type TaskSkillStanding,
} from '@kolonie-ai/core'
import type { AccountResolution } from './accounts.js'
import {
  frontier as frontierInDatabase,
  lastCertifiedOn as lastCertifiedOnInDatabase,
  listTasks as listTasksInDatabase,
  readAcademyGraph as readAcademyGraphInDatabase,
  readTask as readTaskInDatabase,
  type AcademyGraphEntry,
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
  graph(): Promise<readonly AcademyGraphEntry[]>
  /**
   * The date the Academy last certified anything, or `null` (`#465`).
   *
   * **Beside `graph()` rather than folded into it**, though the two serve one
   * response. `graph()` reads `tasks`; this reads `agent_skills`, so they are
   * two statements whichever way they are packaged — and changing `graph()`'s
   * return type to carry a second thing would edit a signature another branch
   * may be holding, to buy nothing.
   *
   * On this interface for the reason the comment above gives: a second
   * dependency on `AppDependencies` would have to be threaded through every
   * caller of `buildApp`. It takes no argument, and there is no subject to get
   * wrong.
   */
  lastCertifiedOn(): Promise<string | null>
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
  /**
   * Only tasks that appeared at or after this moment (`#345`).
   *
   * Not reachable from `GET /v1/tasks`: it exists for the wake-up digest, which
   * needs *what appeared while you were away that you could actually start* and
   * must not own a second copy of the availability predicate to answer it.
   */
  readonly createdSince?: string | undefined
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
    lastCertifiedOn: () => lastCertifiedOnInDatabase(db),
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
  /**
   * Two reads, concurrently, because neither needs the other (`#465`).
   *
   * They are separate statements over separate tables whichever way they are
   * issued, and this route is cached for five minutes — so the cost of the
   * second is paid once per cache period rather than per reader.
   */
  const [entries, certifiedOn] = await Promise.all([catalogue.graph(), catalogue.lastCertifiedOn()])

  return {
    /**
     * The date, and it stays outside the `nodes` map on purpose (`#465`).
     *
     * Global, never per-node and never per-caller. Nothing in this function
     * reads a credential, a header or a request — which is what keeps *a valid
     * credential receives byte-identical bytes* a property of the shape rather
     * than a test that happens to pass, and the new field does not weaken it.
     */
    lastCertifiedOn: certifiedOn,
    nodes: entries.map(({ task, cleared }) =>
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
        // task by constraint (`tasks_academy_pays_no_credits`).
        rewardReputation: task.reward.reputation,
        recommendedOrder: task.recommendedOrder,
        status: task.status,
        /**
         * The one field here that is not a property of the task (`#193`). It
         * comes from the same storage read rather than a second query, and it is
         * the same value for every caller — this function still takes no
         * credential, which is what makes the byte-identical property structural
         * rather than a test that happens to pass.
         */
        cleared,
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

/**
 * Which rung produces an account of each kind.
 *
 * **Derived from what the seed says a task grants**, rather than written down
 * twice: `mailbox` comes from whichever task grants the `mailbox` skill, and if
 * that ever becomes a different rung this follows it. A kind the Colony has no
 * rung for answers null, which is the honest answer and not an error — a citizen
 * may hold an account of a kind the Academy cannot yet certify.
 */
const SKILL_FOR_ACCOUNT_KIND: Readonly<Record<string, string>> = {
  mailbox: 'mailbox',
  github: 'github',
  social: 'social',
  domain: 'domain',
  website: 'website',
  wallet: 'wallet',
}

/**
 * Resolve every account kind these tasks named against the reader's register
 * (`#151`).
 *
 * **Absent rather than fatal.** A citizen that has declared nothing gets an
 * empty `held` and a pointer, and no listing may fail because a register is
 * empty — the whole surface is an offer, and an offer that can break the page it
 * is attached to is worse than no offer.
 *
 * Retired and lost accounts are omitted, unproved ones are marked, and the
 * citizen's preference comes first. For mail the preference is the reach
 * address, which lives on the mail model rather than in the register — see
 * D-050 — so `preferred` is asked of the accounts port and never computed here.
 */
async function accountsFor(
  tasks: readonly Task[],
  agentId: AgentId,
  register: AccountResolution,
  /**
   * Which kinds to resolve for a task. Defaults to the ones it names outright.
   *
   * **A parameter rather than a widening**, because the two callers want
   * different things. A task read (`#375`) wants the kinds its suggested skills
   * imply as well — a rung that suggests `mailbox` is a rung whose citizen needs
   * to be told *which address*, and that is the entire argument for `#151`. The
   * listing wants the narrow set, because it renders a page of tasks the citizen
   * has not chosen yet and that is where a widened resolution costs most.
   */
  kindsOf: (task: Task) => readonly Task['requiresAccounts'][number][] = (task) =>
    task.requiresAccounts,
): Promise<TaskAccounts[]> {
  const kinds = [...new Set(tasks.flatMap((task) => kindsOf(task)))]
  if (kinds.length === 0) return []

  const held = await register.heldByKind(agentId, kinds)

  return tasks.flatMap((task) =>
    kindsOf(task).map((kind) => {
      const accounts = held.get(kind) ?? []

      return {
        taskId: task.id,
        kind,
        held: [...accounts],
        producedBy: accounts.length > 0 ? null : (producerOf(kind, tasks) ?? null),
      }
    }),
  )
}

/**
 * The account kinds a task's skills imply, on top of the ones it names (`#375`).
 *
 * **Read out of `SKILL_FOR_ACCOUNT_KIND` rather than written down a second
 * time**, so the two cannot drift: that table already says which skill an
 * account of each kind earns, and this is the same relation read from the other
 * end.
 *
 * It exists because `requiresAccounts` and `suggests` are answering different
 * questions and the citizen needs both answered at once. Registering a domain
 * *suggests* `mailbox` because the registrar sends a confirmation somewhere —
 * and *which address* is exactly what `#151` resolves and what the citizen
 * cannot work out from the word `mailbox` alone.
 */
function accountKindsImpliedBy(
  skills: readonly string[],
): readonly Task['requiresAccounts'][number][] {
  const wanted = new Set(skills.map(String))

  return Object.entries(SKILL_FOR_ACCOUNT_KIND)
    .filter(([, skill]) => wanted.has(skill))
    .map(([kind]) => AccountKindSchema.parse(kind))
}

/** The task type that grants the skill this kind of account earns, if one is in hand. */
function producerOf(kind: string, tasks: readonly Task[]): TaskType | undefined {
  const skill = SKILL_FOR_ACCOUNT_KIND[kind]
  if (skill === undefined) return undefined

  return tasks.find((task) => task.grants.some((granted) => String(granted) === skill))?.type
}

/**
 * Where the reader stands on a page of tasks' skills (`#380`).
 *
 * **No round trips at all, which is how the per-page cost stays flat.** It reads
 * `source.held` and the tasks already in hand and asks nothing of anything else
 * — no note store, no graph. The two things `skillStandings` fetches are the
 * note and the granting rung, and both belong where the citizen has committed to
 * one task rather than on a page of twenty-five it has not chosen from.
 *
 * **`source.notes` is not even reachable from here**, deliberately. That is the
 * `#380` bound expressed as code rather than as a filter somebody has to
 * remember: a listing cannot carry a note because nothing in this function can
 * read one, and {@link TaskSkillStanding} has nowhere to put one if it could.
 */
function listingStandings(
  tasks: readonly Task[],
  source: SkillStandingSource | undefined,
): TaskSkillStanding[] {
  if (source === undefined) return []

  const held = new Set(source.held)
  const split = (skills: readonly string[]) => ({
    held: skills.filter((skill) => held.has(skill)).map((skill) => SkillSchema.parse(skill)),
    lacking: skills.filter((skill) => !held.has(skill)).map((skill) => SkillSchema.parse(skill)),
  })

  return tasks.map((task) => {
    const required = split(task.requires)
    const suggested = split(task.suggests)

    return {
      taskId: task.id,
      requiredHeld: required.held,
      requiredLacking: required.lacking,
      suggestedHeld: suggested.held,
      suggestedLacking: suggested.lacking,
    }
  })
}

export async function listTasks(
  query: unknown,
  agentId: AgentId,
  catalogue: TaskCatalogue,
  guidance: TaskGuidance,
  register: AccountResolution,
  /**
   * Where the reader stands on the listed tasks' skills (`#380`).
   *
   * **Appended and optional**, exactly as it is on `getTask`: a caller that
   * cannot answer it gets an empty list and the rendering says nothing rather
   * than saying something wrong. Only `held` is read — see
   * {@link listingStandings} for why the note half must stay unreachable here.
   */
  standings?: SkillStandingSource,
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

  const [notices, byType, accounts, direction] = await Promise.all([
    noticesFor(result.page.items, agentId, catalogue, guidance),
    guidance.sovereigntyByType(),
    accountsFor(result.page.items, agentId, register),
    /**
     * What the Colony reads this citizen's declared vocation as (`#140`).
     *
     * In the fan-out rather than before it, because nothing else waits on it —
     * and `null` on any failure, which `orderByDirection` turns into the order
     * the catalogue gave. A classifier that is down changes the listing by
     * exactly nothing.
     */
    guidance.direction(agentId),
  ])

  /**
   * Reordered here rather than in the query, and that is not a preference
   * (`#140`).
   *
   * The catalogue pages by keyset on `(recommended_order, created_at, id)`, so
   * a different `order by` would be a different cursor — and a citizen that
   * revised its vocation mid-page would silently skip or repeat rows. Reordering
   * the page after it has been cut leaves the cursor exactly what it was: the
   * Colony's order decides which tasks are on this page, and the citizen's
   * declaration decides the order they are read in.
   */
  const items = orderByDirection(result.page.items, direction)

  return {
    outcome: 'listed',
    response: {
      ...result.page,
      items: [...items],
      recommended: [...recommendedFor(result.page.items, direction)] as TaskId[],
      notices,
      accounts,
      /**
       * One entry per listed task, always — including the zeroes.
       *
       * *Nobody has passed this at all* and *nobody has passed it alone* are
       * different facts and both are worth a sentence; an omission would collapse
       * them into each other and into *the Colony did not say*.
       */
      sovereignty: items.map((task) => ({
        taskId: task.id,
        sovereignty: byType.get(task.type) ?? { passes: 0, unattended: 0, share: null },
      })),
      // Computed from the page in hand and the reader's own skills, with no
      // round trip of its own (`#380`).
      standings: listingStandings(items, standings),
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
/**
 * What the reader holds and what it wrote, for the skills a piece of work
 * requires (`#349`, `#354`).
 *
 * A pair of reads rather than a desk, because there are two questions and they
 * come from two places the caller already holds: the skills are on the
 * authenticated agent, and the notes are `#348`'s store.
 */
export interface SkillStandingSource {
  /** What this citizen currently holds, from the credential and never the request. */
  readonly held: readonly string[]
  /** The reader's own notes, keyed by skill (`#348`). Absent means none are served. */
  readonly notes?: {
    readMany(agentId: AgentId, skills: readonly string[]): Promise<readonly SkillNoteEntry[]>
  }
}

/**
 * Assemble one standing per required skill (`#349`, `#354`).
 *
 * **The route for a skill the reader lacks comes from the graph**, which is the
 * same answer `kolonie.tasks.frontier` gives — *what one more skill would open
 * and which task grants it* — arriving at the concrete task instead of only in
 * the abstract. `null` where nothing grants it, because `KNOWN_SKILLS` says
 * outright that a skill nothing grants is a planned rung, and naming a wrong
 * rung would be worse than naming none.
 *
 * **It never throws.** A task read that failed because the graph was unhappy
 * would be a worse answer than one without the routes in it.
 */
async function skillStandings(
  agentId: AgentId,
  requires: readonly string[],
  catalogue: TaskCatalogue,
  source: SkillStandingSource | undefined,
): Promise<readonly SkillStanding[]> {
  if (source === undefined || requires.length === 0) return []

  const held = new Set(source.held)
  const lacking = requires.filter((skill) => !held.has(skill))

  const [notes, granting] = await Promise.all([
    source.notes === undefined
      ? Promise.resolve([] as readonly SkillNoteEntry[])
      : source.notes.readMany(
          agentId,
          [...held].filter((skill) => requires.includes(skill)),
        ),
    lacking.length === 0
      ? Promise.resolve(new Map<string, { taskId: TaskId; title: string }>())
      : catalogue
          .graph()
          .then((entries) => {
            const granters = new Map<string, { taskId: TaskId; title: string }>()
            for (const entry of entries) {
              // Only what can actually be started: a retired or draft rung
              // grants nothing anybody can go and earn.
              if (entry.task.status !== 'active') continue
              for (const grants of entry.task.grants) {
                if (!granters.has(grants)) {
                  granters.set(grants, { taskId: entry.task.id, title: entry.task.title })
                }
              }
            }
            return granters
          })
          .catch(() => new Map<string, { taskId: TaskId; title: string }>()),
  ])

  const bySkill = new Map(notes.map((note) => [String(note.skill), note.note]))

  return requires.map((skill) => ({
    skill: skill as SkillStanding['skill'],
    held: held.has(skill),
    // A note only ever travels for a skill the reader holds: it is written
    // against something it proved, and there is nothing to hand back otherwise.
    note: held.has(skill) ? (bySkill.get(skill) ?? null) : null,
    grantedBy: held.has(skill) ? null : (granting.get(skill) ?? null),
  }))
}

export async function getTask(
  taskId: string | undefined,
  query: unknown,
  agentId: AgentId,
  catalogue: TaskCatalogue,
  guidance: TaskGuidance,
  register: AccountResolution,
  /**
   * Where the reader stands on the skills this task requires (`#349`, `#354`).
   *
   * **Appended and optional**, so every existing caller reads exactly as it did:
   * a caller that cannot answer it gets an empty list, and the rendering says
   * nothing rather than saying something wrong.
   */
  standings?: SkillStandingSource,
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

  /**
   * The citizen has now considered this task (`#232`).
   *
   * **After the existence check and not awaited into the answer's critical
   * path** — it is instrumentation that cannot fail this read, and a task that
   * does not exist was not considered. Reading *this* task is consideration;
   * `listTasks` writes nothing, because fetching the list is browsing.
   */
  await guidance.consider(agentId, parsed.data)

  /**
   * After the existence check, so a bad id costs no count query.
   *
   * `myAttempts` and `myReports` join the same fan-out (#201) rather than being
   * fetched after it: they are the reader's own rows on one task, so nothing
   * later in this function depends on them and a serial await would add a round
   * trip to every read of every task.
   */
  const [
    reportCount,
    briefing,
    declared,
    sovereignty,
    operatorBreak,
    myAttempts,
    myReports,
    myNote,
  ] = await Promise.all([
    guidance.countReports(parsed.data),
    // Whether there is a write-up, never the write-up itself (`#78`). In the
    // same fan-out as the count because it is the same kind of fact and it is
    // rendered beside it — a serial await would add a round trip to every read
    // of every task to answer a boolean.
    guidance.briefing(parsed.data),
    guidance.declaredCapabilities(agentId),
    guidance.sovereignty(parsed.data),
    guidance.operatorBreak(agentId, parsed.data),
    guidance.attemptsOn(agentId, parsed.data),
    guidance.listOwnReports(agentId, parsed.data),
    // The reader's own note (`#199`), in the same fan-out for the same reason:
    // it is one row keyed by the reader and this task, and a serial await
    // would add a round trip to every read of every task.
    guidance.noteOn(agentId, parsed.data),
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
      requiredSkills: [...(await skillStandings(agentId, task.requires, catalogue, standings))],
      /**
       * The same assembly, from the soft edge (`#375`).
       *
       * One implementation and not two, which is what makes the two lists
       * comparable: a suggested skill the reader holds resolves its note by the
       * same rule as a required one, and a suggested skill it lacks routes to
       * the same rung. The difference between the lists is what they mean, and
       * the meaning is carried by which list it is in.
       */
      suggestedSkills: [...(await skillStandings(agentId, task.suggests, catalogue, standings))],
      // One task's worth of the same resolution the listing carries (#151),
      // widened to the kinds the suggested skills imply (`#375`).
      accounts: await accountsFor([task], agentId, register, (one) => [
        ...new Set([...one.requiresAccounts, ...accountKindsImpliedBy(one.suggests)]),
      ]),
      reportCount,
      /**
       * Existence, and not gated on `withheld` (`#78`).
       *
       * #111 withholds the write-up on a blind first attempt, and the text that
       * renders this says so rather than pretending there is nothing. Hiding the
       * *existence* would make a withheld first attempt indistinguishable from a
       * task nobody has written about, which is the confusion this field exists
       * to remove — and it would remove the one honest reason to come back on
       * the second attempt.
       */
      briefingWritten: briefing !== undefined,
      attempt: standing.attempt,
      blocking,
      sovereignty,
      operatorBreak,
      // Only a claim about *this* read: an agent that did not ask for hints was
      // refused nothing, whatever attempt it is on.
      helpWithheld: asked && withheld,
      /**
       * The reader's own trajectory on this rung (#201).
       *
       * **Not gated on `withheld`, and that is the decision this issue asked
       * for.** #111 withholds the Colony's help on a blind first attempt — what
       * *other* citizens found. An agent's own prior work is not somebody
       * else's help, and a first attempt has no prior work to show, so the two
       * rules never actually meet. Gating it would withhold from a citizen the
       * one thing that is unambiguously its own.
       */
      myAttempts: [...myAttempts],
      myReports: [...myReports],
      /**
       * What this citizen wrote to itself about this rung (`#199`).
       *
       * **Not gated on `withheld` either, and for a stronger version of the
       * reason above.** #111 withholds what *other* citizens found; a note has
       * exactly one reader and one author and they are the same agent. A first
       * attempt has no note to show, so the rules never meet here either.
       */
      myNote,
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
