import {
  CitizenSearchQuerySchema,
  type ApiError,
  type CitizenSearchQuery,
  type CitizenSearchResult,
} from '@kolonie-ai/core'

/**
 * Answering *who here can do this* (`#1067`, `kolonie-docs#413`).
 *
 * ## Its own port, beside `CitizenRecords` rather than inside it
 *
 * `citizens.ts` is a deliberately narrow door — its docblock says there is no
 * method on it that could express *list them*, and `citizens.test.ts` asserts
 * that no collection route exists for any method. Widening it would spend that
 * property to save a file. So the search is a second port with one method, and
 * the reading door keeps saying exactly what it said before.
 *
 * ## And the search is authenticated, where reading a record is not
 *
 * `kolonie.citizens.read` answers a caller presenting nothing, because a handle
 * is something the caller already had. A search is the opposite: it *hands out*
 * handles the caller did not have. The citizens who threw the switch agreed to
 * be an answer to another citizen's question, and a crawler with no credential
 * is not one — so this port is reached from an authenticated tool and there is
 * no unauthenticated route to it.
 */
export interface CitizenSearch {
  /** The handles, alphabetically, and how each matched. */
  find(query: CitizenSearchQuery): Promise<CitizenSearchResult>
}

export type CitizenSearchOutcome =
  | { readonly outcome: 'found'; readonly response: CitizenSearchResult }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/**
 * One question of the three, and never two of them or none.
 *
 * The refusal is here rather than at the schema's edge so it can say what to do
 * instead: an intersection is what a caller asking for two wants, and the
 * honest answer is that it asks twice and intersects the handles itself
 * (`packages/core/src/agent/discovery.ts` argues why the Colony will not).
 */
const oneQuestion: ApiError = {
  code: 'validation_failed',
  message:
    'Name exactly one of `skill`, `capability` or `playbook`. A skill is one the Colony ' +
    'certified; a capability is one a citizen declared; a playbook is one somebody contributed ' +
    'to. To narrow by two, ask twice and keep the handles that appear in both answers.',
}

export async function searchCitizens(
  input: unknown,
  search: CitizenSearch,
): Promise<CitizenSearchOutcome> {
  const query = CitizenSearchQuerySchema.safeParse(input)
  if (!query.success) return { outcome: 'rejected', error: oneQuestion }

  return { outcome: 'found', response: await search.find(query.data) }
}
