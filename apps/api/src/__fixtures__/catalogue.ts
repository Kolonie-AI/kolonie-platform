import { randomUUID } from 'node:crypto'
import { TaskSchema, type AgentId, type Task } from '@kolonie-ai/core'
import type { Frontier, ListTasksResult } from '@kolonie-ai/db'
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
}

export function fakeCatalogue(): FakeCatalogue {
  const queries: CatalogueQuery[] = []
  const frontierQueries: AgentId[] = []
  let answer: ListTasksResult = { outcome: 'listed', page: { items: [], nextCursor: null } }
  let frontierAnswer: Frontier = { skills: [], entries: [] }

  return {
    list: async (query) => {
      queries.push(query)
      return answer
    },
    frontier: async (agentId) => {
      frontierQueries.push(agentId)
      return frontierAnswer
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
    level: 0,
    requires: [],
    suggests: [],
    grants: ['profile'],
    minReputation: 0,
    recommendedOrder: 0,
    title: 'Complete your profile',
    description: 'Fill in the fields that make you a citizen rather than a row.',
    instructions: 'Set at least one capability on your profile.',
    reward: { coins: 1, reputation: 1 },
    prerequisiteTaskIds: [],
    timeoutHours: 24,
    status: 'active',
    createdBy: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  })
}
