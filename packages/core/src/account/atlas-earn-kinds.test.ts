import { describe, expect, it } from 'vitest'
import { EARN_FACET_KINDS, earnFacetForKind, earnFacetsForKind } from './atlas-earn-kinds.js'
import { EARN_FACETS } from './atlas-facets.js'

describe('the earn facet an account kind is one of by definition', () => {
  it('answers each of the five kinds `#1326` froze', () => {
    expect(earnFacetForKind('bounty-board')).toBe('bounty-board')
    expect(earnFacetForKind('gig-marketplace')).toBe('gig-marketplace')
    expect(earnFacetForKind('microtask-board')).toBe('bounty-board')
    expect(earnFacetForKind('survey-panel')).toBe('creator-payout')
    expect(earnFacetForKind('rewards-platform')).toBe('creator-payout')
  })

  /**
   * **The mapping is the whole of it and nothing else may creep in.** A kind
   * that is an earn rail in somebody's reading of its name — `marketplace`,
   * `freelance`, `paid-api` — is exactly the inference `#1301` refuses, and it
   * would arrive here as one more key rather than as a decision.
   */
  it('maps exactly those five and no others', () => {
    expect(EARN_FACET_KINDS).toEqual([
      'bounty-board',
      'gig-marketplace',
      'microtask-board',
      'rewards-platform',
      'survey-panel',
    ])
  })

  /**
   * **A kind that is not an earn rail is the ordinary case, not an unmapped
   * one**, which is what separates this lookup from `atlasCategoryForKind`
   * beside it: that one throws, because a missing shelf is a gap in the
   * catalogue, and a missing earn facet is the answer.
   */
  it('says nothing about a kind that is not an earn rail, and does not throw', () => {
    expect(earnFacetForKind('mailbox')).toBeUndefined()
    expect(earnFacetForKind('social')).toBeUndefined()
    expect(earnFacetForKind('code-host')).toBeUndefined()
    expect(earnFacetsForKind('mailbox')).toEqual([])
  })

  /**
   * `#1326` decision 5 froze the vocabulary at five and mapped the two kinds
   * that have no facet of their own onto the nearest. Asserted so that a sixth
   * facet cannot be introduced through this table by somebody who meant to
   * expand the enum — the expansion is its own decision.
   */
  it('never produces a facet outside the frozen five', () => {
    for (const kind of EARN_FACET_KINDS) {
      const facet = earnFacetForKind(kind)
      expect(facet).toBeDefined()
      expect(EARN_FACETS).toContain(facet)
    }
  })

  /** Through the aliases (`#1144`), so a spelling and its kind agree. */
  it('resolves a spelling before it looks it up', () => {
    expect(earnFacetForKind('unknown-kind-nobody-registered')).toBeUndefined()
  })
})
