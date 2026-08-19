import { describe, expect, it } from 'vitest'
import { noFigures, type AtlasEntry } from '@kolonie-ai/core'
import { atlasEntryPage, atlasIndexPage } from './html.js'
import { atlasCriteria, ATLAS_NOT_KNOWN, ATLAS_WALL_SEE_MEASURED } from './criteria.js'
import { atlasPublicEntry } from './public-projection.js'

const SITE = 'https://kolonie.example'
const CANONICAL = `${SITE}/atlas/mastodon.example`

/**
 * The rows are built by hand, as `structured-data.test.ts` and `worked.test.ts`
 * build theirs and for the same reason: what is under test is the mapping from
 * one row's fields to what the page claims, and the interesting rows are the ones
 * no fixture writes on purpose — the provider nobody has priced, and the entry
 * nobody has walked.
 */
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
  }) as unknown as AtlasEntry['recipes'][number]

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

/** Every `ld+json` block on a page, parsed — which is the assertion by itself. */
const blocks = (html: string): readonly Record<string, unknown>[] =>
  [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].map(
    (found) => JSON.parse(found[1] ?? '') as Record<string, unknown>,
  )

const faq = (html: string): Record<string, unknown> | undefined =>
  blocks(html).find((one) => one['@type'] === 'FAQPage')

/**
 * The page's own text, with the five entities `escape` writes put back.
 *
 * The comparison in *puts every answer it publishes on the page* is between a
 * JSON string and rendered HTML, and the two encode an apostrophe differently.
 * Decoding here rather than escaping the JSON side keeps the test from asserting
 * against the very function whose output it is checking.
 */
const decoded = (html: string): string =>
  html
    .replaceAll('&#39;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')

const box = (html: string): string =>
  decoded(html).slice(
    html.indexOf('<dl class="k-atlas-criteria">'),
    html.indexOf('</dl>') + '</dl>'.length,
  )

/**
 * The page below `<main>`.
 *
 * **Every class the body emits also appears in the stylesheet the page inlines**,
 * so a bare `toContain('k-atlas-citizen')` is answered by the rule rather than by
 * the paragraph, and passes on a page that renders neither.
 */
const main = (html: string): string => decoded(html).slice(html.indexOf('<main>'))

