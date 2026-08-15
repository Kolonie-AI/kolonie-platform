import { describe, expect, it } from 'vitest'
import {
  ATLAS_CONDITION_QUESTIONS,
  ProviderTermsSchema,
  RecipeNeedSchema,
  RecipeNeedsSchema,
  SignupCostSchema,
  atlasConditionsSentences,
  conditionQuestionById,
  operatorClaimDisagreement,
  providerTermsSentence,
  recipeNeedsSentence,
  signupCostSentence,
} from './atlas-conditions.js'
import { ATLAS_CONDITION_QUESTIONS as _reexported } from './index.js'

/**
 * The three conditions an entry is read under (`#815`).
 *
 * **What is asserted here is that none of them refuses**, which is the whole
 * difference between this module and `atlas-admission.ts` next door and the one
 * property a later change could quietly reverse. `#815`: a `human-only` entry is
 * not removed, hidden or refused — the field drives a sentence and nothing else.
 * So the tests are about the sentences, and about the fact that there is nowhere
 * for a refusal to live.
 */
describe('the conditions an Atlas entry is read under', () => {
  it('asks three questions, each rendering from its own vocabulary', () => {
    expect(ATLAS_CONDITION_QUESTIONS).toHaveLength(3)

    for (const one of ATLAS_CONDITION_QUESTIONS) {
      expect(one.question.length).toBeGreaterThan(0)
      expect(one.why.length).toBeGreaterThan(0)
      expect(one.answers.length).toBeGreaterThan(0)
    }
  })

  it('names each question once', () => {
    const ids = ATLAS_CONDITION_QUESTIONS.map((one) => one.id)

    expect(new Set(ids).size).toBe(ids.length)
  })

  /**
   * **The property this module exists to keep.** A `refusal` appearing on one of
   * these is the field having grown a gate, and `#815` says in as many words
   * that it must not. The interface has no place for one, so this fails at the
   * moment somebody widens it — which is the moment to read why it was narrow.
   */
  it('gives no question a refusal, because none of them refuses', () => {
    for (const one of ATLAS_CONDITION_QUESTIONS) {
      expect(one).not.toHaveProperty('refusal')
    }
  })

  it('serves the answers off the schemas, so no form can offer a word that is not one', () => {
    expect(conditionQuestionById('signup-cost').answers).toEqual(SignupCostSchema.options)
    expect(conditionQuestionById('agent-needs').answers).toEqual(RecipeNeedSchema.options)
    expect(conditionQuestionById('provider-terms').answers).toEqual(ProviderTermsSchema.options)
  })

  it('throws on a question that does not exist, rather than answering nothing', () => {
    expect(() => conditionQuestionById('no-such-question' as never)).toThrow()
  })

  it('is reachable from the barrel, which is what every surface imports', () => {
    expect(_reexported).toBe(ATLAS_CONDITION_QUESTIONS)
  })

  it('has an honest word for nobody has looked, on both the enums that can carry one', () => {
    expect(SignupCostSchema.options).toContain('unknown')
    expect(ProviderTermsSchema.options).toContain('unknown')
  })
})

describe('what an agent must already hold', () => {
  it('accepts the empty list, which is a real answer', () => {
    expect(RecipeNeedsSchema.parse([])).toEqual([])
  })

  /**
   * A repeat is a malformed request rather than a corrupt row, which is why it
   * is refused here and not by the table's check constraint — a check may not
   * hold a subquery, so set-uniqueness is not expressible there at all.
   */
  it('refuses a prerequisite listed twice', () => {
    expect(() => RecipeNeedsSchema.parse(['email', 'email'])).toThrow()
  })

  it('refuses a word the vocabulary does not have', () => {
    expect(() => RecipeNeedsSchema.parse(['fax'])).toThrow()
  })

  it('says nothing needed in words, because an empty list is not silence', () => {
    expect(recipeNeedsSentence([])).toContain('Nothing')
    expect(recipeNeedsSentence(['phone', 'email'])).toContain('email, phone')
  })
})

