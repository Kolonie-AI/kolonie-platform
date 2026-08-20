import { describe, expect, it } from 'vitest'
import type { AtlasPublicEntry } from './public-projection.js'
import {
  ATLAS_CHIPS_SHOWN,
  atlasChipsShown,
  atlasEarnRank,
  atlasHeaderChips,
  atlasProvedChip,
} from './chips.js'

/**
 * The header of a multi-facet earn provider (`#1404`).
 *
 * Measured 2026-08-20 on `opentask.ai`, which read: **a storefront — pays for
 * finished tasks — pays a gig rate — worth holding, and pays — data-apis —
 * walked, but who is needed is not known.** Six clauses of equal weight, led by
 * the least specific one and closed by a non-fact.
 */
const entry = (over: Partial<AtlasPublicEntry> = {}): AtlasPublicEntry =>
  ({
    provider: 'opentask.ai',
    title: 'OpenTask',
    path: '/atlas/opentask.ai',
    status: 'measured',
    category: 'data-apis',
    description: null,
    facets: [],
    operatorNeed: 'unknown',
    operatorNeedIsGuess: false,
    source: 'walker',
    walkers: [],
    health: null,
    recipes: [
      {
        kind: 'storefront',
        status: 'measured',
        walls: [],
        // `atlasShelfIsFallback` reads the row's own shelf against the entry's,
        // so a row with no category is a row that put it nowhere.
        category: 'data-apis',
        categoryIsFallback: true,
      },
    ],
    updatedAt: '2026-08-20T00:00:00.000Z',
    ...over,
  }) as unknown as AtlasPublicEntry

const earning = (...slugs: readonly string[]) =>
  slugs.map((slug) => ({ axis: 'earn', slug })) as unknown as AtlasPublicEntry['facets']

const said = (found: ReturnType<typeof atlasHeaderChips>) => found.map((one) => one.text)

describe('what a provider header says about itself', () => {
  /**
   * Decision 1's order, on the entry the issue was measured against — with the
   * one difference that makes the order matter: the earn facets lead.
   */
  it('leads with how the provider pays, not with the vaguest word on the line', () => {
    const found = said(
      atlasHeaderChips(
        entry({ facets: earning('bounty-board', 'gig-marketplace'), operatorNeed: 'unaided' }),
      ),
    )

    expect(found[0]).toContain('finished task')
    expect(found.at(-1)).toBe('an agent can do this alone')
  })

  /**
   * Decision 3. *Walked, but who is needed is not known* closed the header on
   * every one of the 21 earn providers on the day this was written, so a reader
   * scanning the shelf met the same headline non-fact on every row.
   */
  it('says nothing at all when nobody knows who is needed', () => {
    const found = said(atlasHeaderChips(entry({ operatorNeed: 'unknown' })))

    for (const one of found) expect(one).not.toContain('who is needed is not known')
  })

  it('still says who is needed when somebody measured it, guess and all', () => {
    expect(
      said(atlasHeaderChips(entry({ operatorNeed: 'operator-needed', operatorNeedIsGuess: true }))),
    ).toContain('needs a person at one step (a guess, not a walk)')
  })

  /**
   * Decision 2. A storefront is a shape a bounty board, a gig marketplace and a
   * shop all have, so as the lead clause it says only *somebody sells something
   * here*.
   */
  it('demotes storefront behind a kind that narrows something', () => {
    const found = said(
      atlasHeaderChips(
        entry({
          recipes: [
            { kind: 'storefront', status: 'measured', walls: [], category: 'data-apis' },
            { kind: 'payments', status: 'measured', walls: [], category: 'data-apis' },
          ] as unknown as AtlasPublicEntry['recipes'],
        }),
      ),
    )

    expect(found).toContain('a payments account')
    expect(found.join(' — ')).not.toContain('storefront')
  })

  /** …and keeps it where it is the only thing the entry can be called. */
  it('keeps storefront when it is the sole meaningful label', () => {
    expect(said(atlasHeaderChips(entry()))).toContain('a storefront')
  })

  /**
   * Decision 1's tail. `#1329` demoted the fallback on this line and the clause
   * form survives for an entry nothing else classifies — but it is never a
   * linked shelf chip, because nobody chose it.
   */
  it('never renders the fallback shelf as a shelf', () => {
    const found = atlasHeaderChips(entry({ category: 'data-apis' }))

    expect(found.filter((one) => one.shelf !== null)).toEqual([])
    expect(said(found).join(' — ')).not.toContain('data-apis')
  })

  it('links the shelf where somebody chose it', () => {
    const found = atlasHeaderChips(
      entry({
        category: 'mailboxes',
        recipes: [
          { kind: 'mailbox', status: 'measured', walls: [], category: 'mailboxes' },
        ] as unknown as AtlasPublicEntry['recipes'],
      }),
    )

    expect(found.filter((one) => one.shelf === 'mailboxes')).toHaveLength(1)
  })

  /**
   * The proved chip is #1408's, and its position on the line is this module's.
   * Passing it in rather than computing it keeps one ordering and one renderer
   * while the two issues land separately.
   */
  it('puts a proved chip after the kind and before the shelf', () => {
    const found = said(
      atlasHeaderChips(
        entry({
          category: 'mailboxes',
          facets: earning('bounty-board'),
          recipes: [
            { kind: 'mailbox', status: 'measured', walls: [], category: 'mailboxes' },
          ] as unknown as AtlasPublicEntry['recipes'],
        }),
        { proved: { text: '3 proved holds', className: 'k-atlas-proved', shelf: null } },
      ),
    )

    expect(found.indexOf('3 proved holds')).toBeGreaterThan(found.indexOf('a mailbox'))
    expect(found.indexOf('3 proved holds')).toBeLessThan(found.indexOf('mailboxes'))
  })

  describe('the six a reader is shown', () => {
    it('leaves a short header entirely above the fold', () => {
      const { shown, rest } = atlasChipsShown(atlasHeaderChips(entry()))

      expect(rest).toEqual([])
      expect(shown.length).toBeLessThanOrEqual(ATLAS_CHIPS_SHOWN)
    })

    it('discloses the rest rather than dropping them', () => {
      const many = atlasHeaderChips(
        entry({
          facets: earning(
            'affiliate-referral',
            'bounty-board',
            'creator-payout',
            'gig-marketplace',
            'grant-quest',
          ),
          category: 'mailboxes',
          operatorNeed: 'unaided',
          recipes: [
            { kind: 'mailbox', status: 'measured', walls: [], category: 'mailboxes' },
          ] as unknown as AtlasPublicEntry['recipes'],
        }),
      )
      const { shown, rest } = atlasChipsShown(many)

      expect(shown).toHaveLength(ATLAS_CHIPS_SHOWN)
      expect(rest.length).toBeGreaterThan(0)
      expect([...shown, ...rest]).toEqual(many)
    })
  })
})

