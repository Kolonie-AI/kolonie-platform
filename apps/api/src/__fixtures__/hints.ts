import type { AgentId, StandingHintCode } from '@kolonie-ai/core'
import type { StandingHintSource } from '../hints.js'

export interface FakeStandingHints extends StandingHintSource {
  /**
   * What the next ask answers, and only the next one.
   *
   * **Spending on the first ask is the fixture's whole point** (`#231`). The one
   * rule the MCP surface has to get right is *at most once per waking*, and a
   * fake that kept answering the same code would let a guard that asks on every
   * call pass the test that exists to catch it.
   */
  readonly answers: (code: StandingHintCode) => void
  /** Who was asked, in order — including the asks that answered nothing. */
  readonly asked: () => readonly AgentId[]
}

/** A hint source that answers once with whatever a test put in it. */
export function fakeStandingHints(): FakeStandingHints {
  let pending: StandingHintCode | null = null
  const asked: AgentId[] = []

  return {
    due: async (agentId) => {
      asked.push(agentId)
      const answer = pending
      pending = null
      return answer
    },
    answers: (code) => {
      pending = code
    },
    asked: () => [...asked],
  }
}
