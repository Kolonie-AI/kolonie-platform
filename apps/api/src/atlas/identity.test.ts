import { describe, expect, it } from 'vitest'
import { noFigures, type AtlasEntry } from '@kolonie-ai/core'
import { atlasEntryPage } from './html.js'

/**
 * What a provider page says about what the provider *is* (`#1410`).
 *
 * ## The page this is written against
 *
 * `mailbox.org`, measured live on 2026-08-22: a status, walls, criteria,
 * figures and a *What citizens measured* section — and **no sentence anywhere
 * saying what the provider is**. Not a short line, not a long one, no
 * placeholder. A reader arriving from a shelf had to infer it from the domain.
 *
 * ## What is already true and is asserted here so it stays true
 *
 * Decisions 1 to 3 of `#1410` had shipped before it was picked up: a provider
 * with an `about` shows short and long identity copy above the fold. Verified on
 * `atomicmail.ai` the same day. The three cases below fix that in place, because
 * an issue closed on work somebody else did is exactly the work that regresses
 * unwatched.
 */
const SITE = 'https://kolonie.example'
const CANONICAL = `${SITE}/atlas/mastodon.example`

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
    cost: 'free',
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

const page = (over: Partial<AtlasEntry> = {}): string =>
  atlasEntryPage({ entry: entry(over), canonical: CANONICAL })

const ABSENT = 'Nobody has written what this provider is'

describe('what a provider page says it is', () => {
  it('shows the long copy a walker wrote', () => {
    expect(page()).toContain('A federated social network.')
  })

  it('shows the short copy when the entry carries one', () => {
    expect(page({ description: 'A place to post.' })).toContain('A place to post.')
  })

  /**
   * **Decision 4, and the whole of what was left to build.** Silence reads as an
   * assertion: every other absence on these pages is labelled — `ATLAS_NOT_KNOWN`
   * in the criteria box, *nobody has walked this* on a status — because `#1105`
   * decision 2 is emphatic that *not known* must never be read as *no*. Identity
   * was the one fact that went missing quietly.
   */
  it('says so when nobody has written what it is', () => {
    const html = page({
      description: null,
      recipes: [recipe({ about: null })] as AtlasEntry['recipes'],
    })

    expect(html).toContain(ABSENT)
    /** And it names the call that would fix it rather than apologising. */
    expect(html).toContain('kolonie.accounts.walk-report')
  })

  /** Rejection case: a page that has either does not also carry the placeholder. */
  it('says nothing of the sort when either is present', () => {
    expect(page()).not.toContain(ABSENT)
    expect(
      page({
        description: 'A place to post.',
        recipes: [recipe({ about: null })] as AtlasEntry['recipes'],
      }),
    ).not.toContain(ABSENT)
  })

  /**
   * **An `about` of spaces is an absence** and the register does not stop one
   * being written. A page that printed an empty paragraph would be the silent
   * emptiness this whole case is about, wearing the markup of a filled one.
   */
  it('treats an empty about as no about at all', () => {
    expect(
      page({ description: null, recipes: [recipe({ about: '   ' })] as AtlasEntry['recipes'] }),
    ).toContain(ABSENT)
  })
})
