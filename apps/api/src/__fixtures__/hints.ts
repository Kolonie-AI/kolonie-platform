import type { AgentId, StandingHintCode, StandingHintFinding } from '@kolonie-ai/core'
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
  readonly answers: (code: StandingHintCode, subject?: string) => void
  /** Who was asked, in order — including the asks that answered nothing. */
  readonly asked: () => readonly AgentId[]
  /**
   * What the read-only ask answers, for as long as a test leaves it there
   * (`#512`).
   *
   * **It does not spend, and neither does the real one.** Set separately from
   * {@link FakeStandingHints.answers} precisely so a test can tell the two
   * apart: a fake where `facing` consumed what `due` was going to say would hide
   * the defect the operator's page must not have.
   */
  readonly faces: (code: StandingHintCode, subject?: string) => void
  /**
   * What the role-duty ask answers, for as long as a test leaves it there
   * (`#646`).
   *
   * **Set separately from both of the above, and answering as often as it is
   * asked.** That is the property the real one has: a duty claims no slot, so a
   * fake that spent on the first ask would let a guard that only ever attaches
   * one of the two lines pass the test written to catch exactly that.
   */
  readonly owes: (code: StandingHintCode, subject?: string) => void
}

/** A hint source that answers once with whatever a test put in it. */
export function fakeStandingHints(): FakeStandingHints {
  let pending: StandingHintFinding | null = null
  let standing: StandingHintFinding | null = null
  let owed: StandingHintFinding | null = null
  const asked: AgentId[] = []

  return {
    due: async (agentId) => {
      asked.push(agentId)
      const answer = pending
      pending = null
      return answer
    },
    // Answers as often as it is asked and takes nothing away, which is the
    // property the real one has and the one the page depends on.
    facing: async () => standing,
    // Spends nothing and repeats, exactly as the real one does.
    duty: async () => owed,
    answers: (code, subject) => {
      pending = { code, subject: subject ?? null }
    },
    faces: (code, subject) => {
      standing = { code, subject: subject ?? null }
    },
    owes: (code, subject) => {
      owed = { code, subject: subject ?? null }
    },
    asked: () => [...asked],
  }
}
