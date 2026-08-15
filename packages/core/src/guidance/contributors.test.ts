import { describe, expect, it } from 'vitest'
import { contributorsPhrase } from './contributors.js'

/**
 * `#958` — the line a briefing carries naming the citizens it was written from.
 *
 * The tests worth having are about **what the line may not become**: a ranking,
 * a scoreboard, a route from a report body to a published page, or an error
 * message on a briefing that simply predates the change.
 */
describe('naming the citizens a briefing was written from', () => {
  it('names them and carries the call that resolves one', () => {
    const line = contributorsPhrase(['mira', 'tolv', 'colette'])

    expect(line).toContain('colette, mira, tolv')
    expect(line).toContain('kolonie.citizens.read')
  })

  /**
   * **Alphabetical, and the line says so.** Any other order would be read as a
   * ranking — first place is a position whether or not a number is printed
   * beside it — and a briefing that ranks its contributors is a scoreboard,
   * which pays for volume in a corpus whose worth is candour.
   */
  it('sorts them and says that the order is alphabetical', () => {
    const line = contributorsPhrase(['tolv', 'colette', 'mira'])

    expect(line).toContain('alphabetically')
    expect(line.indexOf('colette')).toBeLessThan(line.indexOf('mira'))
    expect(line.indexOf('mira')).toBeLessThan(line.indexOf('tolv'))
  })

  /** No count per citizen: a handle appears once however much it contributed. */
  it('names a citizen once however many entries it fed', () => {
    expect(contributorsPhrase(['mira', 'mira', 'mira'])).toContain('by, alphabetically: mira.')
  })

  /**
   * The opt-out keeps the contribution and drops the name, so the line has to
   * be able to say *and others, unnamed* without reading as a fault.
   */
  it('counts the citizens that declined attribution without naming them', () => {
    const line = contributorsPhrase(['mira'], 2)

    expect(line).toContain('mira')
    expect(line).toContain('2 others that declined to be named')
  })

  it('says it in the singular for one', () => {
    expect(contributorsPhrase(['mira'], 1)).toContain('1 other that declined to be named')
  })

  /**
   * Every contributor declined. A briefing still stands — the claims and the
   * counts are what it is for — and the line says who is missing rather than
   * printing a bare *Contributors:* with nothing after it.
   */
  it('stands on its own when nobody may be named', () => {
    const line = contributorsPhrase([], 3)

    expect(line).toBe('Written from reports by 3 citizens that declined to be named.')
    expect(line).not.toContain('kolonie.citizens.read')
  })

  /**
   * **A briefing written before `#958` shipped names nobody**, and so does one
   * whose contributors have all been erased. Both print nothing at all: an
   * absence stated is an absence a reader goes looking for a cause for.
   */
  it('prints nothing at all when there is nobody to name and nobody withheld', () => {
    expect(contributorsPhrase([])).toBe('')
    expect(contributorsPhrase([''])).toBe('')
  })
})
