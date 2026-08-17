import { describe, expect, it } from 'vitest'
import type { AtlasEntry } from '@kolonie-ai/core'
import { asJsonLdBlock, breadcrumbFor, itemListFor } from './structured-data.js'

const SITE = 'https://kolonie.example'

/**
 * The rows are built by hand rather than through a fixture because what is under
 * test is the mapping from a row's state to what it claims about itself, and the
 * interesting cases are the states that must claim nothing.
 */
const recipe = (over: Partial<AtlasEntry['recipes'][number]> = {}) =>
  ({
    kind: 'github',
    provider: 'trello.com',
    title: 'Trello',
    about: null,
    runtimes: [],
    paid: false,
    referral: null,
    contact: null,
    lastConfirmedAt: null,
    status: 'joinable',
    category: 'code-hosting',
    operatorNeed: 'not-needed',
    operatorNeedIsGuess: false,
    operatorGuess: null,
    refusal: null,
    retiredAt: null,
    retiredReason: null,
    steps: [{ actor: 'agent', instruction: 'Open the signup page.' }],
    proves: 'provider-post',
    provesTask: null,
    reaches: null,
    cautions: [],
    walkedRecipe: null,
    agentApi: 'unknown',
    signupCode: 'unknown',
    pacePerDay: null,
    updatedAt: '2026-08-12T00:00:00.000Z',
    figures: { attempted: 0, proved: 0, suppressed: false, medianHoursToProof: null },
    ...over,
  }) as unknown as AtlasEntry['recipes'][number]

const entry = (over: Partial<AtlasEntry> = {}): AtlasEntry =>
  ({
    provider: 'trello.com',
    title: 'Trello',
    path: '/atlas/trello.com',
    status: 'joinable',
    category: 'code-hosting',
    operatorNeed: 'not-needed',
    operatorNeedIsGuess: false,
    recipes: [recipe()],
    updatedAt: '2026-08-12T00:00:00.000Z',
    ...over,
  }) as unknown as AtlasEntry

describe('the Atlas as structured data', () => {
  /**
   * **The `HowTo` was removed rather than trimmed** (`#1100`). It was a list of
   * step names and step text, the steps are what citizenship buys, and a `HowTo`
   * with no `HowToStep` in it is not a smaller claim but an empty one. The three
   * tests that stood here went with the function; what enforces the rule now is
   * `public-projection.test.ts`, which asserts against the rendered page rather
   * than against one of its blocks.
   */
  it('writes a breadcrumb for every state, because a refusal is still a place', () => {
    const block = breadcrumbFor(entry({ status: 'refused' }), SITE)
    const parsed = JSON.parse(block.replace(/^<script[^>]*>|<\/script>$/g, ''))

    expect(parsed.itemListElement.map((one: { item: string }) => one.item)).toEqual([
      `${SITE}/atlas`,
      `${SITE}/atlas/c/code-hosting`,
      `${SITE}/atlas/trello.com`,
    ])
  })

  it('lists the index in the order it was given, and counts what it listed', () => {
    const block = itemListFor(
      [entry(), entry({ provider: 'github.com', title: 'GitHub', path: '/atlas/github.com' })],
      SITE,
    )
    const parsed = JSON.parse(block.replace(/^<script[^>]*>|<\/script>$/g, ''))

    expect(parsed.numberOfItems).toBe(2)
    expect(parsed.itemListElement[0].name).toBe('Trello')
    expect(parsed.itemListElement[1].url).toBe(`${SITE}/atlas/github.com`)
  })

  /**
   * **The whole of the injection defence.** The catalogue is a table a `psql`
   * prompt writes to by design, so *the values are curated* is not a property
   * this may assume.
   */
  it('cannot break out of the element it is written into', () => {
    const block = asJsonLdBlock({ name: '</script><script>alert(1)</script>', quoted: '"x"' })

    expect(block).not.toContain('</script><script>')
    expect(block.match(/<\/script>/g)).toHaveLength(1)
    expect(JSON.parse(block.replace(/^<script[^>]*>|<\/script>$/g, '')).name).toBe(
      '</script><script>alert(1)</script>',
    )
  })
})
