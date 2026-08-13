import { describe, expect, it } from 'vitest'
import { AccountKindSchema } from './account.js'
import { atlasCategoryForKind, KIND_BY_ATLAS_CATEGORY } from './atlas-proposal.js'

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
