import type { AgentId } from '@kolonie-ai/core'
import type {
  OperatorPageMessageDependencies,
  OperatorPageMessageStore,
} from '../operator-page-message.js'
import { operatorNoteLimiter, type RateLimiter } from '../rate-limit.js'
import { fakeOperatorPages, type FakeOperatorPages } from './autonomy.js'

export interface FakeOperatorPageMessageStore extends OperatorPageMessageStore {
  /** Everything written to this citizen through a page — for asserting it landed. */
  readonly allFor: (agentId: AgentId) => readonly string[]
}

/**
 * The durable page's own write, in memory (`#239`, on messaging since `#1454`).
 *
 * **Much smaller than the fake it replaces**, and the shrinkage is the change.
 * `operator_notes` had an unread ceiling and a read that marked, so the fixture
 * had to reproduce both or let a test pass against behaviour PostgreSQL refuses.
 * A message goes into a thread: there is no pile to bound and no read to model
 * here, because the citizen reads it through `kolonie.messages.*` like anything
 * else, and that side is asserted against real PostgreSQL.
 *
 * What is left is the one invariant this channel still has of its own: **a
 * revoked page writes nothing**, which is why `pages` is shared rather than
 * duplicated — an independent token map would let a test write through a page
 * the revoke path had never heard of.
 */
export function fakeOperatorPageMessageStore(
  pages: FakeOperatorPages = fakeOperatorPages(),
): FakeOperatorPageMessageStore {
  const written: { agentId: AgentId; body: string }[] = []

  return {
    write: (input) => {
      const agentId = pages.agentForToken(input.token)
      if (agentId === null) return Promise.resolve({ outcome: 'unreachable' as const })

      written.push({ agentId, body: input.body })
      return Promise.resolve({ outcome: 'written' as const, agentId })
    },

    allFor: (agentId) => written.filter((row) => row.agentId === agentId).map((row) => row.body),
  }
}

/** The dependencies, with a real limiter unless a test wants to exhaust one. */
export function fakeOperatorPageMessages(options?: {
  readonly pages?: FakeOperatorPages
  readonly limiter?: RateLimiter
  readonly store?: FakeOperatorPageMessageStore
}): OperatorPageMessageDependencies & { readonly store: FakeOperatorPageMessageStore } {
  return {
    store: options?.store ?? fakeOperatorPageMessageStore(options?.pages),
    limiter: options?.limiter ?? operatorNoteLimiter(),
  }
}
