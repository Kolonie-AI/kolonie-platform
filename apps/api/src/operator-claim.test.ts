import { describe, expect, it, vi } from 'vitest'
import type { AgentId, OperatorClaim } from '@kolonie-ai/core'
import type { ClaimReadResult, ClaimReader } from '@kolonie-ai/verifiers'
import {
  openOperatorClaimChallenge,
  submitOperatorClaim,
  type OperatorClaimDependencies,
  type OperatorClaims,
} from './operator-claim.js'

const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as AgentId
const A_POST = 'https://x.com/gregorsprint/status/1234567890'
const A_CLAIM = 'kolonie-operator-claim-abc123'

const claims = (open: string | null): OperatorClaims & { recorded: () => unknown[] } => {
  const recorded: unknown[] = []
  return {
    mint: async () => ({ claim: A_CLAIM, expiresAt: '2026-08-04T00:00:00.000Z' }),
    open: async () => open,
    record: async (agentId, input): Promise<OperatorClaim> => {
      recorded.push({ agentId, ...input })
      return {
        handle: input.handle,
        postUrl: input.postUrl,
        claimedAt: '2026-08-03T12:00:00.000Z',
      }
    },
    current: async () => null,
    history: async () => [],
    recorded: () => recorded,
  }
}

const reader = (result: ClaimReadResult): ClaimReader => ({ read: async () => result })

const found = (body: string, handle = 'gregorsprint'): ClaimReadResult => ({
  outcome: 'found',
  post: { handle, body },
})

describe('asking for a claim string', () => {
  it('hands back the string and when it stops working', async () => {
    const deps: OperatorClaimDependencies = {
      claims: claims(null),
      reader: reader(found('')),
    }

    const response = await openOperatorClaimChallenge(AGENT, deps)

    expect(response.claim).toBe(A_CLAIM)
    expect(response.expiresAt).toBeTruthy()
  })
})

describe('handing in the post', () => {
  const deps = (
    open: string | null,
    read: ClaimReadResult,
  ): OperatorClaimDependencies & { store: ReturnType<typeof claims> } => {
    const store = claims(open)
    return { claims: store, reader: reader(read), store }
  }

  it('records the vouch when the post carries the string', async () => {
    const d = deps(A_CLAIM, found(`Vouching for my agent. ${A_CLAIM}`))

    const result = await submitOperatorClaim(AGENT, { postUrl: A_POST }, d)

    expect(result.outcome).toBe('recorded')
    expect(result.outcome === 'recorded' && result.response.handle).toBe('gregorsprint')
  })

  /**
   * The load-bearing one. The submitted URL says `gregorsprint`; X says the post
   * was written by somebody else. Only X's answer is evidence — otherwise a
   * citizen could submit any public post and have the handle it typed recorded.
   */
  it('takes the handle from X and never from the submitted address', async () => {
    const d = deps(A_CLAIM, found(A_CLAIM, 'someoneelse'))

    const result = await submitOperatorClaim(AGENT, { postUrl: A_POST }, d)

    expect(result.outcome === 'recorded' && result.response.handle).toBe('someoneelse')
  })

  it('lowercases the handle on the way in', async () => {
    // Two rows differing only in case would be one operator counted twice.
    const d = deps(A_CLAIM, found(A_CLAIM, 'GregorSprint'))

    const result = await submitOperatorClaim(AGENT, { postUrl: A_POST }, d)

    expect(result.outcome === 'recorded' && result.response.handle).toBe('gregorsprint')
  })

  it('refuses a post that does not carry the string', async () => {
    const d = deps(A_CLAIM, found('Vouching for my agent.'))

    const result = await submitOperatorClaim(AGENT, { postUrl: A_POST }, d)

    expect(result.outcome).toBe('rejected')
    expect(result.outcome === 'rejected' && result.error.code).toBe('validation_failed')
    expect(d.store.recorded()).toHaveLength(0)
  })

  it('refuses when the citizen has no string outstanding', async () => {
    const d = deps(null, found(A_CLAIM))

    const result = await submitOperatorClaim(AGENT, { postUrl: A_POST }, d)

    expect(result.outcome).toBe('rejected')
    expect(result.outcome === 'rejected' && result.error.code).toBe('conflict')
  })

  it('refuses an address that is not a URL at all', async () => {
    const d = deps(A_CLAIM, found(A_CLAIM))

    const result = await submitOperatorClaim(AGENT, { postUrl: 'gregorsprint' }, d)

    expect(result.outcome).toBe('rejected')
    expect(result.outcome === 'rejected' && result.error.code).toBe('validation_failed')
  })

  it('reports a missing post as the operator’s to fix', async () => {
    const d = deps(A_CLAIM, { outcome: 'not-found', reason: 'X could not show that post.' })

    const result = await submitOperatorClaim(AGENT, { postUrl: A_POST }, d)

    expect(result.outcome === 'rejected' && result.error.code).toBe('validation_failed')
  })

  /**
   * X being down must never be reported as the post being absent. An operator
   * who did everything right would otherwise be sent to look for a mistake that
   * is not theirs — and nothing may be spent, so the same post works later.
   */
  it('reports an outage as retryable and spends nothing', async () => {
    const d = deps(A_CLAIM, { outcome: 'unavailable', reason: 'X answered 503.' })

    const result = await submitOperatorClaim(AGENT, { postUrl: A_POST }, d)

    expect(result.outcome === 'rejected' && result.error.code).toBe('internal')
    expect(result.outcome === 'rejected' && result.error.message).toContain('not your problem')
    expect(d.store.recorded()).toHaveLength(0)
  })

  it('records nothing at all on any refusal', async () => {
    // Asserted across every refusal in one place, because "nothing was spent" is
    // promised in the message of each and would be a lie in any that wrote a row.
    for (const read of [
      found('no claim here'),
      { outcome: 'not-found', reason: 'gone' } as const,
      { outcome: 'unavailable', reason: 'down' } as const,
    ]) {
      const d = deps(A_CLAIM, read)
      await submitOperatorClaim(AGENT, { postUrl: A_POST }, d)
      expect(d.store.recorded()).toHaveLength(0)
    }
  })

  it('does not reach X when there is no string to check against', async () => {
    // Cheapest guard first: a citizen with nothing outstanding must not cause a
    // request to somebody else's service.
    const read = vi.fn(async (): Promise<ClaimReadResult> => found(A_CLAIM))
    const store = claims(null)

    await submitOperatorClaim(AGENT, { postUrl: A_POST }, { claims: store, reader: { read } })

    expect(read).not.toHaveBeenCalled()
  })
})
