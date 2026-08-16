import { describe, expect, it } from 'vitest'
import { episodeVerdict, type ObservedEpisode } from './episode-recipe.js'

/**
 * What a closed acquisition episode says about the provider (`#935`, narrowed by
 * `#1032`).
 *
 * **The decision, as a pure function.** The storage half — that closing an
 * episode once writes one entry and destroys the secrets in the same call — is in
 * `packages/db` against a real Postgres. Neither is the other, which is the split
 * `walk.test.ts` already draws.
 *
 * **The route derivation these tests used to cover is gone.** `episodeToSteps`
 * turned filled slots into recipe steps, and those steps became a `draft` entry
 * for a steward to dress. `#1032` deleted the gate, so a `writes` verdict now
 * produces a `measured` row with no steps and there is no derivation left to
 * assert. The slots themselves are untouched on `account_slots`; what stopped is
 * the catalogue republishing them as the Colony's own instruction.
 */

const acquisition: ObservedEpisode = { kind: 'acquisition', outcome: 'created', wall: null }

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
        undefined,
      )

      expect(verdict.kind).toBe('nothing')
    }
  })

  it('writes an entry from a closed acquisition', () => {
    expect(episodeVerdict(acquisition, undefined)).toEqual({ kind: 'writes' })
  })

  it('proposes nothing while the episode is still open', () => {
    expect(episodeVerdict({ ...acquisition, outcome: null }, undefined).kind).toBe('nothing')
  })

  it('proposes the wall a failure ended at', () => {
    const verdict = episodeVerdict(
      { kind: 'acquisition', outcome: 'failed', wall: 'the signup asked for a phone number' },
      undefined,
    )

    expect(verdict).toEqual({ kind: 'refusal', wall: 'the signup asked for a phone number' })
  })

  /** Half a path published as a recipe is one that fails at step three. */
  it('proposes nothing from an episode that stopped part-way', () => {
    expect(episodeVerdict({ ...acquisition, outcome: 'abandoned' }, undefined).kind).toBe('nothing')
  })

  /**
   * An episode carries no answer to *which of the published steps did you take*,
   * so its shape can be matched against a published one only by mistaking one
   * for the other. `#600`'s rule is unchanged: what the Colony says about
   * somebody else's product passes a person.
   */
  it('proposes nothing against an entry the Colony already publishes', () => {
    for (const status of ['joinable', 'refused', 'retired'] as const) {
      expect(episodeVerdict(acquisition, { status }).kind).toBe('nothing')
    }
  })

  it('still writes over an entry that stands on figures or on nothing', () => {
    for (const status of ['unwritten', 'measured'] as const) {
      expect(episodeVerdict(acquisition, { status }).kind).toBe('writes')
    }
  })
})
