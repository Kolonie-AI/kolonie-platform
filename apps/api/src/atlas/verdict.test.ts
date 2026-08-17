import { describe, expect, it } from 'vitest'
import { noFigures, type AtlasFigures } from '@kolonie-ai/core'
import { atlasEntryVerdict, atlasRecipeVerdict } from './verdict.js'
import type { AtlasPublicEntry, AtlasPublicRecipe } from './public-projection.js'

/**
 * What a page may claim at the top, which is the whole of `#1163`.
 *
 * **The rows are built by hand**, as `worked.test.ts` and `structured-data.
 * test.ts` build theirs and for the same reason: what is under test is the
 * mapping from one row's status and numbers to one word, and the interesting row
 * is the one no fixture writes on purpose — a refusal with successful walks
 * underneath it.
 */
const figures = (over: Partial<AtlasFigures> = {}): AtlasFigures => ({
  ...noFigures('phone', 'phone.example'),
  ...over,
})

/** A walk that got in, past the floor, in the shape the projection hands over. */
const gotIn = figures({ evidenced: true, attempted: 9, proved: 2 })

const recipe = (over: Partial<AtlasPublicRecipe> = {}): AtlasPublicRecipe =>
  ({
    kind: 'phone',
    provider: 'phone.example',
    status: 'joinable',
    figures: figures(),
    walls: [],
    ...over,
  }) as unknown as AtlasPublicRecipe

const entry = (over: Partial<AtlasPublicEntry> = {}): AtlasPublicEntry =>
  ({
    provider: 'phone.example',
    title: 'A phone number of the agent’s own',
    path: '/atlas/phone.example',
    status: 'joinable',
    category: 'telephony',
    recipes: [recipe()],
    ...over,
  }) as unknown as AtlasPublicEntry

describe('one capability’s verdict', () => {
  it('takes a steward’s joinable and a row nobody has written at their word', () => {
    expect(atlasRecipeVerdict(recipe({ status: 'joinable' }))).toBe('joinable')
    expect(atlasRecipeVerdict(recipe({ status: 'unwritten' }))).toBe('unwritten')
  })

  /**
   * **The row `#1163` was measured on.** `agentphone.ai` was refused and had
   * browser signup, REST signup, an API key and inbound SMS polling behind it;
   * under the old model the page had one word for that and it was *refused*.
   */
  it('calls a refusal with successful walks partly, and never refused', () => {
    expect(atlasRecipeVerdict(recipe({ status: 'refused', figures: gotIn }))).toBe('partly')
    expect(atlasRecipeVerdict(recipe({ status: 'retired', figures: gotIn }))).toBe('partly')
  })

  it('keeps a refusal nobody got through refused', () => {
    expect(atlasRecipeVerdict(recipe({ status: 'refused' }))).toBe('refused')
  })

  /**
   * A declaration is not evidence (`#977`), so an unevidenced figure cannot buy a
   * refusal the softer word. This is the rejection case for the whole model: the
   * one input that would let a provider talk its way out of a refusal is the one
   * that is not read.
   */
  it('will not soften a refusal on figures nothing evidences', () => {
    const declared = figures({ evidenced: false, attempted: 9, proved: 9 })

    expect(atlasRecipeVerdict(recipe({ status: 'refused', figures: declared }))).toBe('refused')
  })

  /**
   * `#1032` made `measured` *a walk closed here and nobody wrote the route*. With
   * a success behind it that is a partial finding; without one there is nothing to
   * put in a headline, and the row's own section says what happened in its own
   * words.
   */
  it('splits a measured row on whether the walk got in', () => {
    expect(atlasRecipeVerdict(recipe({ status: 'measured', figures: gotIn }))).toBe('partly')
    expect(atlasRecipeVerdict(recipe({ status: 'measured' }))).toBe('unwritten')
  })
})

describe('an entry’s verdict', () => {
  it('lets a walkable row outrank everything on the page', () => {
    const mixed = entry({
      status: 'refused',
      recipes: [recipe({ status: 'refused' }), recipe({ status: 'joinable' })],
    })

    expect(atlasEntryVerdict(mixed)).toBe('joinable')
  })

  /** The contradiction, at the level the title and the shelf chip read. */
  it('rolls a refused entry with one successful row up to partly', () => {
    const measured = entry({
      status: 'refused',
      recipes: [recipe({ status: 'refused' }), recipe({ status: 'refused', figures: gotIn })],
    })

    expect(atlasEntryVerdict(measured)).toBe('partly')
  })

  it('keeps a refusal with nothing behind it refused', () => {
    expect(atlasEntryVerdict(entry({ status: 'refused', recipes: [] }))).toBe('refused')
    expect(
      atlasEntryVerdict(entry({ status: 'refused', recipes: [recipe({ status: 'refused' })] })),
    ).toBe('refused')
  })

  it('says nothing about a provider nobody has touched', () => {
    expect(
      atlasEntryVerdict(entry({ status: 'unwritten', recipes: [recipe({ status: 'unwritten' })] })),
    ).toBe('unwritten')
    expect(atlasEntryVerdict(entry({ status: 'unwritten', recipes: [] }))).toBe('unwritten')
  })
})
