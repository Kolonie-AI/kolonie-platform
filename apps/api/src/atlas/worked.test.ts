import { describe, expect, it } from 'vitest'
import { noFigures, type AtlasFigures } from '@kolonie-ai/core'
import { atlasEntryWorked } from './worked.js'
import type { AtlasPublicEntry } from './public-projection.js'

/**
 * Whether anybody got through, which is the whole of `#1103` decision 2.
 *
 * **The rows are built by hand** rather than through the colony fixture, as
 * `structured-data.test.ts` builds its own and for the same reason: what is under
 * test is the mapping from one row's numbers to one boolean, and the interesting
 * rows are the ones no fixture writes on purpose — a figure that is floored, and
 * a figure nobody has evidenced.
 */
const figures = (over: Partial<AtlasFigures> = {}): AtlasFigures => ({
  ...noFigures('mailbox', 'mail.example'),
  ...over,
})

const entry = (over: Partial<AtlasPublicEntry> = {}): AtlasPublicEntry =>
  ({
    provider: 'mail.example',
    title: 'Mail',
    path: '/atlas/mail.example',
    status: 'measured',
    category: 'mailbox',
    recipes: [{ figures: figures() }],
    ...over,
  }) as unknown as AtlasPublicEntry

const withFigures = (over: Partial<AtlasFigures>): AtlasPublicEntry =>
  entry({ recipes: [{ figures: figures(over) }] as unknown as AtlasPublicEntry['recipes'] })

describe('whether anybody got through at a provider', () => {
  /**
   * A steward's verdict is one of the two ways a row says it: the entry says a
   * recipe here can be walked honestly, and that stands before anybody has walked
   * it — which is the case a rate could never express.
   */
  it('takes a steward at their word', () => {
    expect(atlasEntryWorked(entry({ status: 'joinable' }))).toBe(true)
  })

  it('says no to a refusal and to a row nobody has written', () => {
    expect(atlasEntryWorked(entry({ status: 'refused' }))).toBe(false)
    expect(atlasEntryWorked(entry({ status: 'unwritten' }))).toBe(false)
  })

  it('reads a proved walk on any recipe of the entry', () => {
    expect(atlasEntryWorked(withFigures({ evidenced: true, attempted: 9, proved: 2 }))).toBe(true)
  })

  /**
   * **`evidenced` is the gate, and `#977` is why.** A declaration is not
   * evidence; a count that nothing stands behind must not answer the question
   * this predicate is asked.
   */
  it('ignores a figure nothing evidences, however good it looks', () => {
    expect(
      atlasEntryWorked(withFigures({ evidenced: false, attempted: 9, proved: 9, anyProved: true })),
    ).toBe(false)
  })

  /**
   * **The two cannot disagree**, since one is the other thresholded: `anyProved`
   * is the count read before the flooring. The band arm that used to stand here
   * could disagree with the count, which is what `#1167` found.
   */
  it('agrees with the count wherever the count survives the floor', () => {
    expect(
      atlasEntryWorked(withFigures({ evidenced: true, attempted: 9, proved: 2, anyProved: true })),
    ).toBe(true)
  })

  /**
   * **The case the whole predicate exists for.** `ATLAS_FIGURE_FLOOR` zeroes
   * every count on a row of fewer than five attempts, so the entry where a single
   * citizen got in reaches this function with `proved: 0` — and a literal reading
   * of *at least one proved* would answer no for exactly the row decision 2 is
   * about. `AtlasFigures.anyProved` is read off the count before the flooring and
   * survives it.
   */
  it('reads the unfloored predicate where the floor has taken the count', () => {
    expect(
      atlasEntryWorked(withFigures({ evidenced: true, attempted: 0, proved: 0, anyProved: true })),
    ).toBe(true)
  })

  /**
   * **The row `#1167` found**, and the reason the band is no longer read as a
   * second spelling of *at least one*: a provider six citizens attempted and one
   * got into bands `few-got-through`, a band that covers a rate of zero and a rate
   * of one in six alike. Under the old reading the count was floored, the band
   * decided nothing, and the entry a single arrival is the whole story of fell off
   * the default. `anyProved` knows.
   */
  it('reads an arrival the vaguest band cannot express', () => {
    expect(
      atlasEntryWorked(
        withFigures({
          evidenced: true,
          attempted: 0,
          proved: 0,
          band: 'few-got-through',
          anyProved: true,
        }),
      ),
    ).toBe(true)
  })

  /**
   * The conservative answer where nobody has arrived: the entry keeps its page and
   * stays one link away rather than being shown as something that worked.
   */
  it('says no where nobody has arrived', () => {
    expect(
      atlasEntryWorked(
        withFigures({ evidenced: true, attempted: 0, proved: 0, band: 'few-got-through' }),
      ),
    ).toBe(false)
  })

  /** A walk somebody finished says it too, on the same terms. */
  it('reads a finished walk', () => {
    expect(
      atlasEntryWorked(
        withFigures({
          evidenced: true,
          walked: { citizens: 3, gotThrough: 1, band: null, platforms: {}, walls: [] },
        }),
      ),
    ).toBe(true)
  })

  it('says no to an entry with no recipe at all', () => {
    expect(atlasEntryWorked(entry({ recipes: [] }))).toBe(false)
  })
})
