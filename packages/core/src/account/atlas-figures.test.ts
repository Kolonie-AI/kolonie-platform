import { describe, expect, it } from 'vitest'
import {
  ATLAS_ANY_PROVED_PHRASE,
  ATLAS_FIGURE_FLOOR,
  atlasBand,
  atlasBandPhrase,
  atlasCommonestStop,
  atlasRank,
  atlasStopPhrase,
  atlasStopStep,
  noFigures,
  throughRate,
} from './atlas-figures.js'
import type { AtlasFigures } from './atlas-figures.js'
import { ProviderReportOutcomeSchema } from './account.js'
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
   * **The tie-break breaks a tie and nothing else, pinned because `#1032` read
   * it the other way.** That issue asked for a test that *80 % of two hundred
   * outranks 100 % of five* — which is not this ordering: the share comes first
   * and the sample only separates two entries that already agree on it, exactly
   * as the same issue's own sentence says (*"share of agents that got through,
   * bigger sample winning a tie"*). Both readings are defensible and only one of
   * them is what the `accounts.recipes` description promises a reader, so the
   * description wins and the other reading is a proposal rather than a bug.
   *
   * Asserted rather than left implicit because the two sentences disagreed in
   * one issue, which is precisely the state in which somebody later changes the
   * function to satisfy the wrong half of it.
   */
  it('does not let a bigger sample overturn a better share', () => {
    const perfectAndSmall = rank('joinable', measured({ attempted: 5, proved: 5 }))
    const goodAndLarge = rank('joinable', measured({ attempted: 200, proved: 160 }))

    expect(perfectAndSmall).toBeGreaterThan(goodAndLarge)
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
  /**
   * **Its own constant since `#909`, and the value is deliberately unchanged.**
   * `#545` asked for `PERMISSION_AGGREGATE_FLOOR` by reference and the two do
   * happen to agree; what the alias hid is that they protect different subjects
   * — one a citizen's autonomy contract, this one a count about a provider — and
   * that distinction is what let a row exist below a figure floor.
   */
  it('is five, and is no longer read from the permission aggregate', () => {
    expect(ATLAS_FIGURE_FLOOR).toBe(5)
  })
})

/**
 * What a sample too small for counts can still say (`#792`).
 *
 * **Three words and no arithmetic**, which is why the floor has nothing to take
 * from them: a band is not reducible to a citizen the way `1 of 2` is.
 */
describe('the band a small sample still earns', () => {
  it('says most got through above sixty per cent', () => {
    expect(atlasBand({ attempted: 10, proved: 7 })).toBe('most-got-through')
  })

  it('says about half between forty and sixty', () => {
    expect(atlasBand({ attempted: 10, proved: 5 })).toBe('about-half')
    expect(atlasBand({ attempted: 10, proved: 6 })).toBe('about-half')
  })

  it('says few got through below forty', () => {
    expect(atlasBand({ attempted: 10, proved: 3 })).toBe('few-got-through')
  })

  /**
   * A band on nothing would read as *few got through*, which is a claim about
   * the provider rather than about the absence of a measurement.
   */
  it('says nothing at all when nobody has tried', () => {
    expect(atlasBand({ attempted: 0, proved: 0 })).toBeNull()
  })

  /** One walk is a band, and that is the whole point of the issue. */
  it('bands a single walk', () => {
    expect(atlasBand({ attempted: 1, proved: 1 })).toBe('most-got-through')
    expect(atlasBand({ attempted: 1, proved: 0 })).toBe('few-got-through')
  })

  it('has a sentence for every band', () => {
    expect(atlasBandPhrase('most-got-through')).toMatch(/Most/)
    expect(atlasBandPhrase('about-half')).toMatch(/half/)
    expect(atlasBandPhrase('few-got-through')).toMatch(/Few/)
  })
})

