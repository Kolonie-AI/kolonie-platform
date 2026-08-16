import { describe, expect, it } from 'vitest'
import { AccountKindSchema, AccountProviderSchema } from './account.js'
import {
  atlasByOutcome,
  atlasCapabilityPhrase,
  atlasEntries,
  atlasIsWalked,
  atlasKindPhrase,
  atlasPath,
  atlasShelfTitle,
  atlasStateOf,
} from './atlas.js'
import { AtlasCategorySchema, operatorNeed } from './recipe.js'
import type {
  AtlasCategory,
  ProviderRecipe,
  RecipeOperatorGuess,
  RecipeStatus,
  RecipeStep,
} from './recipe.js'
import type { RecipeDirection } from './atlas-direction.js'

const recipe = (input: {
  kind: string
  provider: string
  title?: string
  status?: RecipeStatus
  category?: AtlasCategory
  operatorSteps?: boolean
  operatorGuess?: RecipeOperatorGuess
  updatedAt?: string
  direction?: RecipeDirection
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
    /** Unscoped unless a test about the axis says otherwise (`#976`). */
    direction: input.direction ?? null,
    retiredAt: status === 'retired' ? ('2026-08-09T00:00:00.000Z' as never) : null,
    retiredReason: status === 'retired' ? 'the provider stopped taking agents' : null,
    category: input.category ?? 'code-hosting',
    operatorNeed: need.need,
    operatorNeedIsGuess: need.isGuess,
    refusal: status === 'refused' ? 'no honest route in' : null,
    steps,
    proves: joinable ? 'provider-post' : null,
    provesTask: null,
    reaches: null,
    cautions: [],
    walkedRecipe: null,
    walls: [],
    agentApi: 'unknown' as const,
    signupCode: 'unknown' as const,
    needs: [],
    terms: 'unknown' as const,
    cost: 'unknown' as const,
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

/**
 * Whether anybody has looked at a provider, and where that puts it (`#790`).
 *
 * **The predicate is asserted here rather than through a page**, because two
 * surfaces read it — the sitemap and the entry page's `robots` meta — and a
 * disagreement between them is a page submitted to a crawler by name that asks
 * to be left out of the index.
 */
describe('an entry nobody has walked', () => {
  const providers = (entries: readonly { readonly provider: string }[]) =>
    entries.map((one) => one.provider)

  const oneEntry = (...rows: readonly ProviderRecipe[]) => {
    const [entry] = atlasEntries(rows)
    if (entry === undefined) throw new Error('no entry')

    return entry
  }

  it('is walked as soon as one of its rows is, however many are not', () => {
    const entry = oneEntry(
      recipe({ kind: 'mailbox', provider: 'half.example', status: 'unwritten' }),
      recipe({ kind: 'domain', provider: 'half.example' }),
    )

    expect(atlasIsWalked(entry)).toBe(true)
  })

  /** The distinction the whole rule rests on: a refusal is a finding, not a gap. */
  it('counts a refusal and a withdrawal as walked', () => {
    const refused = oneEntry(
      recipe({ kind: 'social', provider: 'closed.example', status: 'refused' }),
    )
    const retired = oneEntry(
      recipe({ kind: 'mailbox', provider: 'gone.example', status: 'retired' }),
    )

    expect(atlasIsWalked(refused)).toBe(true)
    expect(atlasIsWalked(retired)).toBe(true)
  })

  it('is unwalked only when every row on it is', () => {
    const entry = oneEntry(
      recipe({ kind: 'mailbox', provider: 'nobody.example', status: 'unwritten' }),
      recipe({ kind: 'domain', provider: 'nobody.example', status: 'unwritten' }),
    )

    expect(atlasIsWalked(entry)).toBe(false)
  })

  /**
   * **Below the refusal, which is the opposite of `atlasRank`'s own ladder.**
   * There a road that may work beats one known to be closed; here the question
   * is what a reader should look at first, and a placeholder never is.
   */
  it('sorts below every entry somebody has walked', () => {
    const entries = atlasEntries([
      recipe({ kind: 'mailbox', provider: 'nobody.example', status: 'unwritten' }),
      recipe({ kind: 'social', provider: 'closed.example', status: 'refused' }),
      recipe({ kind: 'github', provider: 'open.example' }),
    ])

    expect(providers(atlasByOutcome(entries))).toEqual([
      'open.example',
      'closed.example',
      'nobody.example',
    ])
  })

  it('keeps the catalogue’s own order among the entries beside it', () => {
    const entries = atlasEntries([
      recipe({ kind: 'mailbox', provider: 'second.example', status: 'unwritten' }),
      recipe({ kind: 'mailbox', provider: 'first.example', status: 'unwritten' }),
    ])

    expect(providers(atlasByOutcome(entries))).toEqual(['second.example', 'first.example'])
  })
})

/**
 * What a thing is called where a reader sees it (`#791`).
 *
 * **The fallback is the point of the tests below.** Kinds and capabilities are
 * open vocabularies, so a value neither map has heard of is an ordinary event
 * and has to render as itself rather than as nothing.
 */
describe('the words a heading is written in', () => {
  it('gives a kind in the map its noun phrase, article and all', () => {
    expect(atlasKindPhrase('mailbox')).toBe('A mailbox')
    expect(atlasKindPhrase('api')).toBe('An API account')
  })

  it('gives a kind in neither map its own slug back', () => {
    expect(atlasKindPhrase('weather-feed')).toBe('weather-feed')
  })

  /** The same slug is a different thing here: `api` the account, `api` the key. */
  it('reads a capability as what it is rather than as the account behind it', () => {
    expect(atlasCapabilityPhrase('api')).toBe('An API key')
  })

  it('falls a capability through the kind map and then to the slug', () => {
    expect(atlasCapabilityPhrase('mailbox')).toBe('A mailbox')
    expect(atlasCapabilityPhrase('weather-feed')).toBe('weather-feed')
  })

  it('titles a shelf and leaves an unknown category as its slug', () => {
    expect(atlasShelfTitle('identity-security')).toBe('Identity and security')
    expect(atlasShelfTitle('code-hosting')).toBe('Code hosting')
    expect(atlasShelfTitle('nothing-is-filed-here')).toBe('nothing-is-filed-here')
  })

  /** Every category in the vocabulary has a title, so no shelf renders as an enum value. */
  it('has a title for every category the vocabulary allows', () => {
    for (const category of AtlasCategorySchema.options) {
      expect(atlasShelfTitle(category), `${category} has no shelf title`).not.toBe(category)
    }
  })
})

/**
 * Seven statuses onto three states (`#936`).
 *
 * **The folding is the thing under test and not the rendering.** Two surfaces
 * ask the Atlas the same question about a provider somebody is about to walk —
 * the console page and the thread read — and two mappings of the same seven
 * values would be D-002 arriving as a pair of switch statements. What each
 * surface does with the answer is asserted where that surface is.
 */
describe('what the Atlas has on a provider somebody is about to walk', () => {
  const entriesOf = (recipes: readonly ProviderRecipe[]) => atlasEntries(recipes)

  it('reads a joinable entry as walked, with its steps and a steward behind it', () => {
    const state = atlasStateOf(
      entriesOf([recipe({ kind: 'mailbox', provider: 'mail.example', operatorSteps: true })]),
      'mail.example',
    )

    expect(state.state).toBe('walked')
    if (state.state !== 'walked') return
    expect(state.reviewed).toBe(true)
    expect(state.steps).toEqual(['sign up', 'accept the terms'])
    expect(state.operatorSteps).toBe(1)
  })

  /** A refusal and a withdrawal are one warning with two reasons behind it. */
  it('reads a refused entry as closed, carrying what the refusal said', () => {
    const state = atlasStateOf(
      entriesOf([recipe({ kind: 'mailbox', provider: 'shut.example', status: 'refused' })]),
      'shut.example',
    )

    expect(state.state).toBe('closed')
    if (state.state !== 'closed') return
    expect(state.withdrawn).toBe(false)
    expect(state.reason).toBe('no honest route in')
  })

  it('reads a retired entry as closed and withdrawn rather than refused', () => {
    const state = atlasStateOf(
      entriesOf([recipe({ kind: 'mailbox', provider: 'gone.example', status: 'retired' })]),
      'gone.example',
    )

    expect(state.state).toBe('closed')
    if (state.state !== 'closed') return
    expect(state.withdrawn).toBe(true)
    expect(state.reason).toBe('the provider stopped taking agents')
  })

  it('reads a provider nobody has filed at all as unwalked', () => {
    expect(
      atlasStateOf(
        entriesOf([recipe({ kind: 'mailbox', provider: 'mail.example' })]),
        'new.example',
      ),
    ).toEqual({ state: 'unwalked', provider: 'new.example' })
  })

  /**
   * **Steps and not status decide whether there is a crib sheet.** A `measured`
   * row is a real entry with nothing written on it, and calling that *walked*
   * would promise a path and then render an empty list.
   */
  it('reads an entry with no steps as unwalked, whatever its status says', () => {
    expect(
      atlasStateOf(
        entriesOf([recipe({ kind: 'mailbox', provider: 'empty.example', status: 'measured' })]),
        'empty.example',
      ).state,
    ).toBe('unwalked')
  })

  /**
   * A draft carries steps somebody walked and nobody reviewed. They are the only
   * account of the path that exists, so they are shown — with the caveat that
   * stops them reading as the Colony's own instruction, which is `#604`'s rule.
   */
  it('shows a draft’s steps and says no steward stood behind them', () => {
    const draft = {
      ...recipe({ kind: 'mailbox', provider: 'draft.example', status: 'draft' }),
      steps: [{ actor: 'agent' as const, instruction: 'ask for an invitation' }],
    }

    const state = atlasStateOf(entriesOf([draft]), 'draft.example')

    expect(state.state).toBe('walked')
    if (state.state !== 'walked') return
    expect(state.reviewed).toBe(false)
    expect(state.steps).toEqual(['ask for an invitation'])
  })

  /** The kind narrows a provider walked for more than one sort of account. */
  it('answers about the kind the caller names, where the caller knows one', () => {
    const entries = entriesOf([
      recipe({ kind: 'mailbox', provider: 'both.example' }),
      recipe({ kind: 'domain', provider: 'both.example', status: 'refused' }),
    ])

    expect(atlasStateOf(entries, 'both.example', 'mailbox').state).toBe('walked')
    expect(atlasStateOf(entries, 'both.example', 'domain').state).toBe('closed')
  })

  /** A kind the entry has no row for falls back to the row the entry is titled by. */
  it('falls back to the row the entry stands for when the kind is not one of them', () => {
    const state = atlasStateOf(
      entriesOf([recipe({ kind: 'mailbox', provider: 'mail.example' })]),
      'mail.example',
      'weather-feed',
    )

    expect(state.state).toBe('walked')
    if (state.state !== 'walked') return
    expect(state.kind).toBe('mailbox')
  })

  it('finds the entry whatever case and spacing the provider arrives in', () => {
    expect(
      atlasStateOf(
        entriesOf([recipe({ kind: 'mailbox', provider: 'mail.example' })]),
        '  MAIL.example ',
      ).state,
    ).toBe('walked')
  })
})
