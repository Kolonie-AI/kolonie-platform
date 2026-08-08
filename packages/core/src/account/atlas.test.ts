import { describe, expect, it } from 'vitest'
import { AccountKindSchema, AccountProviderSchema } from './account.js'
import { atlasEntries, atlasPath } from './atlas.js'
import type { ProviderRecipe } from './recipe.js'

const recipe = (input: {
  kind: string
  provider: string
  title?: string
  joinable?: boolean
  updatedAt?: string
}): ProviderRecipe => {
  const joinable = input.joinable ?? true

  return {
    kind: AccountKindSchema.parse(input.kind),
    provider: AccountProviderSchema.parse(input.provider),
    title: input.title ?? input.provider,
    about: null,
    runtimes: [],
    paid: false,
    joinable,
    refusal: joinable ? null : 'no honest route in',
    steps: joinable ? [{ actor: 'agent', instruction: 'sign up' }] : [],
    proves: joinable ? 'provider-post' : null,
    caution: null,
    pacePerDay: null,
    updatedAt: (input.updatedAt ?? '2026-08-01T00:00:00.000Z') as ProviderRecipe['updatedAt'],
  }
}

/**
 * An Atlas entry is a provider, and not a row (`#546`).
 *
 * The grouping is the thing three surfaces share — the pages, the tool and the
 * data route — so it is asserted here rather than three times over.
 */
describe('grouping the catalogue into entries', () => {
  it('puts every kind a provider offers on one entry', () => {
    const entries = atlasEntries([
      recipe({ kind: 'github', provider: 'github' }),
      recipe({ kind: 'website', provider: 'github' }),
    ])

    expect(entries).toHaveLength(1)
    expect(entries[0]?.recipes.map((one) => one.kind)).toEqual(['github', 'website'])
  })

  /**
   * `#547` refuses a page per provider × kind: two hundred near-duplicates are
   * the doorway pattern `growth/README.md` already forbids. This is where that
   * refusal is structural rather than a rule somebody has to remember.
   */
  it('never produces more entries than there are providers', () => {
    const entries = atlasEntries([
      recipe({ kind: 'github', provider: 'github' }),
      recipe({ kind: 'website', provider: 'github' }),
      recipe({ kind: 'mailbox', provider: 'mail.tm' }),
    ])

    expect(entries.map((one) => one.provider)).toEqual(['github', 'mail.tm'])
  })

  it('keeps the order the catalogue gave it', () => {
    const entries = atlasEntries([
      recipe({ kind: 'mailbox', provider: 'mail.tm' }),
      recipe({ kind: 'github', provider: 'github' }),
    ])

    expect(entries.map((one) => one.provider)).toEqual(['mail.tm', 'github'])
  })

  /**
   * A provider with one working recipe and one refused kind is a provider you
   * can join. Titling the page with the refusal would say the opposite before
   * the reader reaches the list.
   */
  it('is joinable when anything on it is, and takes its title from that row', () => {
    const entries = atlasEntries([
      recipe({ kind: 'social', provider: 'github', title: 'GitHub (social)', joinable: false }),
      recipe({ kind: 'github', provider: 'github', title: 'GitHub' }),
    ])

    expect(entries[0]?.joinable).toBe(true)
    expect(entries[0]?.title).toBe('GitHub')
  })

  it('is not joinable when every row on it is a refusal', () => {
    const entries = atlasEntries([recipe({ kind: 'social', provider: 'bluesky', joinable: false })])

    expect(entries[0]?.joinable).toBe(false)
  })

  /** What a reader wants dated is the newest thing known about the provider. */
  it('dates an entry by its most recent row', () => {
    const entries = atlasEntries([
      recipe({ kind: 'github', provider: 'github', updatedAt: '2026-07-01T00:00:00.000Z' }),
      recipe({ kind: 'website', provider: 'github', updatedAt: '2026-08-05T00:00:00.000Z' }),
    ])

    expect(entries[0]?.updatedAt).toBe('2026-08-05T00:00:00.000Z')
  })

  it('carries the path so no consumer has to build one', () => {
    expect(atlasEntries([recipe({ kind: 'github', provider: 'github' })])[0]?.path).toBe(
      '/atlas/github',
    )
  })
})

describe('the path an entry is served at', () => {
  it('is the provider, readable and never an id', () => {
    expect(atlasPath('github')).toBe('/atlas/github')
  })

  it('normalises the way the register does, so one provider has one path', () => {
    expect(atlasPath('GitHub')).toBe('/atlas/github')
  })

  /** A provider is one token. Anything else would put a stranger's text in a URL. */
  it('refuses something that is not a provider', () => {
    expect(() => atlasPath('../../etc/passwd')).toThrow()
  })
})
