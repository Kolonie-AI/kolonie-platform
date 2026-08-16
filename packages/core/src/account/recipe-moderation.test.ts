import { describe, expect, it } from 'vitest'
import { RECIPE_STEP_MAX_LENGTH } from './recipe.js'
import {
  EntryWordingSchema,
  RECIPE_DRAFT_EXPIRY_DAYS,
  noRecipeStagesRun,
  recipeDraftExpired,
  routeFromWording,
  whyNotPublishable,
  whyRecipeHeld,
} from './recipe-moderation.js'

/**
 * Writing the route a measured entry publishes (`#857`, rewritten by `#1032`).
 *
 * `#857` had a steward dress the steps a walk observed, one sentence per
 * observed step, and forbade it from touching the shape — the shape was the
 * walk's record of what happened. `#1032` took the walk out of the entry: a walk
 * writes a `measured` row with no steps at all and publishes its own account of
 * the path in the provider's briefing instead. So there is no shape here to
 * preserve, and what is asserted is the rule that survived the change — an ask
 * belongs to an operator and to nobody else — plus the red line on the one
 * surface where free text becomes something the Colony stands behind.
 */
describe('writing the route on a measured entry', () => {
  it('takes the whole route, actor by actor', () => {
    const route = routeFromWording([
      { actor: 'agent', instruction: 'Ask for a mailbox at the provider.' },
      {
        actor: 'operator',
        instruction: 'The operator confirms the address.',
        ask: 'Open the signup page and confirm the address.',
      },
    ])

    expect(route).toStrictEqual({
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

  /** `secret` is what routes the answer (`#529`), so it is written here or nowhere. */
  it('carries a step that comes back with a secret', () => {
    const route = routeFromWording([
      {
        actor: 'operator',
        instruction: 'The operator reads the code out of the mail.',
        ask: 'Please paste the code you were sent.',
        secret: true,
      },
    ])

    expect(route).toStrictEqual({
      ok: true,
      steps: [expect.objectContaining({ secret: true })],
    })
  })

  it('refuses an ask on a step the agent does alone', () => {
    const route = routeFromWording([
      { actor: 'agent', instruction: 'Sign up.', ask: 'Please sign up.' },
    ])

    expect(route).toStrictEqual({ ok: false, why: expect.stringContaining('agent acting alone') })
  })

  it('refuses an operator step with no ask', () => {
    const route = routeFromWording([{ actor: 'operator', instruction: 'Sign up.' }])

    expect(route).toStrictEqual({ ok: false, why: expect.stringContaining('needs an operator') })
  })

  /**
   * The red line, on the one surface where free text is typed into an entry the
   * Colony publishes. A value written here is one the Colony holds and cannot
   * un-hold, so it is refused before it is stored rather than redacted after.
   */
  it('refuses a sentence that reads as a credential', () => {
    const route = routeFromWording([
      {
        actor: 'agent',
        instruction: 'Paste the token ghp_abcdefghijklmnopqrstuvwxyz01 into the field.',
      },
    ])

    expect(route).toStrictEqual({ ok: false, why: expect.stringContaining('credential') })
  })

  /** What the screen posts, parsed the way the route parses it. */
  it('takes a whole wording as the console submits it', () => {
    const parsed = EntryWordingSchema.safeParse({
      steps: [{ actor: 'agent', instruction: 'Sign up.' }],
      proves: 'rung',
      provesTask: 'github-account',
    })

    expect(parsed.success).toBe(true)
  })

  /** A step with no actor is a step nobody is asked to take. */
  it('refuses a step that does not say who acts', () => {
    const parsed = EntryWordingSchema.safeParse({
      steps: [{ instruction: 'Sign up.' }],
      proves: 'provider-post',
    })

    expect(parsed.success).toBe(false)
  })

  it('refuses a sentence longer than a recipe step may be', () => {
    const parsed = EntryWordingSchema.safeParse({
      steps: [{ actor: 'agent', instruction: 'a'.repeat(RECIPE_STEP_MAX_LENGTH + 1) }],
      proves: 'provider-post',
    })

    expect(parsed.success).toBe(false)
  })

  it('refuses a proof method the Colony does not recognise', () => {
    const parsed = EntryWordingSchema.safeParse({
      steps: [{ actor: 'agent', instruction: 'Sign up.' }],
      proves: 'ask-nicely',
    })

    expect(parsed.success).toBe(false)
  })

  /**
   * The point of the whole exercise: a written route is one `whyNotPublishable`
   * has nothing left to say about. If this drifts, the console gains a button
   * that writes words and still cannot publish — which is the state `#857` was
   * filed about.
   */
  it('leaves an entry that publishes cleanly', () => {
    const route = routeFromWording([
      { actor: 'agent', instruction: 'Ask for a mailbox at the provider.' },
      {
        actor: 'operator',
        instruction: 'The operator confirms the address.',
        ask: 'Open the signup page and confirm the address.',
      },
    ])

    expect(route.ok).toBe(true)
    expect(
      route.ok &&
        whyNotPublishable({
          steps: [...route.steps],
          proves: 'provider-mail',
          provesTask: null,
        }),
    ).toBeUndefined()
  })
})

/**
 * The fortnight after which a draft nobody could complete is withdrawn (`#941`).
 *
 * A held draft is a decision that has already been taken and keeps being taken:
 * the pass re-judges it every tick and reaches the same verdict, and until the
 * window existed it did so forever. What is asserted here is the half a walker
 * reads — *why* it was withdrawn — because a withdrawal without a reason is
 * indistinguishable from the Colony having lost the entry.
 */
describe('a draft the window ran out on', () => {
  it('carries what the last verdict held it on', () => {
    const stages = noRecipeStagesRun()
    stages.publishable = { outcome: 'incomplete', reason: 'Step 2 has no sentence.' }

    expect(whyRecipeHeld(stages)).toBe('Step 2 has no sentence.')
    expect(recipeDraftExpired(whyRecipeHeld(stages))).toContain('Step 2 has no sentence.')
  })

  /**
   * A verdict stops at the stage that held it, so the reason furthest down is the
   * one it stopped on. An earlier stage's note sits beside a stage that
   * nonetheless let the draft through.
   */
  it('reads the last stage that recorded a reason, not the first', () => {
    const stages = noRecipeStagesRun()
    stages.redLine = { outcome: 'clear', reason: 'Nothing here reads as a bypass.' }
    stages.steps = { outcome: 'unsound', reason: 'Step 3 does not say where the link goes.' }

    expect(whyRecipeHeld(stages)).toBe('Step 3 does not say where the link goes.')
  })

  it('says so plainly where no verdict recorded one', () => {
    expect(whyRecipeHeld(noRecipeStagesRun())).toBeUndefined()
    expect(recipeDraftExpired(undefined)).toContain('No verdict recorded')
  })

  /**
   * **Withdrawn and not refused**, and the sentence has to say so: a refusal
   * means the provider cannot be joined honestly, and nothing about running out
   * of time says that. A walker reading this must come away knowing a fresh walk
   * would replace it.
   */
  it('does not read as a refusal of the provider', () => {
    const text = recipeDraftExpired('Step 2 has no sentence.')

    expect(text).toContain(String(RECIPE_DRAFT_EXPIRY_DAYS))
    expect(text).toContain('withdrawn')
    expect(text).toContain('fresh walk')
    expect(text).toContain('Nothing about this says the provider cannot be joined')
  })
})
