import { describe, expect, it } from 'vitest'
import {
  RecipeStatusSchema,
  WriteProviderRecipeSchema,
  recipeStatusAllowsSteps,
  recipeStatusIsOfferable,
  recipeStatusIsPublic,
} from './recipe.js'

/**
 * The three states `#604` added, and the two properties no surface can infer
 * from the name.
 *
 * **The predicates are tested and not only the enum**, because every surface
 * branches on one of them: `recipeStatusIsPublic` decides whether a stranger
 * sees the entry at all, and `recipeStatusIsOfferable` decides whether an agent
 * may be sent to walk it. A surface that guessed would render a draft as
 * joinable, which is an agent following a recipe nobody approved.
 */
describe('the life of an Atlas entry (#604)', () => {
  it('holds all six states, in the order the life happens in', () => {
    expect(RecipeStatusSchema.options).toEqual([
      'proposed',
      'unwritten',
      'draft',
      'joinable',
      'refused',
      'retired',
    ])
  })

  it('keeps two of them off every public surface', () => {
    expect(RecipeStatusSchema.options.filter((one) => !recipeStatusIsPublic(one))).toEqual([
      'proposed',
      'draft',
    ])
  })

  /**
   * **Narrower than public, deliberately.** A retired entry has a page a reader
   * can still open and is not on offer; the two questions are not the same one.
   */
  it('offers exactly one of them to an agent', () => {
    expect(RecipeStatusSchema.options.filter(recipeStatusIsOfferable)).toEqual(['joinable'])
  })

  it('lets a walk carry steps before anybody has published it', () => {
    expect(recipeStatusAllowsSteps('draft')).toBe(true)
    expect(recipeStatusAllowsSteps('retired')).toBe(true)
    expect(recipeStatusAllowsSteps('proposed')).toBe(false)
    expect(recipeStatusAllowsSteps('unwritten')).toBe(false)
    expect(recipeStatusAllowsSteps('refused')).toBe(false)
  })

  describe('what the write shape refuses', () => {
    const entry = {
      kind: 'mailbox',
      provider: 'walked.example',
      title: 'Walked',
      category: 'mailbox',
      steps: [{ actor: 'agent', instruction: 'sign up' }],
    }

    it('takes a draft with steps and no proof', () => {
      expect(WriteProviderRecipeSchema.safeParse({ ...entry, status: 'draft' }).success).toBe(true)
    })

    it('refuses a draft with no steps, because that is an unwritten entry', () => {
      expect(
        WriteProviderRecipeSchema.safeParse({ ...entry, status: 'draft', steps: [] }).success,
      ).toBe(false)
    })

    it('refuses a withdrawal that does not say why', () => {
      expect(WriteProviderRecipeSchema.safeParse({ ...entry, status: 'retired' }).success).toBe(
        false,
      )
    })

    it('takes a withdrawal that says why, and keeps its steps', () => {
      expect(
        WriteProviderRecipeSchema.safeParse({
          ...entry,
          status: 'retired',
          retiredReason: 'the provider began demanding a phone number',
        }).success,
      ).toBe(true)
    })

    it('refuses a withdrawal reason on an entry that is not withdrawn', () => {
      expect(
        WriteProviderRecipeSchema.safeParse({
          ...entry,
          status: 'draft',
          retiredReason: 'but it is open',
        }).success,
      ).toBe(false)
    })

    it('refuses a proposal that carries steps', () => {
      expect(WriteProviderRecipeSchema.safeParse({ ...entry, status: 'proposed' }).success).toBe(
        false,
      )
    })

    /** Nothing about `#588`'s three states moved. */
    it('still refuses a joinable entry that never says how it is proved', () => {
      expect(WriteProviderRecipeSchema.safeParse({ ...entry, status: 'joinable' }).success).toBe(
        false,
      )
    })
  })
})
