import { describe, expect, it } from 'vitest'
import {
  episodeToSteps,
  episodeVerdict,
  type ObservedEpisode,
  type ObservedSlot,
} from './episode-recipe.js'
import { RECIPE_MAX_STEPS, RecipeStepSchema } from './recipe.js'

/**
 * What a closed acquisition episode says about the provider (`#935`).
 *
 * **The decision, as a pure function.** The storage half — that closing an
 * episode once writes one draft, stamps the attribution and destroys the secrets
 * in the same call — is in `packages/db` against a real Postgres. Neither is the
 * other, which is the split `walk.test.ts` already draws.
 */

const slot = (
  label: string,
  by: 'agent' | 'operator',
  extra: Partial<ObservedSlot> = {},
): ObservedSlot => ({
  label,
  secret: false,
  filledBy: by,
  filledAt: '2026-08-13T10:00:00.000Z',
  ...extra,
})

const acquisition: ObservedEpisode = { kind: 'acquisition', outcome: 'created', wall: null }

describe('episodeToSteps', () => {
  it('turns filled slots into steps, in the order they were filled', () => {
    const steps = episodeToSteps([
      slot('third', 'agent', { filledAt: '2026-08-13T12:00:00.000Z' }),
      slot('first', 'agent', { filledAt: '2026-08-13T10:00:00.000Z' }),
      slot('second', 'operator', { filledAt: '2026-08-13T11:00:00.000Z' }),
    ])

    expect(steps.map((one) => one.actor)).toEqual(['agent', 'operator', 'agent'])
  })

  /**
   * Two slots inside one clock tick would otherwise come back in whatever order
   * the database happened to return, and a recipe whose step order changes
   * between reads is one a steward cannot review.
   */
  it('breaks a tie on the label rather than on the order it was handed', () => {
    const at = '2026-08-13T10:00:00.000Z'
    const one = episodeToSteps([
      slot('b', 'agent', { filledAt: at }),
      slot('a', 'agent', { filledAt: at }),
    ])
    const two = episodeToSteps([
      slot('a', 'agent', { filledAt: at }),
      slot('b', 'agent', { filledAt: at }),
    ])

    expect(one).toEqual(two)
  })

  /**
   * A container somebody opened and abandoned observed nothing, and
   * `account_slots` has no creation timestamp to order it by even if it were
   * wanted.
   */
  it('leaves out a slot nobody filled', () => {
    expect(
      episodeToSteps([
        slot('open', 'agent', { filledBy: null, filledAt: null }),
        slot('done', 'agent'),
      ]),
    ).toHaveLength(1)
  })

  /**
   * `RecipeStepSchema` requires an ask on every operator step and refuses one on
   * an agent step. The label is the sentence the operator actually read — the
   * console renders it under *What it is* and as the fill input's `aria-label` —
   * so it is text a human saw rather than text invented for them afterwards.
   */
  it('carries the label as the ask, and only where an operator filled it', () => {
    const [operator, agent] = episodeToSteps([
      slot('a-the-operator-step', 'operator'),
      slot('b-the-agent-step', 'agent'),
    ])

    expect(operator?.ask).toBe('a-the-operator-step')
    expect(agent).not.toHaveProperty('ask')
  })

  /**
   * An agent-filled secret is the handover direction — the agent choosing a
   * password and sealing it for the console — and in recipe terms that is not a
   * step where the provider asks a human for something.
   */
  it('marks only an operator step secret', () => {
    const [operator, agent] = episodeToSteps([
      slot('a-operator', 'operator', { secret: true }),
      slot('b-agent', 'agent', { secret: true }),
    ])

    expect(operator?.secret).toBe(true)
    expect(agent).not.toHaveProperty('secret')
  })

  it('produces steps a recipe will accept', () => {
    for (const step of episodeToSteps([
      slot('a', 'operator', { secret: true }),
      slot('b', 'agent'),
    ])) {
      expect(() => RecipeStepSchema.parse(step)).not.toThrow()
    }
  })

  /**
   * The acceptance criterion `#935` states as a test: no selector, no provider
   * field name, no screenshot — and no invented sentence either, which is what
   * makes these steps a draft rather than the Colony's own words.
   */
  it('carries nothing but the actor, the ask and whether it was secret', () => {
    for (const step of episodeToSteps([
      slot('a', 'operator', { secret: true }),
      slot('b', 'agent'),
    ])) {
      expect(Object.keys(step).sort()).not.toContain('instruction')
      expect(Object.keys(step).every((key) => ['actor', 'ask', 'secret'].includes(key))).toBe(true)
    }
  })
})

