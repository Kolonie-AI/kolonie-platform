import { describe, expect, it } from 'vitest'
import {
  AtlasFacetSchema,
  EARN_FACETS,
  EarnFacetSchema,
  earnFacetsMatch,
  earnFacetsOf,
  facetsFrom,
  isDualUse,
  utilityFacetsOf,
} from './atlas-facets.js'

/**
 * The multi-facet taxonomy (`#1301`).
 *
 * **What is asserted here is that nothing forces a choice.** The failure this
 * issue names is a catalogue that can say *mailbox* or *bounty board* and not
 * both, so every assertion below either puts two axes on one entry or checks
 * that a filter on one leaves the other alone.
 */

describe('the axes a facet may sit on', () => {
  it('takes a shelf slug on the utility axis, whatever the shelves are today', () => {
    /**
     * The shelves are rows since `#1102`, so the utility axis validates a shape
     * and not a list — a facet naming a shelf a maintainer added this morning has
     * to parse, or the table would be a release again.
     */
    expect(AtlasFacetSchema.parse({ axis: 'utility', slug: 'a-shelf-nobody-has-yet' })).toEqual({
      axis: 'utility',
      slug: 'a-shelf-nobody-has-yet',
    })
  })

  it('refuses an earn facet outside the five, because the count depends on it', () => {
    expect(AtlasFacetSchema.safeParse({ axis: 'earn', slug: 'bounty-board' }).success).toBe(true)
    expect(AtlasFacetSchema.safeParse({ axis: 'earn', slug: 'bounty-boards' }).success).toBe(false)
  })

  it('refuses an axis nothing holds', () => {
    expect(AtlasFacetSchema.safeParse({ axis: 'vibes', slug: 'bounty-board' }).success).toBe(false)
  })

  it('names five ways of being paid, and they are five arrangements', () => {
    expect([...EARN_FACETS]).toEqual([
      'affiliate-referral',
      'bounty-board',
      'gig-marketplace',
      'creator-payout',
      'grant-quest',
    ])
    expect(EarnFacetSchema.options.length).toBe(EARN_FACETS.length)
  })
})

describe('a provider that is two things at once', () => {
  const dual = facetsFrom(['mailbox'], ['affiliate-referral'])

  /** The acceptance criterion: the shelf and the earn facet, on one entry. */
  it('carries a shelf and an earn facet without either costing the other', () => {
    expect(dual).toEqual([
      { axis: 'utility', slug: 'mailbox' },
      { axis: 'earn', slug: 'affiliate-referral' },
    ])
    expect(utilityFacetsOf(dual)).toEqual(['mailbox'])
    expect(earnFacetsOf(dual)).toEqual(['affiliate-referral'])
    expect(isDualUse(dual)).toBe(true)
  })

  /**
   * A bounty board with nothing but the fallback shelf is the entry that made
   * the taxonomy visible — one axis answered, and it is not two.
   */
  it('does not call a pure earn rail dual use', () => {
    expect(isDualUse(facetsFrom(['data-apis'], ['bounty-board']))).toBe(true)
    expect(isDualUse(facetsFrom([], ['bounty-board']))).toBe(false)
    expect(isDualUse(facetsFrom(['mailbox'], []))).toBe(false)
  })

  it('orders the earn axis by the vocabulary, so two reads of one entry agree', () => {
    expect(earnFacetsOf(facetsFrom([], ['grant-quest', 'bounty-board', 'grant-quest']))).toEqual([
      'bounty-board',
      'grant-quest',
    ])
  })

  it('deduplicates a shelf listed twice rather than showing it twice', () => {
    expect(utilityFacetsOf(facetsFrom(['mailbox', 'mailbox'], []))).toEqual(['mailbox'])
  })
})

describe('filtering on the earn axis', () => {
  const dual = facetsFrom(['mailbox'], ['affiliate-referral'])
  const plain = facetsFrom(['mailbox'], [])
  const board = facetsFrom(['data-apis'], ['bounty-board'])

  it('matches everything when nothing is asked for', () => {
    expect(earnFacetsMatch(plain, {})).toBe(true)
    /** An empty list is an absent filter, which is what `wallsMatch` assumes too. */
    expect(earnFacetsMatch(plain, { withEarn: [] })).toBe(true)
  })

  it('keeps an entry carrying any of the facets asked for', () => {
    expect(earnFacetsMatch(dual, { withEarn: ['affiliate-referral', 'bounty-board'] })).toBe(true)
    expect(earnFacetsMatch(board, { withEarn: ['affiliate-referral', 'bounty-board'] })).toBe(true)
    expect(earnFacetsMatch(plain, { withEarn: ['affiliate-referral'] })).toBe(false)
  })

  /**
   * **Unset is not a claim that a provider pays nothing.** Nearly every entry is
   * unset because nobody has looked, so an exclusion drops what is claimed and
   * keeps what is unknown — the same rule `excludeWalls` holds.
   */
  it('drops what claims a facet and keeps what claims none', () => {
    expect(earnFacetsMatch(dual, { excludeEarn: ['affiliate-referral'] })).toBe(false)
    expect(earnFacetsMatch(plain, { excludeEarn: ['affiliate-referral'] })).toBe(true)
  })

  it('lets the exclusion win where a caller asks for both', () => {
    expect(
      earnFacetsMatch(dual, {
        withEarn: ['affiliate-referral'],
        excludeEarn: ['affiliate-referral'],
      }),
    ).toBe(false)
  })

  /** The filter reads one axis and leaves the other where it is. */
  it('says nothing about the shelf', () => {
    expect(earnFacetsMatch(board, { withEarn: ['bounty-board'] })).toBe(true)
    expect(utilityFacetsOf(board)).toEqual(['data-apis'])
  })
})
