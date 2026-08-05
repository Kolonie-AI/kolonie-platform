import { randomUUID } from 'node:crypto'
import { TaskSchema, type AgentId, type Task, type TaskId } from '@kolonie-ai/core'
import type { AcademyGraphEntry, Frontier, ListTasksResult } from '@kolonie-ai/db'
import type { CatalogueQuery, TaskCatalogue } from '../tasks.js'

/**
 * A catalogue that records what it was asked and answers with what it was told.
 *
 * Deliberately not an in-memory reimplementation of the query. `apps/api` is
 * responsible for three things here — validating the query, taking the subject
 * from the credential rather than the request, and turning a rejected cursor
 * into a stable error code — and all three are about what it *asks for*. A fake
 * that also filtered and paged would let a test pass while the route asked on
 * behalf of the wrong agent, because the fake would quietly gate on the right
 * one. Whether the keyset query pages correctly, and whether the skill gate
 * selects the right rows, is asserted in `packages/db` against a real Postgres.
 */
export interface FakeCatalogue extends TaskCatalogue {
  /** Every query the route has sent, in order. */
  readonly queries: () => CatalogueQuery[]
  /** The last one, which is what a single-call test is asking about. */
  readonly lastQuery: () => CatalogueQuery | undefined
  /** What the next call answers with. */
  readonly answers: (result: ListTasksResult) => void
  /** Every agent the frontier has been asked about, in order. */
  readonly frontierQueries: () => AgentId[]
  /** What the next frontier call answers with. */
  readonly answersFrontier: (result: Frontier) => void
  /** Every single-task read the route has sent, in order. */
  readonly reads: () => { taskId: TaskId; hints: boolean }[]
  /** The last one, which is what a single-call test is asking about. */
  readonly lastRead: () => { taskId: TaskId; hints: boolean } | undefined
  /** What the next read answers with. `undefined` is "no such task". */
  readonly answersRead: (task: Task | undefined) => void
  /** How many times the public graph has been read. */
  readonly graphReads: () => number
  /**
   * What the next graph read answers with, as full `Task` values.
   *
   * Full tasks rather than published nodes, because the projection down to what
   * a stranger may see is the route's job and this fixture must be able to hand
   * it a task carrying fields the endpoint has to drop — a `hints` array is the
   * case that matters, and a fake that had already dropped it would let that
   * test pass without asserting anything.
   */
  readonly answersGraph: (tasks: readonly Task[]) => void
  /**
   * The same, for a test that cares which nodes somebody has cleared (`#193`).
   *
   * Kept beside `answersGraph` rather than replacing it: almost every test of
   * this route is about the shape and not about the flag, and making all of them
   * spell out `cleared: false` would bury the two that are.
   */
  readonly answersGraphEntries: (entries: readonly AcademyGraphEntry[]) => void
}

export function fakeCatalogue(): FakeCatalogue {
  const queries: CatalogueQuery[] = []
  const frontierQueries: AgentId[] = []
  const reads: { taskId: TaskId; hints: boolean }[] = []
  let answer: ListTasksResult = { outcome: 'listed', page: { items: [], nextCursor: null } }
  let frontierAnswer: Frontier = { skills: [], entries: [] }
  let readAnswer: Task | undefined = undefined
  let graphAnswer: readonly AcademyGraphEntry[] = []
  let graphReads = 0

  return {
    graph: async () => {
      graphReads += 1
      return graphAnswer
    },
    graphReads: () => graphReads,
    answersGraph: (tasks) => {
      graphAnswer = tasks.map((task) => ({ task, cleared: false }))
    },
    answersGraphEntries: (entries) => {
      graphAnswer = entries
    },
    list: async (query) => {
      queries.push(query)
      return answer
    },
    frontier: async (agentId) => {
      frontierQueries.push(agentId)
      return frontierAnswer
    },
    read: async (query) => {
      reads.push({ taskId: query.taskId, hints: query.hints })
      return readAnswer
    },
    queries: () => [...queries],
    lastQuery: () => queries.at(-1),
    answers: (result) => {
      answer = result
    },
    frontierQueries: () => [...frontierQueries],
    answersFrontier: (result) => {
      frontierAnswer = result
    },
    reads: () => [...reads],
    lastRead: () => reads.at(-1),
    answersRead: (task) => {
      readAnswer = task
    },
  }
}

/**
 * A task, valid by construction.
 *
 * Parsed rather than cast, for the same reason the other fixtures parse: a
 * fixture that can produce a shape core would reject makes a test believe it
 * checked something it did not.
 */
export function aTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString()
  return TaskSchema.parse({
    id: randomUUID(),
    type: 'profile-complete',
    // An Academy task, which is what every fixture here stands in for — and
    // therefore one that pays reputation and no coins (#43).
    kind: 'academy',
    requires: [],
    suggests: [],
    grants: ['profile'],
    // No account kinds by default: naming one is the exception, and a fixture
    // that named one everywhere would make the resolution look mandatory (#151).
    requiresAccounts: [],
    minReputation: 0,
    // No activity window: an Academy rung is for everybody whenever they arrive,
    // and a quest that says nothing about activity narrows nothing (#227).
    minActivityDays: null,
    distinctOperators: false,
    // Obstacles published, which is the default and is what an Academy rung has
    // always done through the same briefing machinery — the Colony is its own
    // sponsor and has nothing to protect from the next candidate (#370).
    publishObstacles: true,
    recommendedOrder: 0,
    title: 'Complete your profile',
    description: 'Fill in the fields that make you a citizen rather than a row.',
    instructions: 'Set at least one capability on your profile.',
    reward: { credits: 0, reputation: 1 },
    // An Academy rung is for everybody, once each, forever (#175): no capacity,
    // no expiry, and open to candidates — which is what a rung has to be, since
    // clearing one is how an agent stops being one.
    slots: null,
    expiresAt: null,
    audience: 'candidates',
    rejectionReason: null,
    // What almost every task answers: assistance is acceptable for reaching the
    // outside world, and only the Colony's own work refuses it (`#39`).
    assistanceAllowed: true,
    prerequisiteTaskIds: [],
    timeoutHours: 24,
    status: 'active',
    createdBy: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  })
}