describe('episodeVerdict', () => {
  /**
   * **The rejection case `#935` names.** A maintenance episode is about an
   * account that already exists and its steps are repairs, so it must never
   * become part of a recipe — asked before anything else, so no later branch can
   * reach one by another route.
   */
  it('proposes nothing from a maintenance episode, however it closed', () => {
    for (const outcome of ['created', 'repaired', 'failed', 'abandoned'] as const) {
      const verdict = episodeVerdict(
        { kind: 'maintenance', outcome, wall: outcome === 'failed' ? 'the wall' : null },
        [slot('a', 'agent')],
        undefined,
      )

      expect(verdict.kind).toBe('nothing')
    }
  })

  it('proposes a draft from a closed acquisition', () => {
    const verdict = episodeVerdict(acquisition, [slot('a', 'agent')], undefined)

    expect(verdict).toEqual({ kind: 'draft', steps: [{ actor: 'agent' }] })
  })

  it('proposes nothing while the episode is still open', () => {
    expect(
      episodeVerdict({ ...acquisition, outcome: null }, [slot('a', 'agent')], undefined).kind,
    ).toBe('nothing')
  })

  it('proposes the wall a failure ended at', () => {
    const verdict = episodeVerdict(
      { kind: 'acquisition', outcome: 'failed', wall: 'the signup asked for a phone number' },
      [slot('a', 'agent')],
      undefined,
    )

    expect(verdict).toEqual({ kind: 'refusal', wall: 'the signup asked for a phone number' })
  })

  /** Half a path published as a recipe is one that fails at step three. */
  it('proposes nothing from an episode that stopped part-way', () => {
    expect(
      episodeVerdict({ ...acquisition, outcome: 'abandoned' }, [slot('a', 'agent')], undefined)
        .kind,
    ).toBe('nothing')
  })

  it('proposes nothing where nothing was filled', () => {
    expect(episodeVerdict(acquisition, [], undefined).kind).toBe('nothing')
  })

  /**
   * An episode carries no answer to *which of the published steps did you take*,
   * so its shape can be matched against a published one only by mistaking one
   * for the other. `#600`'s rule is unchanged: what the Colony says about
   * somebody else's product passes a person.
   */
  it('proposes nothing against an entry a steward has published', () => {
    for (const status of ['joinable', 'measured', 'refused', 'retired'] as const) {
      expect(episodeVerdict(acquisition, [slot('a', 'agent')], { status }).kind).toBe('nothing')
    }
  })

  it('still proposes a draft over an entry nobody has written or published', () => {
    for (const status of ['unwritten', 'draft'] as const) {
      expect(episodeVerdict(acquisition, [slot('a', 'agent')], { status }).kind).toBe('draft')
    }
  })

  /**
   * A truncated path is a half path wearing a full path's clothes, and it is the
   * one that fails silently: a reader has no way to tell it stopped early.
   */
  it('proposes nothing rather than the first twenty of too many steps', () => {
    const many = Array.from({ length: RECIPE_MAX_STEPS + 1 }, (_unused, index) =>
      slot(`slot-${String(index).padStart(3, '0')}`, 'agent'),
    )

    expect(episodeVerdict(acquisition, many, undefined).kind).toBe('nothing')
    expect(episodeVerdict(acquisition, many.slice(0, RECIPE_MAX_STEPS), undefined).kind).toBe(
      'draft',
    )
  })
})