/**
 * Whether anybody holds an account here (`#1408`).
 *
 * The issue asks for `N proved holds`. `proved` is a count and
 * `ATLAS_FIGURE_FLOOR` zeroes counts below five, so on a Colony of 33 citizens
 * that chip would read `no proved hold yet` on providers a citizen
 * demonstrably holds — which is `#1167`, measured on `telegram.org` with a live
 * session open at the time the page was read. `anyProved` is the boolean that
 * survives the floor, because it is not a count.
 */
const withFigures = (
  over: Partial<AtlasPublicEntry> & {
    readonly figures?: { proved?: number; anyProved?: boolean; attempted?: number }
  } = {},
): AtlasPublicEntry => {
  const { figures, ...rest } = over

  return entry({
    recipes: [
      {
        kind: 'mailbox',
        status: 'measured',
        walls: [],
        category: 'mailboxes',
        figures: { proved: 0, anyProved: false, attempted: 0, ...figures },
      },
    ] as unknown as AtlasPublicEntry['recipes'],
    ...rest,
  })
}

describe('whether anybody actually holds an account here', () => {
  it('names the number where the floor let the number through', () => {
    expect(atlasProvedChip(withFigures({ figures: { proved: 7, anyProved: true } }))?.text).toBe(
      '7 proved holds',
    )
  })

  it('says one where the number was suppressed but the boolean survived', () => {
    expect(atlasProvedChip(withFigures({ figures: { proved: 0, anyProved: true } }))?.text).toBe(
      'a citizen holds one here',
    )
  })

  it('says so calmly where a walked provider is held by nobody', () => {
    const found = atlasProvedChip(withFigures())

    expect(found?.text).toBe('no proved hold yet')
    expect(found?.className).toBe('k-atlas-unproved')
  })

  /**
   * Decision 1 says the unheld chip is for measured entries. On one nobody has
   * walked it would be the page reporting the Colony's own coverage as a fact
   * about the provider — the distinction `#1105` decision 2 is emphatic about.
   */
  it('says nothing at all about a provider nobody has walked', () => {
    expect(
      atlasProvedChip(
        withFigures({
          recipes: [
            { kind: 'mailbox', status: 'unwritten', walls: [], category: 'mailboxes' },
          ] as unknown as AtlasPublicEntry['recipes'],
        }),
      ),
    ).toBeNull()
  })

  it('puts the chip on the header without being asked for it', () => {
    const found = atlasHeaderChips(withFigures({ figures: { proved: 2, anyProved: true } }))

    expect(found.map((one) => one.text)).toContain('2 proved holds')
  })
})

/** Decision 2's order: held, then a route, then a measurement, then silence. */
describe('how an earn search orders what it found', () => {
  const at = (over: Parameters<typeof withFigures>[0]) => atlasEarnRank(withFigures(over))

  it('puts what somebody holds above everything else', () => {
    expect(at({ figures: { proved: 3, anyProved: true } })).toBe(0)
    expect(at({ figures: { proved: 0, anyProved: true } })).toBe(0)
  })

  it('ranks a written route above a bare measurement, and both above silence', () => {
    const status = (one: string) =>
      atlasEarnRank(
        entry({
          recipes: [
            { kind: 'mailbox', status: one, walls: [], category: 'mailboxes', figures: {} },
          ] as unknown as AtlasPublicEntry['recipes'],
        }),
      )

    expect(status('joinable')).toBeLessThan(status('measured'))
    expect(status('measured')).toBeLessThan(status('refused'))
    expect(status('refused')).toBeLessThan(status('unwritten'))
  })

  /**
   * The floor governs publication and not ranking, and the two are different
   * acts: printing `3` says something about three citizens, putting a row above
   * another says only *this is the better bet*. Neither number leaves the
   * process.
   */
  it('ranks a suppressed hold as a hold, though the page will not print it', () => {
    expect(at({ figures: { proved: 0, anyProved: true } })).toBeLessThan(
      at({ figures: { proved: 0, anyProved: false } }),
    )
  })
})
