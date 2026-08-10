import { describe, expect, it } from 'vitest'
import { AccountKindSchema, AccountProviderSchema } from './account.js'
import { atlasEntries, atlasPath } from './atlas.js'
import { operatorNeed } from './recipe.js'
import type {
  AtlasCategory,
  ProviderRecipe,
  RecipeOperatorGuess,
  RecipeStatus,
  RecipeStep,
} from './recipe.js'

const recipe = (input: {
  kind: string
  provider: string
  title?: string
  status?: RecipeStatus
  category?: AtlasCategory
  operatorSteps?: boolean
  operatorGuess?: RecipeOperatorGuess
  updatedAt?: string
}): ProviderRecipe => {
  const status = input.status ?? 'joinable'
  const joinable = status === 'joinable'
  const steps: RecipeStep[] = !joinable
    ? []
    : input.operatorSteps === true
      ? [
          { actor: 'agent', instruction: 'sign up' },
          { actor: 'operator', instruction: 'accept the terms', ask: 'Please accept the terms.' },
        ]
      : [{ actor: 'agent', instruction: 'sign up' }]
  const need = operatorNeed({ steps, operatorGuess: input.operatorGuess })

  return {
    kind: AccountKindSchema.parse(input.kind),
    provider: AccountProviderSchema.parse(input.provider),
    title: input.title ?? input.provider,
    about: null,
    runtimes: [],
    paid: false,
    referral: null,
    contact: null,
    lastConfirmedAt: '2026-08-01T00:00:00.000Z' as never,
    status,
    retiredAt: status === 'retired' ? ('2026-08-09T00:00:00.000Z' as never) : null,
    retiredReason: status === 'retired' ? 'the provider stopped taking agents' : null,
    category: input.category ?? 'code-hosting',
    operatorNeed: need.need,
    operatorNeedIsGuess: need.isGuess,
    refusal: status === 'refused' ? 'no honest route in' : null,
    steps,
    proves: joinable ? 'provider-post' : null,
    provesTask: null,
    caution: null,
    agentApi: 'unknown' as const,
    signupCode: 'unknown' as const,
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
      recipe({ kind: 'social', provider: 'github', title: 'GitHub (social)', status: 'refused' }),
      recipe({ kind: 'github', provider: 'github', title: 'GitHub' }),
    ])

    expect(entries[0]?.status).toBe('joinable')
    expect(entries[0]?.title).toBe('GitHub')
  })

  it('is not joinable when every row on it is a refusal', () => {
    const entries = atlasEntries([
      recipe({ kind: 'social', provider: 'bluesky', status: 'refused' }),
    ])

    expect(entries[0]?.status).toBe('refused')
  })

  /**
   * The state `#588` added, and the one the boolean could not reach: a provider
   * the Atlas lists and nobody has investigated. It must not roll up as
   * *refused* — that would be the catalogue claiming a finding it never made.
   */
  it('is unwritten when nobody has looked at any of its rows', () => {
    const entries = atlasEntries([
      recipe({ kind: 'mailbox', provider: 'fastmail.com', status: 'unwritten' }),
      recipe({ kind: 'domain', provider: 'fastmail.com', status: 'unwritten' }),
    ])

    expect(entries[0]?.status).toBe('unwritten')
  })

  /** A walked refusal outranks *nobody looked* — one of them is a finding. */
  it('prefers a refusal to an unwritten row when no row is joinable', () => {
    const entries = atlasEntries([
      recipe({ kind: 'social', provider: 'x.com', status: 'unwritten' }),
      recipe({ kind: 'mailbox', provider: 'x.com', status: 'refused', title: 'X — no route' }),
    ])

    expect(entries[0]?.status).toBe('refused')
    expect(entries[0]?.title).toBe('X — no route')
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

  /**
   * `#589`. One shelf per provider: a provider listed on two is `#547`'s
   * combination page arriving as an index, which `growth/README.md` refuses.
   */
  it('takes its category from the row it takes its title from', () => {
    const entries = atlasEntries([
      recipe({
        kind: 'social',
        provider: 'github',
        status: 'refused',
        category: 'social-publishing',
      }),
      recipe({ kind: 'github', provider: 'github', category: 'code-hosting' }),
    ])

    expect(entries[0]?.category).toBe('code-hosting')
  })
})

/**
 * Who has to be there, rolled up (`#589`).
 *
 * The whole value of the field is that an operator can tell where they will be
 * needed, so the rollup errs towards *you will be*: silence must never read as
 * *you are not needed*, which is the answer that gets somebody called at the
 * wrong moment.
 */
describe('whether a provider needs an operator anywhere on it', () => {
  it('says so when any row on it does, however many do not', () => {
    const entries = atlasEntries([
      recipe({ kind: 'github', provider: 'github' }),
      recipe({ kind: 'website', provider: 'github', operatorSteps: true }),
    ])

    expect(entries[0]?.operatorNeed).toBe('operator-needed')
    expect(entries[0]?.operatorNeedIsGuess).toBe(false)
  })

  it('says unaided only when every row it has is', () => {
    const entries = atlasEntries([recipe({ kind: 'trello', provider: 'trello.com' })])

    expect(entries[0]?.operatorNeed).toBe('unaided')
  })

  /** An unknown row does not soften a known one, and does not read as *unaided* either. */
  it('prefers unknown to unaided when one row has not been walked', () => {
    const entries = atlasEntries([
      recipe({ kind: 'mailbox', provider: 'fastmail.com', status: 'unwritten' }),
      recipe({ kind: 'domain', provider: 'fastmail.com' }),
    ])

    expect(entries[0]?.operatorNeed).toBe('unknown')
  })

  /** A guess is carried as a guess, so no surface can render it as an answer. */
  it('marks an answer that rests only on a guess', () => {
    const entries = atlasEntries([
      recipe({
        kind: 'mailbox',
        provider: 'fastmail.com',
        status: 'unwritten',
        operatorGuess: 'unaided',
      }),
    ])

    expect(entries[0]?.operatorNeed).toBe('unaided')
    expect(entries[0]?.operatorNeedIsGuess).toBe(true)
  })

  /** And stops being a guess the moment one walked row says the same thing. */
  it('stops calling it a guess once a walked row agrees', () => {
    const entries = atlasEntries([
      recipe({
        kind: 'mailbox',
        provider: 'fastmail.com',
        status: 'unwritten',
        operatorGuess: 'unaided',
      }),
      recipe({ kind: 'domain', provider: 'fastmail.com' }),
    ])

    expect(entries[0]?.operatorNeed).toBe('unaided')
    expect(entries[0]?.operatorNeedIsGuess).toBe(false)
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
