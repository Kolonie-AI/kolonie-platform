import { describe, expect, it } from 'vitest'
import { noFigures, type AtlasEntry } from '@kolonie-ai/core'
import { atlasIndexPage } from './html.js'

/**
 * What a tile says, and what it stops saying (`#1401`).
 *
 * ## The measurement this file is written against
 *
 * `/atlas/search?earn=bounty-board`, 2026-08-22: **twenty-five tiles, and
 * twenty-five need chips**, every one of them reading *who is needed is not
 * known*. A fact printed on every row is not one a reader can use to tell two
 * rows apart — and here it was not even new, because both unknown wordings open
 * by repeating the walk status the mark beside them already carries.
 *
 * `chips.test.ts` asserts the same rule for the provider page header, where
 * `#1326` decision 3 established it. This is that rule reaching the tile.
 *
 * ## The rows are built by hand
 *
 * As `criteria.test.ts` and `structured-data.test.ts` build theirs, and for the
 * same reason: what is under test is the mapping from one row's fields to what
 * the tile claims, and the interesting rows are the ones no fixture writes on
 * purpose — the entry nobody has settled, and the entry with nothing after its
 * kinds at all.
 */
const SITE = 'https://kolonie.example'

const recipe = (over: Partial<AtlasEntry['recipes'][number]> = {}) =>
  ({
    kind: 'social',
    provider: 'mastodon.example',
    title: 'Mastodon',
    about: 'A federated social network.',
    description: null,
    category: 'social-publishing',
    categories: ['social-publishing'],
    categoryIsFallback: false,
    runtimes: [],
    paid: false,
    referral: null,
    contact: null,
    lastConfirmedAt: '2026-08-12T00:00:00.000Z',
    status: 'joinable',
    operatorNeed: 'unaided',
    operatorNeedIsGuess: false,
    refusal: null,
    direction: null,
    retiredAt: null,
    retiredReason: null,
    steps: [{ actor: 'agent', instruction: 'Open the signup page.' }],
    proves: 'provider-post',
    provesTask: null,
    reaches: null,
    cautions: [],
    walkedRecipe: null,
    walls: [],
    agentApi: 'unknown',
    signupCode: 'unknown',
    needs: ['email'],
    terms: 'agent-allowed',
    /**
     * **`unknown`, which is what makes the separator case reachable.** `rowCost`
     * says nothing when the recipes do not agree on a price, and a row with no
     * need chip, no cost and no direction is the one that used to end in a dash
     * pointing at nothing.
     */
    cost: 'unknown',
    pacePerDay: null,
    updatedAt: '2026-08-12T00:00:00.000Z',
    figures: noFigures('social', 'mastodon.example'),
    ...over,
  }) as AtlasEntry['recipes'][number]

const entry = (over: Partial<AtlasEntry> = {}): AtlasEntry =>
  ({
    provider: 'mastodon.example',
    title: 'Mastodon',
    path: '/atlas/mastodon.example',
    status: 'joinable',
    category: 'social-publishing',
    description: null,
    operatorNeed: 'unaided',
    operatorNeedIsGuess: false,
    source: 'maintainer',
    walkers: [],
    health: null,
    recipes: [recipe()],
    updatedAt: '2026-08-12T00:00:00.000Z',
    ...over,
  }) as unknown as AtlasEntry

const tiles = (over: Partial<AtlasEntry> = {}): string =>
  atlasIndexPage({ entries: [entry(over)], canonical: `${SITE}/atlas` })

describe('what an Atlas tile says about who is needed', () => {
  /** Decision 3, and the whole of the issue. */
  it('says nothing when nobody has settled it', () => {
    const html = tiles({ operatorNeed: 'unknown' })

    expect(html).not.toContain('who is needed is not known')
    /**
     * The element, not the class name: `ATLAS_STYLE` is inlined into the page
     * and carries `.k-atlas-need` as a selector whether or not any tile draws
     * one. Asserting on the bare name passes on the stylesheet.
     */
    expect(html).not.toContain('<span class="k-atlas-need"')
  })

  /** And the fact is untouched wherever somebody did settle it. */
  it('still says it when somebody measured it', () => {
    expect(tiles({ operatorNeed: 'unaided' })).toContain('an agent can do this alone')
    expect(tiles({ operatorNeed: 'operator-needed' })).toContain('needs a person at one step')
  })

  it('keeps the guess marked as a guess', () => {
    expect(tiles({ operatorNeed: 'operator-needed', operatorNeedIsGuess: true })).toContain(
      'a guess, not a walk',
    )
  })

  /**
   * **The separator goes with the chips** (`#1401`). All three of need, cost and
   * direction can be absent, and the dash used to be written into the line
   * before them — so a row with none of the three ended in a dash pointing at
   * nothing. This is the row that produced it: no need, no agreed cost, no
   * direction.
   */
  it('leaves no separator pointing at nothing', () => {
    const html = tiles({ operatorNeed: 'unknown' })

    expect(html).not.toMatch(/—\s*<\/small>/)
    expect(html).not.toContain('— </small>')
  })

  /** And it is still there when there is something for it to separate. */
  it('keeps the separator when a chip follows it', () => {
    expect(tiles({ operatorNeed: 'unaided' })).toMatch(/—\s*<span class="k-atlas-need"/)
  })
})
