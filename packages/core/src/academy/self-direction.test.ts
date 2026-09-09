import { describe, expect, it } from 'vitest'
import {
  SELF_DIRECTION_THEMES,
  SelfDirectionInstrumentDocumentSchema,
  selfDirectionInstrumentContentHash,
} from './self-direction.js'

const option = (key: string, weights: Record<(typeof SELF_DIRECTION_THEMES)[number], number>) => ({
  key,
  text: `Option ${key}`,
  weights,
  patterns: [],
})

const item = (index: number) => ({
  key: `item-${index}`,
  audience: 'general' as const,
  professionTag: null,
  scenarioKind: `scenario-${index}`,
  prompt: `Situation ${index}`,
  rationale: `This situation surfaces decision pattern ${index}.`,
  state: 'active' as const,
  options: Array.from({ length: 4 }, (_, optionIndex) =>
    option(`option-${optionIndex + 1}`, {
      initiative: index <= 2 ? optionIndex : 0,
      leverage: index >= 3 && index <= 4 ? optionIndex : 0,
      outwardEffect: index >= 5 && index <= 6 ? optionIndex : 0,
      strategicFocus: index >= 7 && index <= 8 ? optionIndex : 0,
      selfRevision: index >= 9 ? optionIndex : 0,
    }),
  ),
})

const instrument = {
  slug: 'self-direction-mvp',
  version: 1,
  lifecycle: 'pilot' as const,
  cadenceDays: 7,
  retestFloorHours: 72,
  compatibility: { lineage: 'self-direction-mvp', comparableToPrevious: false },
  themeDefinitions: SELF_DIRECTION_THEMES.map((key) => ({ key, description: `${key} choices` })),
  items: Array.from({ length: 10 }, (_, index) => item(index + 1)),
}

describe('SelfDirectionInstrumentDocumentSchema', () => {
  it('accepts a complete public pilot instrument and hashes it deterministically', () => {
    const parsed = SelfDirectionInstrumentDocumentSchema.parse(instrument)
    expect(parsed.items).toHaveLength(10)
    expect(selfDirectionInstrumentContentHash(parsed)).toBe(
      selfDirectionInstrumentContentHash(structuredClone(parsed)),
    )
  })

  it.each([9, 11])('refuses a published instrument with %i items', (count) => {
    const items = Array.from({ length: count }, (_, index) => item(index + 1))
    expect(() => SelfDirectionInstrumentDocumentSchema.parse({ ...instrument, items })).toThrow(
      /exactly ten/,
    )
  })

  it.each([3, 5])('refuses a published item with %i options', (count) => {
    const items = structuredClone(instrument.items)
    items[0]!.options = items[0]!.options.slice(0, count)
    if (count === 5) items[0]!.options.push(option('option-5', items[0]!.options[0]!.weights))
    expect(() => SelfDirectionInstrumentDocumentSchema.parse({ ...instrument, items })).toThrow(
      /exactly four/,
    )
  })

  it('refuses a published instrument with an uncovered theme', () => {
    const items = structuredClone(instrument.items)
    for (const one of items) for (const choice of one.options) choice.weights.selfRevision = 0
    expect(() => SelfDirectionInstrumentDocumentSchema.parse({ ...instrument, items })).toThrow(
      /at least two items/,
    )
  })

  it('refuses unknown keys and out-of-range weights', () => {
    expect(() =>
      SelfDirectionInstrumentDocumentSchema.parse({ ...instrument, secretKey: 'not allowed' }),
    ).toThrow()
    const items = structuredClone(instrument.items)
    items[0]!.options[0]!.weights.initiative = 101
    expect(() => SelfDirectionInstrumentDocumentSchema.parse({ ...instrument, items })).toThrow()
  })
})

describe('a versioned anchor and rotation pool (#1895)', () => {
  const anchors = instrument.items.slice(0, 8).map(({ key }) => key)
  const pooled = () =>
    structuredClone({
      ...instrument,
      version: 2,
      items: [...instrument.items, { ...instrument.items[0]!, key: 'rotation-item' }],
      assembly: { anchorItemKeys: anchors, rotationCount: 2 },
    })

  it('accepts a stable anchor set plus a stratified rotation count', () => {
    expect(SelfDirectionInstrumentDocumentSchema.parse(pooled()).assembly).toEqual({
      anchorItemKeys: anchors,
      rotationCount: 2,
    })
  })

  it('refuses an anchor absent from the version and any ratio not presenting ten', () => {
    const unknown = pooled()
    unknown.assembly = { anchorItemKeys: ['absent'], rotationCount: 9 }
    expect(() => SelfDirectionInstrumentDocumentSchema.parse(unknown)).toThrow(/anchor/)

    const eleven = pooled()
    eleven.assembly = { anchorItemKeys: anchors, rotationCount: 3 }
    expect(() => SelfDirectionInstrumentDocumentSchema.parse(eleven)).toThrow(/ten/)
  })
})
