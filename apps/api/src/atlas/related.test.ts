import { describe, expect, it } from 'vitest'
import type { AtlasEntry } from '@kolonie-ai/core'
import { ATLAS_RELATED, atlasNeighbourRule, atlasNeighbours } from './related.js'

/**
 * The defect `#1403` was filed about, as a fixture.
 *
 * Measured on `opentask.ai` 2026-08-20: a bounty board offering Alpha Vantage,
 * Anthropic and the OpenAI Platform as the three providers to look at next. All
 * four sat on `data-apis` because no shelf fitted any of them, and the module
 * was reading *the Colony had nowhere to put us* as a resemblance.
 */
const entry = (over: Partial<AtlasEntry> & { readonly provider: string }): AtlasEntry =>
  ({
    title: over.provider,
    path: `/atlas/${over.provider}`,
    status: 'measured',
    category: 'data-apis',
    description: null,
    facets: [],
    operatorNeed: 'unknown',
    operatorNeedIsGuess: false,
    source: 'walker',
    walkers: [],
    health: null,
    recipes: [{ kind: 'api', categoryIsFallback: true }],
    updatedAt: '2026-08-20T00:00:00.000Z',
    ...over,
  }) as unknown as AtlasEntry

const earns = (provider: string, ...slugs: readonly string[]): AtlasEntry =>
  entry({
    provider,
    facets: slugs.map((slug) => ({ axis: 'earn', slug })),
  } as unknown as Partial<AtlasEntry> & { readonly provider: string })

const shelved = (provider: string, category: string, kind: string): AtlasEntry =>
  entry({
    provider,
    category,
    recipes: [{ kind, categoryIsFallback: false }],
  } as unknown as Partial<AtlasEntry> & { readonly provider: string })

const providers = (found: readonly AtlasEntry[]): readonly string[] =>
  found.map((one) => one.provider)

describe('the providers a reader would look at next', () => {
  it('offers earn rails to an earn rail, and never the API shelf it was filed under', () => {
    const opentask = earns('opentask.ai', 'bounty-board')
    const catalogue = [
      opentask,
      entry({ provider: 'alphavantage.co' }),
      entry({ provider: 'anthropic.com' }),
      entry({ provider: 'platform.openai.com' }),
      earns('gitcoin.co', 'bounty-board'),
      earns('huntr.com', 'bounty-board'),
    ]

    expect(providers(atlasNeighbours(opentask, catalogue))).toEqual(['gitcoin.co', 'huntr.com'])
  })

  /**
   * Decision 2. The four providers above share exactly one thing — the fallback
   * shelf — and that is not a shared signal. It is the absence of one.
   */
  it('never offers a peer whose only shared signal is the fallback shelf', () => {
    const opentask = earns('opentask.ai', 'bounty-board')
    const found = atlasNeighbours(opentask, [
      opentask,
      entry({ provider: 'alphavantage.co' }),
      entry({ provider: 'anthropic.com' }),
    ])

    expect(found).toEqual([])
  })

  /**
   * Decision 3. One earn-similar neighbour renders one, and the two empty
   * places stay empty — padding them from the shelf is the defect arriving by
   * another route.
   */
  it('shows fewer than three rather than padding with unrelated peers', () => {
    const opentask = earns('opentask.ai', 'gig-marketplace')
    const found = atlasNeighbours(opentask, [
      opentask,
      earns('ugig.net', 'gig-marketplace'),
      entry({ provider: 'alphavantage.co' }),
      entry({ provider: 'anthropic.com' }),
      entry({ provider: 'platform.openai.com' }),
    ])

    expect(providers(found)).toEqual(['ugig.net'])
  })

  it('prefers the candidate sharing more earn facets, then the catalogue order', () => {
    const both = earns('clawlancer.ai', 'bounty-board', 'gig-marketplace')
    const catalogue = [
      both,
      earns('ugig.net', 'gig-marketplace'),
      earns('trybounty.ai', 'bounty-board', 'gig-marketplace'),
      earns('gitcoin.co', 'bounty-board'),
    ]

    expect(providers(atlasNeighbours(both, catalogue))).toEqual([
      'trybounty.ai',
      'ugig.net',
      'gitcoin.co',
    ])
  })

  /**
   * A provider with no earn facet asks the ordinary question — *another
   * provider of the same thing* — and a shelf that is a claim still answers it.
   * `#1403` narrowed the fallback shelf and did not narrow the real ones.
   */
  it('keeps the shelf as a signal where the shelf is a claim', () => {
    const mine = shelved('mail.tm', 'mailboxes', 'mailbox')
    const catalogue = [
      mine,
      shelved('atomicmail.io', 'mailboxes', 'mailbox'),
      entry({ provider: 'alphavantage.co' }),
    ]

    expect(providers(atlasNeighbours(mine, catalogue))).toEqual(['atomicmail.io'])
  })

  it('never offers the provider whose page this is', () => {
    const mine = shelved('mail.tm', 'mailboxes', 'mailbox')

    expect(atlasNeighbours(mine, [mine, mine])).toEqual([])
  })

  it('carries at most three however many qualify', () => {
    const mine = earns('opentask.ai', 'bounty-board')
    const catalogue = [
      mine,
      ...['a', 'b', 'c', 'd', 'e'].map((one) => earns(`${one}.example`, 'bounty-board')),
    ]

    expect(atlasNeighbours(mine, catalogue)).toHaveLength(ATLAS_RELATED)
  })

  /**
   * Decision 4. The caption said *the same shelf* on every page, including the
   * ones where the shelf had stopped deciding anything.
   */
  it('states the rule it actually applied', () => {
    expect(atlasNeighbourRule(earns('opentask.ai', 'bounty-board'))).toContain('pay the same way')
    expect(atlasNeighbourRule(shelved('mail.tm', 'mailboxes', 'mailbox'))).toContain(
      'the same thing',
    )
  })

  /** An entry stored before `#1301` has no facet array, and must not throw. */
  it('renders no neighbour rather than throwing on an entry with no facets', () => {
    const old = { provider: 'ancient.example', category: 'mailboxes' } as unknown as AtlasEntry

    expect(atlasNeighbours(old, [old])).toEqual([])
  })
})
