import { describe, expect, it } from 'vitest'
import {
  SELF_DIRECTION_THEMES,
  SelfDirectionInstrumentDocumentSchema,
  scoreSelfDirectionResponses,
  type SelfDirectionTheme,
} from '@kolonie-ai/core'
import { SELF_DIRECTION_MVP_V1 } from './mvp-v1.js'

/**
 * The editorial contract of `#1894`, asserted rather than promised.
 *
 * The questions are the product, so the properties that make them worth asking
 * — no giveaway, no free virtue, no winning strategy — are checked here. A
 * reviewer disagreeing with a weight argues with the number; a reviewer
 * disagreeing with the contract has to change one of these tests.
 */
describe('the self-direction MVP instrument', () => {
  const instrument = SELF_DIRECTION_MVP_V1

  it('is a valid published document with ten items and four options each', () => {
    const parsed = SelfDirectionInstrumentDocumentSchema.parse(instrument)

    expect(parsed.lifecycle).toBe('pilot')
    expect(parsed.items).toHaveLength(10)
    for (const item of parsed.items) expect(item.options).toHaveLength(4)
  })

  it('covers each required topic exactly once', () => {
    expect(instrument.items.map((item) => item.scenarioKind).sort()).toEqual(
      [
        'bounded-action-vs-analysis-paralysis',
        'durable-relationship-vs-one-off-transaction',
        'ending-an-effort-vs-maintaining-it',
        'largest-problem-vs-nearest-fragment',
        'leverage-vs-serial-execution',
        'new-possibility-vs-inventory',
        'outsider-effect-vs-internal-perfection',
        'own-instructions-as-causal-surface',
        'root-intervention-vs-symptom-repair',
        'self-authored-direction-vs-assignment',
      ].sort(),
    )
  })

  it('scores every theme on at least two items', () => {
    for (const theme of SELF_DIRECTION_THEMES) {
      const items = instrument.items.filter((item) =>
        item.options.some((option) => option.weights[theme] !== 0),
      )
      expect(items.length).toBeGreaterThanOrEqual(2)
    }
  })

  it('scores every option on more than one theme, so no item is a single scale', () => {
    for (const item of instrument.items) {
      for (const option of item.options) {
        const scored = SELF_DIRECTION_THEMES.filter((theme) => option.weights[theme] !== 0)
        expect(scored.length).toBeGreaterThan(1)
      }
    }
  })

  it('gives every item a public rationale and every option a real cost', () => {
    for (const item of instrument.items) {
      expect(item.rationale.length).toBeGreaterThan(80)
      /**
       * No free virtue: in every item at least one option that scores well
       * somewhere also gives something up somewhere else. An item where the
       * best option is best on every theme is a quiz question, not a choice.
       */
      const bestEverywhere = item.options.filter((option) =>
        SELF_DIRECTION_THEMES.every(
          (theme) =>
            option.weights[theme] === Math.max(...item.options.map((one) => one.weights[theme])),
        ),
      )
      expect(bestEverywhere).toHaveLength(0)
    }
  })

  it('cannot be won by option position', () => {
    const positions = instrument.items.map((item) => {
      const totals = item.options.map((option) =>
        SELF_DIRECTION_THEMES.reduce((sum, theme) => sum + option.weights[theme], 0),
      )
      return totals.indexOf(Math.max(...totals))
    })

    expect(new Set(positions).size).toBeGreaterThan(2)
  })

  it('cannot be won by option length', () => {
    let longestWins = 0
    for (const item of instrument.items) {
      const totals = item.options.map((option) =>
        SELF_DIRECTION_THEMES.reduce((sum, theme) => sum + option.weights[theme], 0),
      )
      const best = item.options[totals.indexOf(Math.max(...totals))]!
      const longest = [...item.options].sort(
        (left, right) => right.text.length - left.text.length,
      )[0]!
      if (best.key === longest.key) longestWins += 1
    }

    expect(longestWins).toBeLessThanOrEqual(3)
  })

  /**
   * **The one that matters most**: "always pick the biggest move" must lose.
   * The maximalist answers are marked in the data, so this is a property of the
   * weights rather than of the reader's taste.
   */
  it('punishes blind maximalism against a citizen that chooses', () => {
    const maximalist = instrument.items.map((item) => {
      const option =
        item.options.find((one) => one.patterns.includes('maximalist')) ??
        [...item.options].sort(
          (left, right) =>
            SELF_DIRECTION_THEMES.reduce((sum, theme) => sum + right.weights[theme], 0) -
            SELF_DIRECTION_THEMES.reduce((sum, theme) => sum + left.weights[theme], 0),
        )[0]!
      return { itemKey: item.key, optionKey: option.key }
    })
    const chooser = instrument.items.map((item) => {
      const best = [...item.options].sort(
        (left, right) =>
          SELF_DIRECTION_THEMES.reduce((sum, theme) => sum + right.weights[theme], 0) -
          SELF_DIRECTION_THEMES.reduce((sum, theme) => sum + left.weights[theme], 0),
      )[0]!
      return { itemKey: item.key, optionKey: best.key }
    })

    const grand = scoreSelfDirectionResponses(instrument, maximalist)
    const chosen = scoreSelfDirectionResponses(instrument, chooser)

    expect(grand.total).toBeLessThan(chosen.total)
  })

  it('rewards stopping an insignificant effort over maintaining or rewriting it', () => {
    const item = instrument.items.find((one) => one.key === 'stopping-sunk-cost')!
    const total = (key: string) => {
      const option = item.options.find((one) => one.key === key)!
      return SELF_DIRECTION_THEMES.reduce(
        (sum, theme: SelfDirectionTheme) => sum + option.weights[theme],
        0,
      )
    }

    expect(total('retire-it-publicly')).toBeGreaterThan(total('rewrite-it-better'))
    expect(total('retire-it-publicly')).toBeGreaterThan(total('keep-maintaining'))
  })

  /**
   * Two blind reviewers, given the prompts and no key, both found the same
   * leak: the highest-scoring option was recognisable from its *syntax*. It
   * carried a contingency clause — "and change your mind if it goes badly" —
   * while the distractors carried a clause defending themselves — "it is
   * twenty minutes and it always works". A test-taker could score well by
   * deleting the self-justifying option, with no judgement about the content.
   *
   * Both markers are now spread across scoring bands rather than tracking them,
   * which is what this asserts. It is a weaker property than "no leak" and an
   * honest one: it says the two cues no longer identify the key, not that no
   * cue does.
   */
  it('does not mark the strongest option by contingency or self-justifying syntax', () => {
    const contingency =
      /\b(and (change your mind|stop there|retire it|see whether|let their answer))\b/i
    const bands = { strongest: 0, other: 0 }
    for (const item of instrument.items) {
      const totals = item.options.map((option) =>
        SELF_DIRECTION_THEMES.reduce((sum, theme) => sum + option.weights[theme], 0),
      )
      const best = totals.indexOf(Math.max(...totals))
      item.options.forEach((option, index) => {
        if (!contingency.test(option.text)) return
        if (index === best) bands.strongest += 1
        else bands.other += 1
      })
    }

    expect(bands.strongest).toBeLessThanOrEqual(bands.other + 1)
  })

  /**
   * The second half of the same finding: the distractors argued for themselves
   * ("it is twenty minutes and it always works") while the key options did not,
   * so deleting every self-justifying option was a scoring strategy. Five of
   * the five self-justifying clauses sat on distractors. The cue now sits on
   * both sides.
   */
  it('does not mark the weakest option by self-justifying syntax', () => {
    const justifying = /\b(because|since|it is|always works|clearly|on the view)\b/i
    let onKey = 0
    let onDistractor = 0
    for (const item of instrument.items) {
      const totals = item.options.map((option) =>
        SELF_DIRECTION_THEMES.reduce((sum, theme) => sum + option.weights[theme], 0),
      )
      const best = totals.indexOf(Math.max(...totals))
      item.options.forEach((option, index) => {
        if (!justifying.test(option.text)) return
        if (index === best) onKey += 1
        else onDistractor += 1
      })
    }

    expect(onKey).toBeGreaterThanOrEqual(onDistractor)
  })

  it('does not put the weakest option in one position across the set', () => {
    const positions = instrument.items.map((item) => {
      const totals = item.options.map((option) =>
        SELF_DIRECTION_THEMES.reduce((sum, theme) => sum + option.weights[theme], 0),
      )
      return totals.indexOf(Math.min(...totals))
    })
    const commonest = Math.max(
      ...[0, 1, 2, 3].map((slot) => positions.filter((one) => one === slot).length),
    )

    expect(commonest).toBeLessThanOrEqual(5)
  })

  it('rewards the smaller decisive move over the grandest one where they compete', () => {
    const item = instrument.items.find((one) => one.key === 'bounded-uncertainty')!
    const total = (key: string) => {
      const option = item.options.find((one) => one.key === key)!
      return SELF_DIRECTION_THEMES.reduce((sum, theme) => sum + option.weights[theme], 0)
    }

    expect(total('try-the-cheap-one')).toBeGreaterThan(total('commit-hard'))
    expect(total('try-the-cheap-one')).toBeGreaterThan(total('investigate-fully'))
  })
})
