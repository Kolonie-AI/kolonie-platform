import { describe, expect, it } from 'vitest'
import { ATLAS_FIGURE_FLOOR, atlasRank, noFigures, throughRate } from './atlas-figures.js'
import type { AtlasFigures } from './atlas-figures.js'
import type { RecipeStatus } from './recipe.js'

const measured = (input: Partial<AtlasFigures> & { attempted: number }): AtlasFigures => ({
  ...noFigures('mailbox', 'mail.tm'),
  ...input,
})

/**
 * The ordering the Atlas is the product of (`#545`).
 *
 * **Derived on every read and stored nowhere**, which is how `#543` rule 2 —
 * ordering is never for sale — is enforced by there being nothing to set rather
 * than by a policy somebody applies.
 */
describe('the order the Atlas is read in', () => {
  const rank = (status: RecipeStatus, ...figures: AtlasFigures[]) => atlasRank({ status, figures })

  it('puts a provider agents get through above one they mostly do not', () => {
    const good = rank('joinable', measured({ attempted: 100, proved: 90 }))
    const poor = rank('joinable', measured({ attempted: 100, proved: 10 }))

    expect(good).toBeGreaterThan(poor)
  })

  /**
   * **A bigger sample wins a tie**, because 100 % over five attempts is a weaker
   * claim than 80 % over two hundred and sorting on the rate alone would put the
   * first above the second forever.
   */
  it('prefers the larger sample when the rate is the same', () => {
    const many = rank('joinable', measured({ attempted: 200, proved: 160 }))
    const few = rank('joinable', measured({ attempted: 5, proved: 4 }))

    expect(many).toBeGreaterThan(few)
  })

  /**
   * Nothing is known about an unmeasured entry, which is worse than a working
   * recipe and better than a road known to be closed.
   */
  it('sorts an unmeasured entry below a measured one and above a refusal', () => {
    const measuredWell = rank('joinable', measured({ attempted: 20, proved: 15 }))
    const unmeasured = rank('joinable', noFigures('mailbox', 'nobody.test'))
    const refusal = rank('refused', noFigures('social', 'bluesky'))

    expect(measuredWell).toBeGreaterThan(unmeasured)
    expect(unmeasured).toBeGreaterThan(refusal)
  })

  /**
   * The bottom of the order is two rows and not one (`#588`). The Colony walked
   * the refusal and knows the road is closed; it has not walked the unwritten
   * entry at all, which may well work — so ranking them together would bury a
   * provider that works underneath one that does not.
   */
  it('sorts an entry nobody has written above a refusal', () => {
    const unwritten = rank('unwritten', noFigures('mailbox', 'fastmail.com'))
    const refusal = rank('refused', noFigures('social', 'bluesky'))

    expect(unwritten).toBeGreaterThan(refusal)
  })

  /** And still below every joinable entry, including one nobody has attempted. */
  it('sorts an entry nobody has written below an unmeasured joinable one', () => {
    const unwritten = rank('unwritten', noFigures('mailbox', 'fastmail.com'))
    const unmeasured = rank('joinable', noFigures('mailbox', 'nobody.test'))

    expect(unmeasured).toBeGreaterThan(unwritten)
  })

  /** A suppressed row is unmeasured as far as ordering goes — nothing was published. */
  it('does not rank a suppressed row on figures nobody may read', () => {
    const suppressed = rank('joinable', measured({ attempted: 0, proved: 0, suppressed: true }))

    expect(suppressed).toBe(
      atlasRank({ status: 'joinable', figures: [noFigures('a-kind', 'b.test')] }),
    )
  })

  /**
   * **A poor result must still be published**, so a bad number ranks low and is
   * never absent. If this ever passed by omission the catalogue would be a list
   * of successes, which is the thing it exists not to be.
   */
  it('ranks a provider nobody gets through, rather than dropping it', () => {
    expect(rank('joinable', measured({ attempted: 40, proved: 0 }))).toBeGreaterThanOrEqual(0)
  })
})

describe('how many got through', () => {
  it('is the proved share of everyone who tried', () => {
    expect(throughRate(measured({ attempted: 50, proved: 20 }))).toBeCloseTo(0.4)
  })

  /**
   * A zero here would read as *nobody gets through* — a claim about the provider
   * the Colony has not earned. Two states answer *we cannot tell you*.
   */
  it('says nothing when nobody has tried', () => {
    expect(throughRate(noFigures('mailbox', 'quiet.test'))).toBeNull()
  })

  it('says nothing when the floor suppressed the row', () => {
    expect(throughRate(measured({ attempted: 0, proved: 0, suppressed: true }))).toBeNull()
  })
})

describe('the floor', () => {
  /** `#545` asks for the permission report's floor rather than a second number. */
  it('is the one the permission aggregate already uses', () => {
    expect(ATLAS_FIGURE_FLOOR).toBe(5)
  })
})
