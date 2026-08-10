import { describe, expect, it } from 'vitest'
import {
  ATLAS_ADMISSION_QUESTIONS,
  AgentApiSchema,
  atlasAdmissionRefusal,
  questionById,
} from './atlas-admission.js'

/**
 * The three questions an Atlas entry must answer (`#680`).
 *
 * **What is asserted here is that the questions are usable rather than merely
 * present.** `#680`'s failure is a proposal failing question two being accepted
 * and left, and a list of questions nobody can be refused with would reproduce
 * it exactly — so the tests are about the refusals as much as the questions.
 */
describe('what an Atlas entry must answer', () => {
  it('asks three questions, each with a refusal a proposer can be sent', () => {
    expect(ATLAS_ADMISSION_QUESTIONS).toHaveLength(3)

    for (const one of ATLAS_ADMISSION_QUESTIONS) {
      expect(one.question.length).toBeGreaterThan(0)
      expect(one.why.length).toBeGreaterThan(0)
      expect(one.refusal.length).toBeGreaterThan(0)
    }
  })

  it('names each question once', () => {
    const ids = ATLAS_ADMISSION_QUESTIONS.map((one) => one.id)

    expect(new Set(ids).size).toBe(ids.length)
  })

  /**
   * **The one that matters most.** `unknown` is the answer of somebody who has
   * not looked, and refusing them for it would teach the next proposer to write
   * `full` — which is the failure this whole vocabulary exists to end, arrived
   * at by the Colony's own incentive rather than by carelessness.
   */
  it('refuses no API, and does not refuse nobody-has-looked', () => {
    expect(atlasAdmissionRefusal({ agentApi: 'none' })).toBe(
      questionById('agent-usable-api').refusal,
    )

    for (const answer of ['full', 'partial', 'unknown'] as const) {
      expect(atlasAdmissionRefusal({ agentApi: answer })).toBeUndefined()
    }
    expect(atlasAdmissionRefusal({})).toBeUndefined()
  })

  it('refuses an account no agent can hold, and a signup nobody has a path through', () => {
    expect(atlasAdmissionRefusal({ agentCanHold: false })).toBe(
      questionById('agent-can-hold').refusal,
    )
    expect(atlasAdmissionRefusal({ signupWalkable: false })).toBe(
      questionById('signup-walkable').refusal,
    )
  })

  /** Question one first, because it is the cheapest to answer and the dearest to miss. */
  it('answers with the first question that failed', () => {
    expect(
      atlasAdmissionRefusal({ agentCanHold: false, agentApi: 'none', signupWalkable: false }),
    ).toBe(questionById('agent-can-hold').refusal)
  })

  it('has an honest word for nobody has looked', () => {
    expect(AgentApiSchema.options).toContain('unknown')
  })

  it('throws on a question that does not exist, rather than answering nothing', () => {
    expect(() => questionById('no-such-question' as never)).toThrow()
  })
})
