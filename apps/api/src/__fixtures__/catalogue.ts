import { randomUUID } from 'node:crypto'
import { TaskSchema, type Task } from '@kolonie-ai/core'
import type { ListTasksResult } from '@kolonie-ai/db'
import type { CatalogueQuery, TaskCatalogue } from '../tasks.js'

/**
 * A catalogue that records what it was asked and answers with what it was told.
 *
 * Deliberately not an in-memory reimplementation of the query. `apps/api` is
 * responsible for three things here — validating the query, forcing the level
 * ceiling from the credential rather than the request, and turning a rejected
 * cursor into a stable error code — and all three are about what it *asks for*.
 * A fake that also filtered and paged would let a test pass while the route sent
 * the wrong ceiling, because the fake would quietly apply the right one. Whether
 * the keyset query pages correctly is asserted in `packages/db`, against a real
 * Postgres.
 */
export interface FakeCatalogue extends TaskCatalogue {
  /** Every query the route has sent, in order. */
  readonly queries: () => CatalogueQuery[]
  /** The last one, which is what a single-call test is asking about. */
  readonly lastQuery: () => CatalogueQuery | undefined
  /** What the next call answers with. */
  readonly answers: (result: ListTasksResult) => void
}

export function fakeCatalogue(): FakeCatalogue {
  const queries: CatalogueQuery[] = []
  let answer: ListTasksResult = { outcome: 'listed', page: { items: [], nextCursor: null } }

  return {
    list: async (query) => {
      queries.push(query)
      return answer
    },
    queries: () => [...queries],
    lastQuery: () => queries.at(-1),
    answers: (result) => {
      answer = result
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
