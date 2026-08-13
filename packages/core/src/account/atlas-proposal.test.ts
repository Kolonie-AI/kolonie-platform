import { describe, expect, it } from 'vitest'
import { AccountKindSchema } from './account.js'
import {
  atlasCategoryForKind,
  KIND_BY_ATLAS_CATEGORY,
  wishAtlasAnswer,
  wishAtlasSentence,
  type WishAtlasAnswer,
} from './atlas-proposal.js'

describe('where a provider a citizen asked for stands', () => {
  const decided = (
    status: 'pending' | 'accepted' | 'refused' | 'merged',
    fields: { readonly decidedReason?: string; readonly mergedInto?: string } = {},
  ) => ({
    status,
    decidedReason: fields.decidedReason ?? null,
    mergedInto: fields.mergedInto ?? null,
  })

  it('says the Atlas holds it when there was nothing to propose', () => {
    expect(wishAtlasAnswer({ proposal: null, listed: true })).toEqual({ answer: 'listed' })
  })

  it('says nothing has been put to the Colony for a wish that predates the door', () => {
    expect(wishAtlasAnswer({ proposal: null, listed: false })).toEqual({ answer: 'absent' })
  })

  it('carries the steward’s own words on a refusal', () => {
    expect(
      wishAtlasAnswer({
        proposal: decided('refused', { decidedReason: 'It sells to people and not to agents.' }),
        listed: false,
      }),
    ).toEqual({ answer: 'refused', reason: 'It sells to people and not to agents.' })
  })

  it('names the entry a merge landed in', () => {
    expect(
      wishAtlasAnswer({ proposal: decided('merged', { mergedInto: 'notion.so' }), listed: false }),
    ).toEqual({ answer: 'merged', into: 'notion.so' })
  })

  /**
   * The table refuses both of these, so neither is reachable today. They are
   * asserted because a surface reading a decision has to survive the constraint
   * being relaxed without telling a citizen that a refusal has no reason.
   */
  it('repairs a refusal that lost its reason rather than rendering an empty one', () => {
    const atlas = wishAtlasAnswer({ proposal: decided('refused'), listed: false })

    expect(atlas).toEqual({ answer: 'refused', reason: 'No reason was recorded.' })
    expect(wishAtlasSentence('somewhere.example', atlas)).toContain('No reason was recorded.')
  })

  /**
   * The pair exists as soon as an accepted proposal is walked and published, and
   * a stale *nobody has walked this yet* is worse than no answer.
   */
  it('lets a published entry outrank the proposal that asked for it', () => {
    expect(wishAtlasAnswer({ proposal: decided('accepted'), listed: true })).toEqual({
      answer: 'listed',
    })
  })

  /**
   * Accepting a proposal writes the listing, so *nothing was put to the Colony*
   * would be the flat opposite of what happened to the citizen who put it.
   */
  it('does not tell a citizen its accepted proposal was never made', () => {
    const sentence = wishAtlasSentence('somewhere.example', { answer: 'listed' })

    expect(sentence).not.toMatch(/nothing to put|nothing was put/i)
    expect(sentence).toContain('kolonie.accounts.recipes')
  })

  it('reads a merge that names no entry as an acceptance', () => {
    expect(wishAtlasAnswer({ proposal: decided('merged'), listed: false })).toEqual({
      answer: 'accepted',
    })
  })

  /**
   * **Every answer names a call**, which is the property that makes a verdict
   * actionable rather than something an agent asks about again next waking.
   */
  it('names a next move in every sentence', () => {
    const answers: readonly WishAtlasAnswer[] = [
      { answer: 'listed' },
      { answer: 'pending' },
      { answer: 'accepted' },
      { answer: 'refused', reason: 'It sells to people and not to agents.' },
      { answer: 'merged', into: 'notion.so' },
      { answer: 'absent' },
    ]

    for (const atlas of answers) {
      const sentence = wishAtlasSentence('somewhere.example', atlas)

      expect(sentence).toMatch(/kolonie\.accounts\.|wishing for it again|Writing the wish again/)
      expect(sentence.length).toBeGreaterThan(40)
    }
  })

  it('quotes the refusal rather than summarising it', () => {
    expect(
      wishAtlasSentence('somewhere.example', {
        answer: 'refused',
        reason: 'It sells to people and not to agents.',
      }),
    ).toContain('It sells to people and not to agents.')
  })
})

describe('the Atlas shelf for an account kind', () => {
  it('reverses every current category-to-kind entry', () => {
    for (const [category, kind] of Object.entries(KIND_BY_ATLAS_CATEGORY)) {
      expect(atlasCategoryForKind(AccountKindSchema.parse(kind))).toBe(category)
    }
  })

  it('keeps the established GitHub holding on the code-hosting shelf', () => {
    expect(atlasCategoryForKind(AccountKindSchema.parse('github'))).toBe('code-hosting')
  })

  it('refuses to invent a shelf for an unmapped kind', () => {
    expect(() => atlasCategoryForKind(AccountKindSchema.parse('unmapped-kind'))).toThrow(
      'No Atlas category maps to account kind unmapped-kind',
    )
  })
})
