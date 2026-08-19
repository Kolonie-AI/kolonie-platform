import { describe, expect, it } from 'vitest'
import { ATLAS_FALLBACK_CATEGORY, noFigures } from '@kolonie-ai/core'
import {
  atlasEarnFacets,
  atlasEarnPhrase,
  atlasIsDualUse,
  atlasShelfClause,
  atlasShelfIsClaim,
  atlasShelfIsFallback,
} from './taxonomy.js'
import type { AtlasPublicEntry } from './public-projection.js'

/**
 * Whether a shelf is a classification or the default (`#1329`).
 *
 * The rows are built by hand, as the other small modules here build theirs: what
 * is under test is the mapping from a per-row flag to a per-entry answer, and
 * the row that matters is the mixed one — a provider with one shelved kind and
 * one unshelvable — which no fixture writes.
 */
const recipe = (over: Record<string, unknown> = {}) =>
  ({
    kind: 'bounty-board',
    provider: 'earner.example',
    category: ATLAS_FALLBACK_CATEGORY,
    categoryIsFallback: true,
    figures: noFigures('bounty-board', 'earner.example'),
    ...over,
  }) as unknown as AtlasPublicEntry['recipes'][number]

const entry = (over: Partial<AtlasPublicEntry> = {}): AtlasPublicEntry =>
  ({
    provider: 'earner.example',
    title: 'Earner',
    path: '/atlas/earner.example',
    status: 'measured',
    category: ATLAS_FALLBACK_CATEGORY,
    facets: [{ axis: 'utility', slug: ATLAS_FALLBACK_CATEGORY }],
    recipes: [recipe()],
    ...over,
  }) as unknown as AtlasPublicEntry

describe('whether an Atlas shelf is a claim or the default', () => {
  /**
   * The entry `#1326` was opened about: a bounty board whose kind reaches no
   * shelf, filed on `data-apis` because one had to be chosen, and rendered as
   * though somebody had classified it.
   */
  it('calls a shelf nobody chose the default', () => {
    expect(atlasShelfIsFallback(entry())).toBe(true)
    expect(atlasShelfIsClaim(entry())).toBe(false)
  })

  it('calls a shelf somebody chose a claim', () => {
    const shelved = entry({
      category: 'mailbox',
      recipes: [recipe({ kind: 'mailbox', category: 'mailbox', categoryIsFallback: undefined })],
    })

    expect(atlasShelfIsFallback(shelved)).toBe(false)
    expect(atlasShelfIsClaim(shelved)).toBe(true)
    expect(atlasShelfClause(shelved)).toBeUndefined()
  })

  /**
   * **Every row that put it there has to be a fallback.** An entry is a provider
   * and its recipes are kinds (`#960`), so a provider with a catalogued mailbox
   * and an unshelvable bounty board has a shelf somebody chose — demoting it
   * would hide a real classification behind a second row's absence.
   */
  it('keeps the shelf where one row of the entry was genuinely classified', () => {
    const mixed = entry({
      category: 'mailbox',
      recipes: [
        recipe({ kind: 'mailbox', category: 'mailbox', categoryIsFallback: undefined }),
        recipe(),
      ],
    })

    expect(atlasShelfIsFallback(mixed)).toBe(false)
  })

  /**
   * **Nothing, rather than *no shelf fits it yet*, where an earn facet already
   * classifies the provider.** A reader told *pays for finished tasks* has been
   * told what this is; adding the Colony's own bookkeeping to that spends a
   * clause on nothing.
   */
  it('says nothing about the shelf when an earn facet has classified it', () => {
    const earning = entry({
      facets: [
        { axis: 'utility', slug: ATLAS_FALLBACK_CATEGORY },
        { axis: 'earn', slug: 'bounty-board' },
      ],
    })

    expect(atlasEarnFacets(earning)).toEqual(['bounty-board'])
    expect(atlasShelfClause(earning)).toBeUndefined()
  })

  /**
   * And where nothing else classifies it, the page says so in words — an omitted
   * shelf with no explanation reads as one nobody asked about.
   */
  it('says no shelf fits it where nothing else classifies it either', () => {
    expect(atlasShelfClause(entry())).toBe('no shelf fits it yet')
  })

  /**
   * The two facets whose slugs do not survive contact with a reader who is not a
   * citizen. `bounty-board` nearly does; `creator-payout` does not.
   */
  it('says what an earn facet means, rather than printing its slug', () => {
    expect(atlasEarnPhrase('creator-payout')).toBe('pays for an audience')
    expect(atlasEarnPhrase('grant-quest')).toBe('pays for accepted proposals')
  })

  /**
   * **A fallback shelf is not a utility claim** (`#1388`).
   *
   * Measured on `clawlancer.ai` the day after `#1332` shipped the chip: a bounty
   * board on the `data-apis` default, wearing *worth holding, and pays*. `#1329`
   * had demoted that shelf out of the header two clauses earlier because it is a
   * default; the chip put it back in stronger words.
   */
  it('is not dual use when the only utility facet is a shelf nobody chose', () => {
    const earning = entry({
      facets: [
        { axis: 'utility', slug: ATLAS_FALLBACK_CATEGORY },
        { axis: 'earn', slug: 'bounty-board' },
      ],
    })

    expect(atlasIsDualUse(earning)).toBe(false)
    /** And the earn claim is untouched — one true statement stays. */
    expect(atlasEarnFacets(earning)).toEqual(['bounty-board'])
  })

  /**
   * **And a genuinely shelved provider that pays still is**, which is the case
   * the axis exists for (`#1301`): a mailbox somebody classified, that also pays
   * a referral.
   */
  it('is dual use when somebody chose the shelf', () => {
    const mailbox = entry({
      category: 'mailbox',
      recipes: [recipe({ kind: 'mailbox', category: 'mailbox', categoryIsFallback: undefined })],
      facets: [
        { axis: 'utility', slug: 'mailbox' },
        { axis: 'earn', slug: 'affiliate-referral' },
      ],
    })

    expect(atlasIsDualUse(mailbox)).toBe(true)
  })

  /** One axis is not two, whichever axis it is. */
  it('is not dual use on one axis alone', () => {
    const shelvedOnly = entry({
      category: 'mailbox',
      recipes: [recipe({ kind: 'mailbox', category: 'mailbox', categoryIsFallback: undefined })],
      facets: [{ axis: 'utility', slug: 'mailbox' }],
    })

    expect(atlasIsDualUse(shelvedOnly)).toBe(false)
  })
})