describe('the provider page as the guide a search finds', () => {
  /**
   * **Decision 3, and it supersedes `#788` for the heading only.** The `<title>`
   * is still the search line `#788` wrote — that is what a result list shows —
   * and the heading is what somebody who followed it lands on. The provider's own
   * name was the heading until here, which answers nothing to a reader who has
   * just clicked that provider's name.
   */
  it('opens with the question somebody actually typed', () => {
    const html = page()

    expect(html).toContain(
      '<h1>How can an AI agent create a social account at mastodon.example?</h1>',
    )
    expect(html).toContain('<title>mastodon.example for an AI agent: sign up, prove it')
  })

  it('asks about every kind on the entry rather than picking one', () => {
    const html = page({
      recipes: [recipe(), recipe({ kind: 'mailbox' as never })] as AtlasEntry['recipes'],
    })

    expect(html).toContain('a social account or a mailbox at mastodon.example?')
  })

  /**
   * **The rejection case `kolonie-website#112` was filed for.** Since `#1146` a
   * row's title says *what the account is*, so an entry titled by one reads *at A
   * GitHub machine account of the agent's own* — two noun phrases joined by a
   * preposition that cannot hold them, live on `github.com` on 2026-08-17. The
   * assertion is that the title reaches neither sentence rather than that this one
   * phrase does not, because the next descriptive title will be a different phrase.
   */
  it('names the provider by its domain and never by the entry title', () => {
    const titled = { title: "A GitHub machine account of the agent's own" }
    const html = decoded(page(titled))

    expect(html).toContain(
      '<h1>How can an AI agent create a social account at mastodon.example?</h1>',
    )
    expect(box(page(titled))).toContain('What does it cost to sign up at mastodon.example?')
    expect(html.slice(html.indexOf('<h1>'))).not.toContain(titled.title)
  })

  /**
   * **The shape, on both verdicts, rather than the sentence on one** (`#112`).
   * A snapshot of one fixture passes on the day it is written and says nothing
   * about the entry whose status differs; what has to hold everywhere is that the
   * heading is one question ending in a domain and the search line opens with the
   * same domain.
   */
  it('holds the title and heading shapes on a refusal and on a joinable entry', () => {
    const shape = /^How can an AI agent create .+ at [a-z\d.-]+\?$/

    for (const status of ['joinable', 'refused'] as const) {
      const html = decoded(page({ status, recipes: [recipe({ status })] as AtlasEntry['recipes'] }))
      const heading = /<h1>(.*?)<\/h1>/.exec(html)?.[1] ?? ''
      const line = /<title>(.*?)<\/title>/.exec(html)?.[1] ?? ''

      expect(heading).toMatch(shape)
      expect(line.startsWith('mastodon.example')).toBe(true)
    }
  })

  /**
   * Decision 1: the fixed facts, and the box is above the prose rather than under
   * it.
   *
   * **It was nine and it is ten** (`#1123`). `#1105` decided which facts a reader
   * weighs rather than how many there are, and the count is what falls out of the
   * list — so a wall kind that answers a question nothing else on the page can
   * answer adds a row here rather than displacing one.
   */
  it('answers every fixed criterion in a box above the prose', () => {
    const html = page()
    const asked = box(html)

    expect(asked).toContain('What does it cost to sign up at mastodon.example?')
    expect(asked).toContain('Is there a human check to get past?')
    expect(asked).toContain('Does it want money before the account works?')
    expect(asked).toContain('Does it need a phone number?')
    expect(asked).toContain('Does it need an identity document?')
    expect(asked).toContain('Is it invite-only?')
    expect(asked).toContain('Does a person have to approve the account?')
    expect(asked).toContain('Do the terms restrict what you may publish with it?')
    expect(asked).toContain('Do the terms allow an account held by an agent?')
    expect(asked).toContain('Can an agent do this alone, or is a person needed?')

    expect(atlasCriteria(atlasPublicEntry(entry()))).toHaveLength(10)
    /**
     * `#1298`: identity (about / homepage) leads; the criteria box follows so it
     * cannot bury moderated walk substance under empty FAQ rows.
     */
    expect(main(html).indexOf('k-about')).toBeLessThan(main(html).indexOf('k-atlas-criteria'))
  })

  /**
   * **The direction row is the last one and it is conditional** (`#976`). A row
   * reading *not known* about an axis that does not exist is noise a reader has to
   * learn to skip, so only the kinds where the axis means anything get one.
   */
  it('asks which direction only where the kind has one', () => {
    expect(box(page())).not.toContain('Which direction')
    expect(
      box(
        page({
          recipes: [
            recipe({ kind: 'phone' as never, direction: 'inbound' }),
          ] as AtlasEntry['recipes'],
        }),
      ),
    ).toContain('Which direction was this measured in?')
  })

  /**
   * **Decision 2, and the rejection case the whole box turns on.** A catalogue
   * that fills a missing `cost` with *free* sends an agent to spend an afternoon
   * on a card form nobody recorded.
   */
  it('says not known rather than substituting a default cost or terms', () => {
    const asked = box(
      page({
        recipes: [recipe({ cost: 'unknown', terms: 'unknown' })] as AtlasEntry['recipes'],
      }),
    )

    expect(asked.match(new RegExp(ATLAS_NOT_KNOWN, 'g'))).toHaveLength(2)
    expect(asked).not.toContain('No money and no card')
    expect(asked).not.toContain('The terms contemplate')
  })

  /**
   * **A wall nobody hit is two different facts** and the box may not merge them:
   * on a walked entry it is a measurement, and on a placeholder it is the absence
   * of one.
   */
  it('tells a wall nobody hit from a wall nobody looked for', () => {
    expect(box(page())).toContain('Not reported by anybody who walked it.')
    expect(
      box(page({ recipes: [recipe({ status: 'unwritten' })] as AtlasEntry['recipes'] })),
    ).not.toContain('Not reported by anybody who walked it.')
  })

  /**
   * `#1298`: when the only published walls are `other`, the FAQ kinds were never
   * asked — saying *not reported* claimed an absence over a corpus that named a
   * waitlist. Point at what citizens measured instead.
   */
  it('does not claim not-reported when only other walls exist', () => {
    const asked = box(
      page({
        recipes: [
          recipe({
            status: 'refused',
            walls: [
              { kind: 'other', direction: null, reportedBy: 6 },
            ] as unknown as AtlasEntry['recipes'][number]['walls'],
          }),
        ] as AtlasEntry['recipes'],
      }),
    )

    expect(asked).toContain(ATLAS_WALL_SEE_MEASURED)
    expect(asked).not.toContain('Not reported by anybody who walked it.')
  })

  it('still says not-reported for FAQ kinds when a typed FAQ wall was hit', () => {
    const asked = box(
      page({
        recipes: [
          recipe({
            walls: [
              { kind: 'payment-required', direction: null, reportedBy: 2 },
              { kind: 'other', direction: null, reportedBy: 1 },
            ] as unknown as AtlasEntry['recipes'][number]['walls'],
          }),
        ] as AtlasEntry['recipes'],
      }),
    )

    expect(asked).toContain('Yes — money before the account can do its job. Hit by 2 walks.')
    expect(asked).toContain('Not reported by anybody who walked it.')
    expect(asked).not.toContain(ATLAS_WALL_SEE_MEASURED)
  })

  it('answers a wall that was hit with its kind, its count and its price', () => {
    const asked = box(
      page({
        recipes: [
          recipe({
            walls: [
              { kind: 'payment-required', direction: null, reportedBy: 3, amountUsd: 5 },
            ] as unknown as AtlasEntry['recipes'][number]['walls'],
          }),
        ] as AtlasEntry['recipes'],
      }),
    )

    expect(asked).toContain(
      'Yes — money before the account can do its job. Hit by 3 walks. About $5.',
    )
  })

  /**
   * **The box asks about the output restriction and not about its neighbour**
   * (`#1123`). The terms row one line down answers *may an agent hold this*, at
   * four values none of which can say *the account is fine and the work may not
   * be published* — so a reader scanning a provider with an AI-content policy
   * either learns it here or reads two sections further to find out.
   */
  it('asks whether the terms restrict what may be published, and answers it', () => {
    expect(box(page())).toContain('Do the terms restrict what you may publish with it?')

    const asked = box(
      page({
        recipes: [
          recipe({
            walls: [
              { kind: 'terms-restrict-output', direction: null, reportedBy: 1 },
            ] as unknown as AtlasEntry['recipes'][number]['walls'],
          }),
        ] as AtlasEntry['recipes'],
      }),
    )

    expect(asked).toContain(
      'Yes — the terms allow the account and restrict what may be published with it. Hit by 1 walk.',
    )
  })

  /**
   * **Decision 4, asserted as the property rather than as a snapshot.** A
   * `FAQPage` whose answers are not on the page is a spam signal and a lie in the
   * same markup, so the test extracts both sides and compares them — the markup
   * cannot drift from the box while this passes.
   */
  it('puts every answer it publishes as data on the page itself', () => {
    const html = page()
    const published = faq(html)
    const questions = published?.['mainEntity'] as readonly {
      name: string
      acceptedAnswer: { text: string }
    }[]

    expect(questions).toHaveLength(10)

    for (const one of questions) {
      expect(decoded(html)).toContain(one.name)
      expect(decoded(html)).toContain(one.acceptedAnswer.text)
    }
  })

  /**
   * Rejection case: `#1100` removed the `HowTo` because it was the steps in JSON
   * beside a page that no longer prints them, and nothing since may bring it back.
   */
  it('emits no HowTo markup anywhere on the Atlas', () => {
    expect(page()).not.toContain('HowTo')
    expect(atlasIndexPage({ entries: [entry()], canonical: `${SITE}/atlas` })).not.toContain(
      'HowTo',
    )
  })

  /**
   * Rejection case, decision 7: an entry nobody has written gets the heading and
   * an honest box, and neither a rich result nor an index entry.
   */
  it('gives a placeholder the honest box, no FAQPage and its noindex', () => {
    const html = page({
      status: 'unwritten',
      recipes: [
        recipe({ status: 'unwritten', cost: 'unknown', terms: 'unknown' }),
      ] as AtlasEntry['recipes'],
    })

    expect(faq(html)).toBeUndefined()
    expect(blocks(html)).toHaveLength(1)
    expect(html).toContain('noindex, follow')
    expect(html).toContain(
      '<h1>How can an AI agent create a social account at mastodon.example?</h1>',
    )
    expect(box(html)).toContain(ATLAS_NOT_KNOWN)
  })

  /**
   * Decision 6: the line names the three things rather than gesturing at *more
   * detail for citizens*, which is the sentence every catalogue writes and nobody
   * believes.
   */
  it('names the steps, the remedies and the walks in the citizenship line', () => {
    const body = main(
      page({
        recipes: [
          recipe({
            walls: [
              { kind: 'payment-required', direction: null, reportedBy: 3, amountUsd: 5 },
            ] as unknown as AtlasEntry['recipes'][number]['walls'],
          }),
        ] as AtlasEntry['recipes'],
      }),
    )

    expect(body).toContain('ordered steps')
    expect(body).toContain('remedy that got past each wall')
    expect(body).toContain('the walks both were written from')
    expect(body.indexOf('k-atlas-criteria')).toBeLessThan(body.indexOf('k-atlas-citizen'))
  })

  /**
   * **And it names only what is there** (`#1169`). The line promised all three
   * whenever an entry carried steps **or** walls, so an entry with steps and no
   * wall offered a remedy nobody had written and a walked entry with a wall and
   * no route offered ordered steps the status forbids it from having.
   */
  it('drops the half of the line the entry has nothing behind', () => {
    const walled = main(
      page({
        recipes: [
          recipe({
            steps: [],
            walls: [
              { kind: 'payment-required', direction: null, reportedBy: 3, amountUsd: 5 },
            ] as unknown as AtlasEntry['recipes'][number]['walls'],
          }),
        ] as AtlasEntry['recipes'],
      }),
    )

    expect(main(page())).toContain('ordered steps')
    expect(main(page())).not.toContain('remedy that got past each wall')

    expect(walled).toContain('remedy that got past each wall')
    expect(walled).not.toContain('ordered steps')
  })

  /**
   * **A line with nothing behind it is the catalogue selling**, which is the rule
   * `membershipSection` already takes on a refusal.
   */
  it('offers nothing where there is no path and no wall to offer', () => {
    expect(
      main(page({ recipes: [recipe({ steps: [], walls: [] })] as AtlasEntry['recipes'] })),
    ).not.toContain('k-atlas-citizen')
    expect(main(page())).toContain('k-atlas-citizen')
  })
})
