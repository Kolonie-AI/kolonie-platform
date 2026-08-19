import { describe, expect, it } from 'vitest'
import { noFigures, type AtlasFigures } from '@kolonie-ai/core'
import { ATLAS_ATTEMPTED_LEAD, ATLAS_SCOUTED_LEAD, atlasStatusSubline } from './lead.js'
import type { AtlasPublicEntry } from './public-projection.js'

/**
 * Which kind of walk a measured entry is built out of (`#1333`).
 *
 * **The rows are built by hand**, as `worked.test.ts` and `title.test.ts` build
 * their own: what is under test is the mapping from two booleans and a third to
 * one sentence, and the interesting rows are the ones no fixture writes — a
 * scout filing with nothing else on it, and a provider that has both.
 */
const figures = (over: Partial<AtlasFigures['walked']> = {}, proved = false): AtlasFigures => {
  const base = noFigures('bounty-board', 'scouted.example')

  return { ...base, anyProved: proved, walked: { ...base.walked, ...over } }
}

const entry = (
  over: Partial<AtlasFigures['walked']> = {},
  extra: { readonly proved?: boolean; readonly status?: AtlasPublicEntry['status'] } = {},
): AtlasPublicEntry =>
  ({
    provider: 'scouted.example',
    title: 'Scouted',
    path: '/atlas/scouted.example',
    status: extra.status ?? 'measured',
    category: 'data-apis',
    recipes: [{ figures: figures(over, extra.proved ?? false) }],
  }) as unknown as AtlasPublicEntry

describe('what a measured entry says about the walks behind it', () => {
  /**
   * The scout's own line, and the reason this issue exists: filed as `sighted`,
   * this provider has never been attempted, and the page said *walked* — which a
   * stranger reads as *tried and failed*.
   */
  it('calls a scout filing scouted, not abandoned', () => {
    expect(atlasStatusSubline(entry({ anySighted: true }))).toBe(ATLAS_SCOUTED_LEAD)
    expect(atlasStatusSubline(entry({ anySighted: true }))).not.toContain('stopped')
  })

  it('calls a stopped signup an attempt', () => {
    expect(atlasStatusSubline(entry({ anyAbandoned: true }))).toBe(ATLAS_ATTEMPTED_LEAD)
  })

  /**
   * **The attempt wins and the scouting is mentioned beside it** (`#1326`
   * decision 6). A reader is deciding on an hour of their own: *somebody tried
   * and stopped* is what changes that decision, and the scout filing is what put
   * the identity block on the page, so it is carried rather than dropped.
   */
  it('leads with the attempt where both happened, and still names the scout', () => {
    const both = atlasStatusSubline(entry({ anySighted: true, anyAbandoned: true }))

    expect(both).toContain(ATLAS_ATTEMPTED_LEAD)
    expect(both).toContain('A scout also filed')
    expect(both?.indexOf('stopped before an account')).toBeLessThan(
      both?.indexOf('A scout also filed') ?? -1,
    )
  })

  /**
   * **Nothing where somebody got in.** A provider a citizen holds an account at
   * is not described by where anybody stopped — and `anyProved` is the unfloored
   * answer (`#1167`), which is why this reads it rather than `gotThrough`: every
   * walked pair in production is under the figure floor, so the count is zero on
   * a provider somebody is holding an account at.
   */
  it('says nothing about stopping on a provider somebody got into', () => {
    expect(
      atlasStatusSubline(entry({ anySighted: true, anyAbandoned: true }, { proved: true })),
    ).toBeUndefined()
  })

  /** Measured off a refusal, or off the register, is neither of the two. */
  it('says nothing where no walk was a scout filing or an abandoned signup', () => {
    expect(atlasStatusSubline(entry())).toBeUndefined()
  })

  /**
   * **Every other status has a sentence of its own already**, so this line
   * answers a question only `measured` raises. Asserted over all four so a later
   * status cannot pick it up by accident.
   */
  it('is silent on every status but measured', () => {
    for (const status of ['joinable', 'unwritten', 'refused', 'retired'] as const) {
      expect(atlasStatusSubline(entry({ anySighted: true }, { status }))).toBeUndefined()
    }
  })
})
