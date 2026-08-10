import {
  AccountProviderSchema,
  AddWishSchema,
  SelectBundleSchema,
  credentialFinding,
  credentialRefusalMessage,
  type AgentId,
  type ApiError,
  type Wish,
  type WishAuthor,
} from '@kolonie-ai/core'
import {
  addWish,
  bundleNamed,
  bundles,
  markWanted,
  removeWish,
  wantedProviderCounts,
  wishBlocksHandoff,
  wishesFor,
  type BundleView,
  type Database,
  type WantedProviderCount,
} from '@kolonie-ai/db'
import type { WakeSender } from '@kolonie-ai/verifiers'

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
  }): Promise<{
    readonly outcome: 'added' | 'context-added' | 'already-listed'
    readonly wish: Wish
    /** Whether this also reached the Colony as a proposal (`#600`). */
    readonly alsoProposed: boolean
  }>
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
  /** The bundles the Colony recommends, with what the catalogue says (`#531`). */
  bundles(): Promise<readonly BundleView[]>
  /** One of them, by name. */
  bundle(slug: string): Promise<BundleView | undefined>
}

export function databaseWishes(db: Database): WishStore {
  return {
    list: (agentId) => wishesFor(db, agentId),
    add: (input) => addWish(db, input),
    want: (agentId, provider) => markWanted(db, agentId, provider),
    remove: (agentId, provider) => removeWish(db, agentId, provider),
    blocksHandoff: (agentId, provider) => wishBlocksHandoff(db, agentId, provider),
    wanted: () => wantedProviderCounts(db),
    bundles: () => bundles(db),
    bundle: (slug) => bundleNamed(db, slug),
  }
}

export interface WishDependencies {
  readonly store: WishStore
  /**
   * The wake channel (`#518`, wired here by `#580`).
   *
   * **The mark is a thing an operator says, and this is what delivers it.** A
   * note and a mark are the same act from the citizen's side — a person said
   * something it is waiting on — and until `#580` only one of the three reached
   * anybody.
   *
   * Optional, like every other wiring of it: a deployment with no channel
   * behaves exactly as it did before the channel existed.
   */
  readonly wake?: WakeSender | undefined
}

/**
 * The operator says yes to one entry (`#527`), and the agent hears about it
 * (`#580`).
 *
 * **Here rather than in the route**, so a second surface that ever marks one
 * cannot mark without waking. The route was the only caller and would have been
 * the obvious place; the reason it is the wrong one is that *the mark reaches
 * the agent* is a rule about the act rather than about the page it was made on.
 *
 * **Raised only when a row actually changed**, which is the anti-abuse property
 * and it was already there: `markWanted` sets `wanted_at` only where it is null,
 * so an operator clicking twice writes once and knocks once. Nothing was added
 * to make that true — no counter, no cooldown — and that is the whole reason
 * this event is safe to raise from a button.
 */
export async function markWishWanted(
  agentId: AgentId,
  provider: string,
  deps: WishDependencies,
): Promise<boolean> {
  const marked = await deps.store.want(agentId, provider)

  /**
   * **After the write, and never when nothing was written.** A knock carries
   * nothing, so the agent wakes and asks what changed — and a knock sent when
   * the row was already marked would spend a waking to be told *nothing*.
   */
  if (marked) await deps.wake?.wake(agentId, 'wish-wanted')

  return marked
}

export type AddWishResult =
  | {
      readonly outcome: 'added' | 'context-added' | 'already-listed'
      readonly wish: Wish
      readonly alsoProposed: boolean
    }
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

/** What happened when an operator chose a bundle. */
export type SelectBundleResult =
  | {
      readonly outcome: 'selected'
      /** How many entries went onto the list, and how many were already there. */
      readonly added: number
      readonly alreadyListed: number
    }
  | { readonly outcome: 'no-such-bundle' }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/**
 * Put a bundle on an agent's list, in one action (#531).
 *
 * ## What it writes, and what it deliberately does not
 *
 * **Wishes, and nothing marked wanted.** Choosing a bundle is choosing what to
 * *consider*; the mark that turns each one into something a recipe may act on is
 * still the operator's, item by item. A bundle that arrived pre-approved would
 * make the one decision `#527` reserves for a person into a side effect of a
 * button.
 *
 * ## An operator can take entries out before starting
 *
 * `#531` requires it, and the reason is worth keeping: *"the entries an operator
 * removes are as informative as the ones it keeps."* An absent `entries` means
 * all of them — the one-click case — and a shorter list is an edit.
 *
 * ## A provider that cannot be joined is still written down
 *
 * The bundle shows the refusal, and if the operator leaves the entry in, it goes
 * on the list. Silently dropping it would be the Colony deciding something on an
 * operator's behalf about a fact it had just shown them.
 */
export async function selectBundle(
  agentId: AgentId,
  body: unknown,
  deps: WishDependencies,
): Promise<SelectBundleResult> {
  const parsed = SelectBundleSchema.safeParse(body ?? {})
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message: 'Name the bundle to put on the list.',
        details: Object.fromEntries(
          parsed.error.issues.map((issue) => [issue.path.join('.'), issue.message]),
        ),
      },
    }
  }

  const bundle = await deps.store.bundle(parsed.data.slug)
  if (bundle === undefined) return { outcome: 'no-such-bundle' }

  const chosen =
    parsed.data.entries === undefined
      ? bundle.entries
      : bundle.entries.filter((entry) =>
          parsed.data.entries?.includes(`${entry.kind}:${entry.provider}`),
        )

  let added = 0
  let alreadyListed = 0

  for (const entry of chosen) {
    /**
     * **Written as the operator's entry, because it is one.** The author column
     * records who first noticed, and a bundle is the Colony's recommendation
     * accepted by a person — reading it back later as *an agent asked for this*
     * would corrupt `#534`'s count, which is the one figure that depends on the
     * distinction.
     */
    const result = await deps.store.add({ agentId, provider: entry.provider, author: 'operator' })
    if (result.outcome === 'added') added += 1
    else alreadyListed += 1
  }

  return { outcome: 'selected', added, alreadyListed }
}
