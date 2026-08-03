import { randomBytes } from 'node:crypto'
import { OPERATOR_CLAIM_PREFIX, type AgentId, type OperatorClaim } from '@kolonie-ai/core'
import type { ClaimReadResult, ClaimReader } from '@kolonie-ai/verifiers'
import type { OperatorClaimDependencies, OperatorClaims } from '../operator-claim.js'

export interface FakeOperatorClaims extends OperatorClaims {
  /** The string this citizen may currently spend, if any. */
  readonly outstanding: (agentId: AgentId) => string | null
  /** Every claim recorded, oldest first. */
  readonly recorded: () => readonly OperatorClaim[]
}

/**
 * An in-memory store for the operator claim (#233).
 *
 * **A new string supersedes the old**, matching `mintOperatorClaim` rather than
 * the social fake beside it — there, every unexpired nonce stays live. A fake
 * that kept both would let a test pass against behaviour the database refuses.
 */
export function fakeOperatorClaims(): FakeOperatorClaims {
  const open = new Map<AgentId, string>()
  const claims = new Map<AgentId, OperatorClaim>()
  const recorded: OperatorClaim[] = []

  return {
    mint: (agentId) => {
      const claim = `${OPERATOR_CLAIM_PREFIX}-${randomBytes(32).toString('hex')}`
      open.set(agentId, claim)

      return Promise.resolve({
        claim,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      })
    },
    open: (agentId) => Promise.resolve(open.get(agentId) ?? null),
    record: (agentId, input) => {
      open.delete(agentId)
      const claim: OperatorClaim = {
        handle: input.handle,
        postUrl: input.postUrl,
        claimedAt: new Date().toISOString(),
      }
      claims.set(agentId, claim)
      recorded.push(claim)

      return Promise.resolve(claim)
    },
    current: (agentId) => Promise.resolve(claims.get(agentId) ?? null),
    history: (agentId) =>
      Promise.resolve(
        recorded
          .filter(() => claims.has(agentId))
          .slice()
          .reverse(),
      ),
    outstanding: (agentId) => open.get(agentId) ?? null,
    recorded: () => recorded,
  }
}

/**
 * A reader that answers whatever the test set, and records nothing by itself.
 *
 * Defaults to `found` with an empty body, so a test that has not thought about
 * the post gets a *refused* rather than an accidental pass.
 */
export function fakeClaimReader(answer?: ClaimReadResult): ClaimReader & {
  answers: (next: ClaimReadResult) => void
} {
  let result: ClaimReadResult = answer ?? {
    outcome: 'found',
    post: { handle: 'gregorsprint', body: '' },
  }

  return {
    read: () => Promise.resolve(result),
    answers: (next) => {
      result = next
    },
  }
}

/** The operator claim wired for a test that does not care about it. */
export function fakeOperatorClaim(): OperatorClaimDependencies {
  return { claims: fakeOperatorClaims(), reader: fakeClaimReader() }
}