describe('the sentences an entry carries', () => {
  /**
   * **`unknown` is silence.** A surface that renders a sentence for every entry
   * teaches its readers to skip the sentence, and *nobody has read the terms* is
   * not worth the line it costs.
   */
  it('says nothing where nobody has looked', () => {
    expect(providerTermsSentence('unknown')).toBeUndefined()
    expect(signupCostSentence('unknown')).toBeUndefined()
  })

  it('answers every other value, so a vocabulary that grows cannot go silent', () => {
    for (const terms of ProviderTermsSchema.options) {
      if (terms === 'unknown') continue
      expect(providerTermsSentence(terms)).toBeTruthy()
    }

    for (const cost of SignupCostSchema.options) {
      if (cost === 'unknown') continue
      expect(signupCostSentence(cost)).toBeTruthy()
    }
  })

  /**
   * The load-bearing sentence of the whole field. `human-only` tells a citizen
   * how the account is actually obtained — together with its operator — rather
   * than warning it off one it is permitted to hold.
   */
  it('tells a citizen how a human-only account is obtained, rather than warning it away', () => {
    expect(providerTermsSentence('human-only')).toContain('operator')
  })

  it('says free out loud, because the absence of a sentence must mean one thing', () => {
    expect(signupCostSentence('free')).toBeTruthy()
    expect(signupCostSentence('card-to-sign-up')).toContain('card')
  })
})

/**
 * The pairing rule, which is how the two meanings of `needs: []` are told apart.
 *
 * The empty array is both the storage default and a real answer. An entry whose
 * `terms` and `cost` are both `unknown` has not been asked; one that has been
 * asked says so in those two.
 */
describe('rendering the conditions together', () => {
  it('renders nothing at all for an entry nobody has examined', () => {
    expect(atlasConditionsSentences({ needs: [], terms: 'unknown', cost: 'unknown' })).toEqual([])
  })

  it('renders nothing-needed once another answer proves the question was asked', () => {
    const sentences = atlasConditionsSentences({ needs: [], terms: 'unknown', cost: 'free' })

    expect(sentences).toHaveLength(2)
    expect(sentences.join(' ')).toContain('Nothing')
  })

  it('treats a prerequisite as proof the question was asked, on its own', () => {
    expect(
      atlasConditionsSentences({ needs: ['phone'], terms: 'unknown', cost: 'unknown' }),
    ).toHaveLength(1)
  })

  /** Cost first, then what to hold, then the terms — the order they are worth reading in. */
  it('puts money first', () => {
    const sentences = atlasConditionsSentences({
      needs: ['card'],
      terms: 'agent-allowed',
      cost: 'paid-only',
    })

    expect(sentences).toHaveLength(3)
    expect(sentences[0]).toBe(signupCostSentence('paid-only'))
  })
})

/**
 * `operatorNeed` is derived from the steps and never stored (`D-002`); `needs`
 * carries `operator` as a claim made at proposal time. They can disagree, and
 * the disagreement is a thing for a steward to look at rather than a thing to
 * silently correct.
 */
describe('where the claimed operator need meets the derived one', () => {
  it('says nothing where they agree', () => {
    expect(operatorClaimDisagreement(['operator'], 'operator-needed')).toBeUndefined()
    expect(operatorClaimDisagreement([], 'unaided')).toBeUndefined()
  })

  it('says nothing about an entry with no steps, which has contradicted nobody', () => {
    expect(operatorClaimDisagreement(['operator'], 'unknown')).toBeUndefined()
    expect(operatorClaimDisagreement([], 'unknown')).toBeUndefined()
  })

  it('reports a claim the steps do not bear out, in both directions', () => {
    expect(operatorClaimDisagreement(['operator'], 'unaided')).toBeTruthy()
    expect(operatorClaimDisagreement(['email'], 'operator-needed')).toBeTruthy()
  })
})
