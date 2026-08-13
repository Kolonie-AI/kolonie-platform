import { describe, expect, it } from 'vitest'
import { RECIPE_STEP_MAX_LENGTH, type RecipeStep } from './recipe.js'
import { DraftWordingSchema, dressWalkedSteps, whyNotPublishable } from './recipe-moderation.js'

/**
 * Writing the Colony's words onto a walked draft (`#857`).
 *
 * A walk arrives wordless on purpose (`#517`, `#601`): it records that a step
 * happened and who it needed, and the sentence describing it stays the Colony's
 * to write. Until `#857` there was nowhere to write it, so every walked draft sat
 * between a **Publish** the wordless step refused and a **Refuse** that empties
 * the row. What is asserted here is the half that was missing and, more
 * importantly, the half that must stay missing: a steward describes the shape the
 * walk recorded and cannot edit it.
 */
describe('dressing a walked draft', () => {
  const walked: readonly RecipeStep[] = [
    { actor: 'agent' },
    { actor: 'operator', ask: 'Open the signup page and confirm the address.' },
  ]

  it('writes the steward’s sentences onto the steps the walk recorded', () => {
    const dressed = dressWalkedSteps(walked, [
      { instruction: 'Ask for a mailbox at the provider.' },
      { instruction: 'The operator confirms the address.' },
    ])

    expect(dressed).toStrictEqual({
      ok: true,
      steps: [
        { actor: 'agent', instruction: 'Ask for a mailbox at the provider.' },
        {
          actor: 'operator',
          instruction: 'The operator confirms the address.',
          ask: 'Open the signup page and confirm the address.',
        },
      ],
    })
  })

  /**
   * **The recorded ask wins.** It is the sentence the Colony actually sent to
   * that operator, stored when it was sent; a later reading of the walk replacing
   * it would make the published recipe disagree with what somebody read.
   */
  it('keeps the ask the Colony sent over one the steward offers', () => {
    const dressed = dressWalkedSteps(walked, [
      { instruction: 'Ask for a mailbox at the provider.' },
      { instruction: 'The operator confirms the address.', ask: 'Do the whole signup, please.' },
    ])

    expect(dressed).toStrictEqual({
      ok: true,
      steps: [
        expect.objectContaining({ actor: 'agent' }),
        expect.objectContaining({ ask: 'Open the signup page and confirm the address.' }),
      ],
    })
  })

  /** A step the operator never saw an ask for still needs one before it publishes. */
  it('takes an ask where the walk recorded none', () => {
    const dressed = dressWalkedSteps(
      [{ actor: 'operator' }],
      [{ instruction: 'The operator creates the account.', ask: 'Please create the account.' }],
    )

    expect(dressed).toStrictEqual({
      ok: true,
      steps: [
        {
          actor: 'operator',
          instruction: 'The operator creates the account.',
          ask: 'Please create the account.',
        },
      ],
    })
  })

  it('refuses a walk that recorded no steps at all', () => {
    expect(dressWalkedSteps([], [{ instruction: 'Sign up.' }])).toStrictEqual({
      ok: false,
      why: expect.stringContaining('no steps'),
    })
  })

  /**
   * **The count is the shape, and the shape is the walk's.** A shorter list is
   * not a shorter recipe: it attaches every sentence after the gap to the wrong
   * step, and the result reads like an observation rather than a rewrite.
   */
  it('refuses a wording that describes a different number of steps', () => {
    const dressed = dressWalkedSteps(walked, [{ instruction: 'Sign up.' }])

    expect(dressed.ok).toBe(false)
    expect(dressed.ok === false && dressed.why).toContain('2')
  })

  it('refuses an ask on a step the agent did alone', () => {
    const dressed = dressWalkedSteps(
      [{ actor: 'agent' }],
      [{ instruction: 'Sign up.', ask: 'Please sign up.' }],
    )

    expect(dressed).toStrictEqual({ ok: false, why: expect.stringContaining('agent acting alone') })
  })

  it('refuses an operator step with no ask recorded and none written', () => {
    const dressed = dressWalkedSteps([{ actor: 'operator' }], [{ instruction: 'Sign up.' }])

    expect(dressed).toStrictEqual({ ok: false, why: expect.stringContaining('needs an operator') })
  })

  /**
   * The red line, on the one surface where a human types free text into an entry
   * the Colony publishes. A value written here is one the Colony holds and cannot
   * un-hold, so it is refused before it is stored rather than redacted after.
   */
  it('refuses a sentence that reads as a credential', () => {
    const dressed = dressWalkedSteps(
      [{ actor: 'agent' }],
      [{ instruction: 'Paste the token ghp_abcdefghijklmnopqrstuvwxyz01 into the field.' }],
    )

    expect(dressed).toStrictEqual({ ok: false, why: expect.stringContaining('credential') })
  })

  /** What the screen posts, parsed the way the route parses it. */
  it('takes a whole wording as the console submits it', () => {
    const parsed = DraftWordingSchema.safeParse({
      steps: [{ instruction: 'Sign up.' }],
      proves: 'rung',
      provesTask: 'github-account',
    })

    expect(parsed.success).toBe(true)
  })

  it('refuses a sentence longer than a recipe step may be', () => {
    const parsed = DraftWordingSchema.safeParse({
      steps: [{ instruction: 'a'.repeat(RECIPE_STEP_MAX_LENGTH + 1) }],
      proves: 'provider-post',
    })

    expect(parsed.success).toBe(false)
  })

  it('refuses a proof method the Colony does not recognise', () => {
    const parsed = DraftWordingSchema.safeParse({
      steps: [{ instruction: 'Sign up.' }],
      proves: 'ask-nicely',
    })

    expect(parsed.success).toBe(false)
  })

  /**
   * The point of the whole exercise: a dressed draft is one `whyNotPublishable`
   * has nothing left to say about. If this drifts, the console gains a button
   * that writes words and still cannot publish — which is the state `#857` was
   * filed about.
   */
  it('leaves a draft that publishes cleanly', () => {
    const dressed = dressWalkedSteps(walked, [
      { instruction: 'Ask for a mailbox at the provider.' },
      { instruction: 'The operator confirms the address.' },
    ])

    expect(dressed.ok).toBe(true)
    expect(
      dressed.ok &&
        whyNotPublishable({
          steps: [...dressed.steps],
          proves: 'provider-mail',
          provesTask: null,
        }),
    ).toBeUndefined()
  })
})
