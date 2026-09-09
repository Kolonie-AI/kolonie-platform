import { describe, expect, it } from 'vitest'
import {
  scoreSelfDirectionResponses,
  SelfDirectionSubmissionSchema,
} from './self-direction-attempt.js'
import type { SelfDirectionInstrumentDocument } from './self-direction.js'

const instrument = {
  slug: 'practice',
  version: 1,
  lifecycle: 'pilot',
  cadenceDays: 7,
  retestFloorHours: 72,
  compatibility: { lineage: 'practice', comparableToPrevious: false },
  themeDefinitions: [
    { key: 'initiative', description: 'initiative' },
    { key: 'leverage', description: 'leverage' },
    { key: 'outwardEffect', description: 'outward' },
    { key: 'strategicFocus', description: 'focus' },
    { key: 'selfRevision', description: 'revision' },
  ],
  items: Array.from({ length: 10 }, (_, offset) => ({
    key: `item-${offset + 1}`,
    audience: 'general',
    professionTag: null,
    scenarioKind: `kind-${offset + 1}`,
    prompt: `Prompt ${offset + 1}`,
    rationale: 'Public rationale',
    state: 'active',
    options: Array.from({ length: 4 }, (_, optionOffset) => ({
      key: `option-${optionOffset + 1}`,
      text: `Option ${optionOffset + 1}`,
      weights: {
        initiative: optionOffset * 10,
        leverage: optionOffset * 10,
        outwardEffect: optionOffset * 10,
        strategicFocus: optionOffset * 10,
        selfRevision: optionOffset * 10,
      },
      patterns: optionOffset === 3 ? ['acts-outward'] : [],
    })),
  })),
} satisfies SelfDirectionInstrumentDocument

const answers = instrument.items.map(({ key }) => ({ itemKey: key, optionKey: 'option-4' }))

describe('self-direction attempt scoring', () => {
  it('scores identical answers identically without a model', () => {
    const first = scoreSelfDirectionResponses(instrument, answers)
    expect(first).toEqual(scoreSelfDirectionResponses(instrument, answers))
    expect(first).toEqual({
      total: 100,
      themes: {
        initiative: 100,
        leverage: 100,
        outwardEffect: 100,
        strategicFocus: 100,
        selfRevision: 100,
      },
      patterns: [{ key: 'acts-outward', count: 10 }],
    })
  })

  it('rejects missing, duplicate and unknown answers', () => {
    expect(() => SelfDirectionSubmissionSchema.parse({ responses: answers.slice(1) })).toThrow()
    expect(() =>
      scoreSelfDirectionResponses(instrument, [...answers.slice(0, 9), answers[0]!]),
    ).toThrow(/once/)
    expect(() =>
      scoreSelfDirectionResponses(instrument, [
        ...answers.slice(0, 9),
        { itemKey: 'item-10', optionKey: 'unknown' },
      ]),
    ).toThrow(/unknown/)
  })
})
