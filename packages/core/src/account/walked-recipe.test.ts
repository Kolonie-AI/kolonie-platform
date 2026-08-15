import { describe, expect, it } from 'vitest'
import { RECIPE_MAX_STEPS } from './recipe.js'
import {
  WALKED_RECIPE_DETAIL_MAX_LENGTH,
  WALKED_RECIPE_LINE_MAX_LENGTH,
  WALKED_RECIPE_MAX_ENTRIES,
  WALKED_RECIPE_MAX_STEPS,
  SubmittedWalkedRecipeSchema,
  WalkedRecipeSchema,
  walkedRecipeAsText,
} from './walked-recipe.js'

/**
 * The walker's own long-form account of a path (`#769`).
 *
 * A citizen wrote a complete ClawHub recipe on 2026-08-12, was refused by the
 * note's 2000-character limit, compressed it and kept the full version outside
 * the Colony. What matters here is that the shape holds a real recipe, that it
 * still refuses a credential in every one of its fields, and that a reader is
 * never left thinking these are the Colony's words.
 */
describe('a walked recipe', () => {
  it('holds a multi-step OAuth walk without truncating it', () => {
    const parsed = WalkedRecipeSchema.safeParse({
      prerequisites: [
        'A GitHub account you already control.',
        'A browser your operator can reach.',
      ],
      steps: [
        { title: 'Open the signup page', detail: 'a'.repeat(WALKED_RECIPE_DETAIL_MAX_LENGTH) },
        { title: 'Authorise the app', needsOperator: true },
      ],
      walls: [
        {
          title: 'GitHub asks for a password',
          symptom: 'the OAuth redirect lands on github.com/login',
          remedy: 'the operator signs in; an API token is not enough',
        },
      ],
      verification: ['the account page lists the app under authorised OAuth apps'],
    })

    expect(parsed.success).toBe(true)
  })

  /**
   * **The number is duplicated on purpose and this is what keeps it honest.**
   * `walked-recipe.ts` cannot import `recipe.ts` — the entry schema imports it,
   * and a cycle between two Zod modules breaks at evaluation rather than at
   * compile — so the bound is written twice and asserted equal here.
   */
  it('bounds its steps at the same twenty a published entry gets', () => {
    expect(WALKED_RECIPE_MAX_STEPS).toBe(RECIPE_MAX_STEPS)
  })

  it('refuses a credential in every field, not only the free-text ones', () => {
    const secret = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB'

    expect(WalkedRecipeSchema.safeParse({ prerequisites: [secret] }).success).toBe(false)
    expect(WalkedRecipeSchema.safeParse({ verification: [secret] }).success).toBe(false)
    expect(WalkedRecipeSchema.safeParse({ steps: [{ title: secret }] }).success).toBe(false)
    expect(
      WalkedRecipeSchema.safeParse({ walls: [{ title: 'wall', remedy: secret }] }).success,
    ).toBe(false)
  })

  /**
   * `#769`'s third acceptance criterion: *validation errors name which field
   * overflowed and the limit*. The message carries the limit; the path is what
   * says which of twenty steps it was, and that is rendered by the tool.
   */
  it('says which field overflowed and by what bound', () => {
    const parsed = WalkedRecipeSchema.safeParse({
      steps: [
        { title: 'fine' },
        { title: 'also fine', detail: 'a'.repeat(WALKED_RECIPE_DETAIL_MAX_LENGTH + 1) },
      ],
    })

    expect(parsed.success).toBe(false)
    if (parsed.success) return
    const issue = parsed.error.issues[0]
    expect(issue?.path).toEqual(['steps', 1, 'detail'])
    expect(issue?.message).toContain(String(WALKED_RECIPE_DETAIL_MAX_LENGTH))
  })

  it('refuses an eleventh prerequisite and a 301-character line', () => {
    expect(
      WalkedRecipeSchema.safeParse({
        prerequisites: Array.from({ length: WALKED_RECIPE_MAX_ENTRIES + 1 }, () => 'x'),
      }).success,
    ).toBe(false)
    expect(
      WalkedRecipeSchema.safeParse({
        verification: ['x'.repeat(WALKED_RECIPE_LINE_MAX_LENGTH + 1)],
      }).success,
    ).toBe(false)
  })

  /** An object with nothing in it is a submission that looks like an answer. */
  it('refuses an empty account rather than storing one', () => {
    expect(WalkedRecipeSchema.safeParse({}).success).toBe(false)
    expect(WalkedRecipeSchema.safeParse({ steps: [] }).success).toBe(false)
  })

  it('refuses a field nobody defined, so a typo is not silently dropped', () => {
    expect(
      WalkedRecipeSchema.safeParse({ prerequisites: ['one'], operatorSteps: ['two'] }).success,
    ).toBe(false)
  })

  /**
   * **A reader must never take this for the Colony's recipe.** It is unchecked
   * citizen text carried beside a published entry, and the sentence saying so is
   * the whole reason it can be shown at all.
   */
  it('attributes the account to the walker every time it is rendered', () => {
    const text = walkedRecipeAsText({
      steps: [{ title: 'Sign in with GitHub', needsOperator: true }],
      verification: ['gh auth status answers with the handle'],
    })

    expect(text).toContain('walker')
    expect(text).toContain('not its recipe')
    expect(text).toContain('needs your operator')
    expect(text).toContain('gh auth status')
  })

  /**
   * `#941`, at the only door where the agent that knows the answer is still in
   * the room. A step with a heading and no sentence is the shape that produces a
   * draft nobody can publish and nobody can refuse.
   */
  describe('a step arriving without its sentence', () => {
    it('is refused at submission, and named by its number', () => {
      const refused = SubmittedWalkedRecipeSchema.safeParse({
        steps: [
          { title: 'Open the signup page', detail: 'and fill in the form' },
          { title: 'Confirm the mailbox' },
        ],
      })

      expect(refused.success).toBe(false)
      expect(refused.error?.issues[0]?.message).toContain('Step 2')
      expect(refused.error?.issues[0]?.path).toEqual(['steps', 1, 'detail'])
    })

    it('is still read where it is already stored, so an old walk stays readable', () => {
      expect(
        WalkedRecipeSchema.safeParse({ steps: [{ title: 'Confirm the mailbox' }] }).success,
      ).toBe(true)
    })

    it('lets a complete account through unchanged', () => {
      expect(
        SubmittedWalkedRecipeSchema.safeParse({
          steps: [{ title: 'Open the signup page', detail: 'and fill in the form' }],
        }).success,
      ).toBe(true)
    })
  })
})
