import {
  AccountProviderSchema,
  AddWishSchema,
  credentialFinding,
  credentialRefusalMessage,
  type AgentId,
  type ApiError,
  type Wish,
  type WishAuthor,
} from '@kolonie-ai/core'
import {
  addWish,
  markWanted,
  removeWish,
  wantedProviderCounts,
  wishBlocksHandoff,
  wishesFor,
  type Database,
  type WantedProviderCount,
} from '@kolonie-ai/db'

/**
 * The shared account list, as a surface (#527).
 *
 * ## The secret refusal is the reason this module exists rather than a route
 * calling storage
 *
 * `operator_requests` and `operator_drops` divide the world: **words go through
 * a request, a secret goes through a drop, and nothing goes through a chat.**
 * Both free boxes refuse a credential outright, and that refusal is what keeps
 * the drop meaning *a secret*.
 *
 * This is a third free box on the same trust boundary, written by both parties,
 * and it holds to the same rule through the same guard. A third box that
 * accepted a token would undo the distinction for all three, and it would do it
 * quietly — the value would simply be sitting in a list somebody opens on a
 * laptop.
 *
 * ## Both directions, because both parties write here
 *
 * `#236`'s guard runs on the ask *and* on the answer, and the reason given there
 * applies exactly: the citizen's ask is the obvious case, and the answer is
 * where a password actually arrives, from a person who has just made an account
 * and is one paste away.
 */

export interface WishStore {
  list(agentId: AgentId): Promise<readonly Wish[]>
  add(input: {
    readonly agentId: AgentId
    readonly provider: string
    readonly author: WishAuthor
    readonly noticedWhile?: string | undefined
  }): Promise<{ readonly outcome: 'added' | 'already-listed'; readonly wish: Wish }>
  want(agentId: AgentId, provider: string): Promise<boolean>
  remove(agentId: AgentId, provider: string): Promise<boolean>
  /**
   * Whether this agent may spend its operator's attention on this provider.
   *
   * `false` for a provider nobody has written down — see `blocksHandoff` in
   * storage for why the gate is narrow.
   */
  blocksHandoff(agentId: AgentId, provider: string): Promise<boolean>
  /**
   * Which providers citizens have asked for, as counts (`#534`).
   *
   * **Takes no arguments and never will.** A parameter here would be a way to
   * narrow, and the answer to a narrowing question is a smaller group — which is
   * exactly what the floor exists to stop being reportable.
   */
  wanted(): Promise<readonly WantedProviderCount[]>
}

export function databaseWishes(db: Database): WishStore {
  return {
    list: (agentId) => wishesFor(db, agentId),
    add: (input) => addWish(db, input),
    want: (agentId, provider) => markWanted(db, agentId, provider),
    remove: (agentId, provider) => removeWish(db, agentId, provider),
    blocksHandoff: (agentId, provider) => wishBlocksHandoff(db, agentId, provider),
    wanted: () => wantedProviderCounts(db),
  }
}

export interface WishDependencies {
  readonly store: WishStore
}

export type AddWishResult =
  | { readonly outcome: 'added' | 'already-listed'; readonly wish: Wish }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/**
 * Put something on the list, from either side.
 *
 * The author is decided by which surface called — an authenticated agent is a
 * `citizen`, a signed-in operator is an `operator` — and never by an argument. A
 * field naming the author would be a field somebody could set.
 */
export async function putOnWishList(
  agentId: AgentId,
  author: WishAuthor,
  body: unknown,
  deps: WishDependencies,
): Promise<AddWishResult> {
  const parsed = AddWishSchema.safeParse(body ?? {})
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'A list entry needs a provider — one token, as the Atlas prints it, like "trello.com". ' +
          'A sentence about why is welcome and is not required.',
        details: Object.fromEntries(
          parsed.error.issues.map((issue) => [issue.path.join('.'), issue.message]),
        ),
      },
    }
  }

  const provider = AccountProviderSchema.safeParse(parsed.data.provider)
  if (!provider.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'A provider is one token — a hostname like "trello.com", or a short slug. This list ' +
          'names who runs an account, not what it is for.',
        details: { provider: 'must be a single provider token' },
      },
    }
  }

  /**
   * The guard, on both fields.
   *
   * The provider as well as the note, because *the token is hunter2* is a
   * perfectly typeable provider and a refusal that only read the sentence would
   * be a refusal with a hole in it.
   */
  for (const value of [provider.data, parsed.data.noticedWhile ?? '']) {
    const finding = credentialFinding(value)
    if (finding !== null) {
      return {
        outcome: 'rejected',
        error: {
          code: 'validation_failed',
          message: credentialRefusalMessage(finding),
          // The finding's class and never its value — a refusal travels back
          // through an API error, which is a place a credential must not go.
          details: { reason: finding.reason },
        },
      }
    }
  }

  const result = await deps.store.add({
    agentId,
    provider: provider.data,
    author,
    ...(parsed.data.noticedWhile === undefined ? {} : { noticedWhile: parsed.data.noticedWhile }),
  })

  return result
}
