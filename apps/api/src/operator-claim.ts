import {
  XHandleSchema,
  SubmitOperatorClaimSchema,
  postCarriesClaim,
  type AgentId,
  type ApiError,
  type ClaimRefusal,
  type OperatorClaim,
} from '@kolonie-ai/core'
import type { Database, MintedOperatorClaim } from '@kolonie-ai/db'
import {
  currentOperatorClaim,
  mintOperatorClaim,
  openOperatorClaim,
  operatorClaimHistory,
  recordOperatorClaim,
} from '@kolonie-ai/db'
import type { ClaimReader } from '@kolonie-ai/verifiers'

/**
 * An operator vouching in public, once (#233).
 *
 * **Not a rung and not a skill**, so this file sits beside `social.ts` rather
 * than among the Academy surfaces: it grants nothing, pays nothing, and appears
 * in the graph nowhere. A citizen without a claim is unclaimed, never suspect.
 */
export interface OperatorClaims {
  mint(agentId: AgentId): Promise<MintedOperatorClaim>
  open(agentId: AgentId): Promise<string | null>
  record(
    agentId: AgentId,
    input: { readonly handle: string; readonly postUrl: string; readonly claim: string },
  ): Promise<OperatorClaim>
  current(agentId: AgentId): Promise<OperatorClaim | null>
  history(agentId: AgentId): Promise<readonly OperatorClaim[]>
}

export interface OperatorClaimDependencies {
  readonly claims: OperatorClaims
  /**
   * The X read path, behind a port so this workspace's tests need no network.
   *
   * **Not `SocialReader`**, and `packages/verifiers/src/operator-claim.ts` says
   * why at length: X is refused as a `SocialNetwork` because a rung is a standing
   * certification and D-018 requires a durable identifier for one. A claim is a
   * dated event, so it needs no such identifier — and keeping the two seams apart
   * is what stops the next rung inheriting X for free.
   */
  readonly reader: ClaimReader
}

/** Storage wired to a real database. The only place these two meet. */
export function databaseOperatorClaims(db: Database): OperatorClaims {
  return {
    mint: (agentId) => mintOperatorClaim(db, agentId),
    open: (agentId) => openOperatorClaim(db, agentId),
    record: (agentId, input) => recordOperatorClaim(db, agentId, input),
    current: (agentId) => currentOperatorClaim(db, agentId),
    history: (agentId) => operatorClaimHistory(db, agentId),
  }
}

export type ClaimOutcome<T> =
  | { readonly outcome: 'recorded'; readonly response: T }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/**
 * Issue the string this citizen's operator publishes.
 *
 * Authenticated as the citizen, because the string has to bind to *this* agent —
 * a post carrying a value anybody could request would be evidence about nobody.
 */
export async function openOperatorClaimChallenge(
  agentId: AgentId,
  deps: OperatorClaimDependencies,
): Promise<{ readonly claim: string; readonly expiresAt: string }> {
  const minted = await deps.claims.mint(agentId)

  return { claim: minted.claim, expiresAt: minted.expiresAt }
}

/** What a refusal says, in one place so the wording cannot drift between surfaces. */
export function claimRefusal(reason: ClaimRefusal, detail: string): ApiError {
  if (reason === 'no-open-claim') {
    return {
      code: 'conflict',
      message:
        'There is no claim string outstanding for you. Ask for one first, give it to your ' +
        'operator, and submit the post afterwards. A string that has already been used or has ' +
        'expired cannot be spent twice — ask for a new one and your operator can post again.',
    }
  }

  if (reason === 'claim-not-in-post') {
    return {
      code: 'validation_failed',
      message:
        'That post does not contain your claim string. It has to appear in the text of the ' +
        'post itself, exactly as it was issued — not in a reply, not in a quote, and not ' +
        'shortened. Your operator may write whatever else they like around it.',
    }
  }

  if (reason === 'unavailable') {
    /**
     * **Never `not_found` or `validation_failed`.** X being down is not evidence
     * that the post is absent, and telling an operator who posted correctly that
     * their post could not be found sends a person who did everything right to
     * look for a mistake that is not theirs. Same distinction `SocialReadResult`
     * draws, and the reason it is drawn at all.
     *
     * `internal` carrying a 503 at the route, which is this repository's existing
     * shape for *a dependency is down, retry* — `routes/academy.ts` does the same
     * mapping and states the argument: *"what an agent needs in order to retry"*.
     * A new `service_unavailable` code would say it more plainly and is not worth
     * a core enum member that every consumer must then learn.
     */
    return {
      code: 'internal',
      message: `The Colony could not read that post from X, and this is not your problem: ${detail} Nothing has been spent — try the same post again later.`,
    }
  }

  return { code: 'validation_failed', message: detail }
}

/**
 * Record the vouch.
 *
 * **Either of them may submit it.** The post proves the human; who typed the URL
 * afterwards proves nothing and gating on it would strand the common case, where
 * the operator posts and tells its agent to go and finish.
 */
export async function submitOperatorClaim(
  agentId: AgentId,
  body: unknown,
  deps: OperatorClaimDependencies,
): Promise<ClaimOutcome<OperatorClaim>> {
  const parsed = SubmitOperatorClaimSchema.safeParse(body ?? {})
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'Send the address of the post your operator published — it should look like ' +
          '`https://x.com/<handle>/status/<number>`, copied from the post itself rather than ' +
          'from their profile.',
      },
    }
  }

  const claim = await deps.claims.open(agentId)
  if (claim === null) {
    return { outcome: 'rejected', error: claimRefusal('no-open-claim', '') }
  }

  const read = await deps.reader.read(parsed.data.postUrl)

  if (read.outcome === 'unavailable') {
    return { outcome: 'rejected', error: claimRefusal('unavailable', read.reason) }
  }

  if (read.outcome === 'not-found') {
    return { outcome: 'rejected', error: claimRefusal('post-not-found', read.reason) }
  }

  if (!postCarriesClaim(read.post.body, claim)) {
    return { outcome: 'rejected', error: claimRefusal('claim-not-in-post', '') }
  }

  const handle = XHandleSchema.safeParse(read.post.handle)
  if (!handle.success) {
    return {
      outcome: 'rejected',
      error: claimRefusal('unavailable', 'X named an author this cannot read.'),
    }
  }

  const recorded = await deps.claims.record(agentId, {
    handle: handle.data,
    postUrl: parsed.data.postUrl,
    claim,
  })

  return { outcome: 'recorded', response: recorded }
}