describe('where walks stop most often', () => {
  it('is the outcome the most citizens reported', () => {
    expect(
      atlasCommonestStop([
        { outcome: 'abandoned', citizens: 2 },
        { outcome: 'signup-refused', citizens: 5 },
      ]),
    ).toBe('signup-refused')
  })

  /**
   * **The earlier stop wins a tie**, because the outcomes are the order a walk
   * goes through: a provider that both refuses signup and never provisions is
   * described by the wall a reader hits first.
   */
  it('breaks a tie on which stop comes first in a walk', () => {
    expect(
      atlasCommonestStop([
        { outcome: 'never-provisioned', citizens: 3 },
        { outcome: 'no-service', citizens: 3 },
      ]),
    ).toBe('no-service')
  })

  it('says nothing when nobody reported a stop', () => {
    expect(atlasCommonestStop([])).toBeNull()
    expect(atlasCommonestStop([{ outcome: 'abandoned', citizens: 0 }])).toBeNull()
  })

  /**
   * **Read off the schema rather than listed here** (`#940`). A hand-written
   * list asserts that the four outcomes somebody thought of have a sentence, and
   * a fifth value added to the enum passes it without having one — the function
   * falls through to `abandoned`'s phrase, so the surface prints *they gave up
   * before it was settled* about a citizen that did nothing of the kind. Reading
   * the options makes the test fail on the value that is missing instead.
   */
  it('has its own sentence for every outcome the schema allows', () => {
    const phrases = ProviderReportOutcomeSchema.options.map((outcome) => atlasStopPhrase(outcome))

    for (const phrase of phrases) expect(phrase.length).toBeGreaterThan(0)
    expect(new Set(phrases).size).toBe(phrases.length)
  })
})

/**
 * Which step of the printed recipe an outcome pins (`#792`).
 *
 * **Only where the outcome pins one.** No report carries a step index, so the
 * two that can be placed are placed and the three that cannot say nothing rather
 * than name a number nobody measured.
 */
describe('the step a stop points at', () => {
  it('puts a refused signup at the first step', () => {
    expect(atlasStopStep({ outcome: 'signup-refused', steps: 4 })).toBe(1)
  })

  it('puts an account that never existed at the last one', () => {
    expect(atlasStopStep({ outcome: 'never-provisioned', steps: 4 })).toBe(4)
  })

  it('places nothing for a stop before the walk or a walk given up', () => {
    expect(atlasStopStep({ outcome: 'no-service', steps: 4 })).toBeNull()
    expect(atlasStopStep({ outcome: 'abandoned', steps: 4 })).toBeNull()
  })

  /**
   * **The walk was not started, so there is no step it reached** (`#940`). This
   * is the outcome furthest from a step index of all five: the other four are at
   * least about somebody moving through a recipe.
   */
  it('places nothing for a row the documentation answered before the walk began', () => {
    expect(atlasStopStep({ outcome: 'cannot-do-the-job', steps: 4 })).toBeNull()
  })

  it('places nothing when the recipe has no steps to point at', () => {
    expect(atlasStopStep({ outcome: 'signup-refused', steps: 0 })).toBeNull()
  })
})

/**
 * The one positive fact that clears the floor (`#1167`).
 *
 * Its counterpart is `evidenced`: that one says somebody has been here, this one
 * says somebody arrived. Both are booleans for the same reason — *a citizen got
 * in* names nobody, and *three did* is a number about three citizens.
 */
describe('whether a citizen holds a proved account here', () => {
  it('claims nothing about a provider nobody has been to', () => {
    expect(noFigures('mailbox', 'nobody.test').anyProved).toBe(false)
  })

  /**
   * **No number and no *at least one***, either of which would invite the reader
   * to guess at the count the floor is withholding.
   */
  it('says it without a number', () => {
    expect(ATLAS_ANY_PROVED_PHRASE).not.toMatch(/\d|at least/i)
    expect(ATLAS_ANY_PROVED_PHRASE.length).toBeGreaterThan(0)
  })

  /** It is a fact about now, where a stop is a thing that happened once. */
  it('is written in the present tense, beside a stop that is not', () => {
    expect(ATLAS_ANY_PROVED_PHRASE).toContain('holds')
  })
})
