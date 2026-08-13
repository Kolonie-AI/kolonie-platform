import { describe, expect, it } from 'vitest'
import { AccountKindSchema, AccountProviderSchema } from './account.js'
import {
  atlasEntries,
  atlasEntryHealth,
  atlasEntrySource,
  atlasHealthPhrase,
  atlasSourcePhrase,
  figureKey,
  measuredOnlyRecipes,
} from './atlas.js'
import { noFigures } from './atlas-figures.js'
import type { AtlasFigures } from './atlas-figures.js'
import { RECIPE_STALE_AFTER_DAYS } from './recipe.js'
import type { ProviderRecipe, RecipeStatus } from './recipe.js'

const daysAgo = (days: number): string =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

const figures = (input: {
  kind: string
  provider: string
  attempted?: number
  proved?: number
  suppressed?: boolean
}): AtlasFigures => ({
  ...noFigures(input.kind, input.provider),
  attempted: input.attempted ?? 0,
  proved: input.proved ?? 0,
  suppressed: input.suppressed ?? false,
})

const recipe = (input: {
  kind: string
  provider: string
  status?: RecipeStatus
  lastConfirmedAt?: string | null
  caution?: string | null
  walked?: boolean
}): ProviderRecipe => {
  const status = input.status ?? 'joinable'
  const joinable = status === 'joinable'

  return {
    kind: AccountKindSchema.parse(input.kind),
    provider: AccountProviderSchema.parse(input.provider),
    title: input.provider,
    about: null,
    runtimes: [],
    paid: false,
    referral: null,
    contact: null,
    lastConfirmedAt: (input.lastConfirmedAt === undefined
      ? daysAgo(1)
      : input.lastConfirmedAt) as ProviderRecipe['lastConfirmedAt'],
    status,
    retiredAt: status === 'retired' ? (daysAgo(2) as never) : null,
    retiredReason: status === 'retired' ? 'the provider stopped taking agents' : null,
    category: 'code-hosting',
    operatorNeed: 'unaided',
    operatorNeedIsGuess: false,
    refusal: status === 'refused' ? 'no honest route in' : null,
    steps: joinable ? [{ actor: 'agent', instruction: 'sign up' }] : [],
    proves: joinable ? 'provider-post' : null,
    provesTask: null,
    reaches: null,
    caution: input.caution ?? null,
    walkedRecipe: input.walked === true ? { steps: [] } : null,
    agentApi: 'unknown',
    signupCode: 'unknown',
    pacePerDay: null,
    updatedAt: daysAgo(1) as ProviderRecipe['updatedAt'],
  } as ProviderRecipe
}

const measured = (rows: readonly ProviderRecipe[]) =>
  rows.map((row) => ({ ...row, figures: noFigures(row.kind, row.provider) }))

/**
 * Where an entry came from, said on the entry (`#856`).
 *
 * The shelf now carries three kinds of thing that used to look alike, and a
 * reader deciding whether to trust a set of steps is deciding on their author.
 */
describe('who put a provider on the shelf', () => {
  it('calls an entry a maintainer wrote curated', () => {
    const rows = [recipe({ kind: 'github', provider: 'github.com' })]

    expect(atlasEntrySource(rows, new Set())).toBe('curated')
  })

  /**
   * **The strongest provenance any row has wins**, the same rule the status
   * rollup follows: a provider with one walked recipe was put there by the
   * citizen who walked it, whatever its other rows are.
   */
  it('calls an entry a citizen walked walk-published, even beside a measured row', () => {
    const walked = recipe({ kind: 'github', provider: 'github.com', walked: true })
    const stub = recipe({ kind: 'website', provider: 'github.com', status: 'unwritten' })

    expect(atlasEntrySource([walked, stub], new Set([figureKey(stub.kind, stub.provider)]))).toBe(
      'walk-published',
    )
  })

  it('calls an entry nobody wrote measured', () => {
    const stub = recipe({ kind: 'mailbox', provider: 'somewhere.test', status: 'unwritten' })

    expect(atlasEntrySource([stub], new Set([figureKey(stub.kind, stub.provider)]))).toBe(
      'measured',
    )
  })

  /**
   * A curated `unwritten` row and a synthesized one are the same shape by
   * design, so the answer has to come from the caller that built one. This is
   * the assertion that a heuristic has not crept back in.
   */
  it('does not call a curated unwritten row measured', () => {
    const stub = recipe({ kind: 'mailbox', provider: 'somewhere.test', status: 'unwritten' })

    expect(atlasEntrySource([stub], new Set())).toBe('curated')
  })
})

/**
 * How well an entry's claims have aged (`#860`).
 *
 * Derived on every read from `lastConfirmedAt` and the measurements, so there is
 * no swept flag to go wrong and nothing to edit.
 */
describe('how well an entry has aged', () => {
  it('is ok when a joinable row was confirmed inside the window', () => {
    const rows = measured([recipe({ kind: 'github', provider: 'github.com' })])

    expect(atlasEntryHealth(rows, 'joinable')).toBe('ok')
  })

  it('is stale when every joinable row is past the window', () => {
    const rows = measured([
      recipe({
        kind: 'github',
        provider: 'github.com',
        lastConfirmedAt: daysAgo(RECIPE_STALE_AFTER_DAYS + 1),
      }),
    ])

    expect(atlasEntryHealth(rows, 'joinable')).toBe('stale')
  })

  /** One confirmed row is enough: a reader has something current to follow. */
  it('is not stale while one joinable row is still confirmed', () => {
    const rows = measured([
      recipe({
        kind: 'github',
        provider: 'github.com',
        lastConfirmedAt: daysAgo(RECIPE_STALE_AFTER_DAYS + 1),
      }),
      recipe({ kind: 'website', provider: 'github.com' }),
    ])

    expect(atlasEntryHealth(rows, 'joinable')).toBe('ok')
  })

  it('is caution when a joinable row carries one', () => {
    const rows = measured([
      recipe({ kind: 'github', provider: 'github.com', caution: 'the form times out' }),
    ])

    expect(atlasEntryHealth(rows, 'joinable')).toBe('caution')
  })

  it('is caution when most agents that tried did not get through', () => {
    const row = recipe({ kind: 'github', provider: 'github.com' })
    const rows = [{ ...row, figures: figures({ ...row, attempted: 20, proved: 2 }) }]

    expect(atlasEntryHealth(rows, 'joinable')).toBe('caution')
  })

  /**
   * The floor governs everything derived from the counts, and a caution derived
   * from a suppressed band would be the count reaching a reader in three words.
   */
  it('does not read a band off suppressed counts', () => {
    const row = recipe({ kind: 'github', provider: 'github.com' })
    const rows = [
      { ...row, figures: figures({ ...row, attempted: 3, proved: 0, suppressed: true }) },
    ]

    expect(atlasEntryHealth(rows, 'joinable')).toBe('ok')
  })

  /** *We no longer know* is the more serious of the two to put in front of somebody. */
  it('says stale rather than caution when both are true', () => {
    const rows = measured([
      recipe({
        kind: 'github',
        provider: 'github.com',
        lastConfirmedAt: null,
        caution: 'the form times out',
      }),
    ])

    expect(atlasEntryHealth(rows, 'joinable')).toBe('stale')
  })

  it('is retired when the entry is', () => {
    const rows = measured([recipe({ kind: 'github', provider: 'github.com', status: 'retired' })])

    expect(atlasEntryHealth(rows, 'retired')).toBe('retired')
  })

  /**
   * An entry with nothing joinable claims nothing a reader can follow, and
   * marking it stale would teach the word to mean *old* rather than *unchecked*.
   */
  it('is ok for an entry with nothing joinable, however old it is', () => {
    for (const status of ['unwritten', 'refused'] as const) {
      const rows = measured([
        recipe({ kind: 'github', provider: 'github.com', status, lastConfirmedAt: null }),
      ])

      expect(atlasEntryHealth(rows, status)).toBe('ok')
    }
  })
})

/**
 * The providers the Colony had measured and could not show (`#856`).
 */
describe('the rows the figures imply', () => {
  it('stands an unwritten row in for a measured provider nobody has written up', () => {
    const synthesized = measuredOnlyRecipes(
      [],
      [figures({ kind: 'mailbox', provider: 'somewhere.test', attempted: 8, proved: 5 })],
    )

    expect(synthesized).toHaveLength(1)
    expect(synthesized[0]?.status).toBe('unwritten')
    expect(synthesized[0]?.steps).toEqual([])
    expect(synthesized[0]?.category).toBe('mailbox')
  })

  it('leaves a provider the catalogue already has alone', () => {
    const written = recipe({ kind: 'mailbox', provider: 'somewhere.test' })
    const synthesized = measuredOnlyRecipes(
      [written],
      [figures({ kind: 'mailbox', provider: 'somewhere.test', attempted: 8, proved: 5 })],
    )

    expect(synthesized).toEqual([])
  })

  /**
   * Publishing *this provider exists because somebody tried it* below the floor
   * is the disclosure the floor forbids, wearing a different shape.
   */
  it('skips a pair whose figures are suppressed', () => {
    const synthesized = measuredOnlyRecipes(
      [],
      [
        figures({
          kind: 'mailbox',
          provider: 'somewhere.test',
          attempted: 2,
          proved: 1,
          suppressed: true,
        }),
      ],
    )

    expect(synthesized).toEqual([])
  })

  it('skips a pair nobody has attempted', () => {
    expect(measuredOnlyRecipes([], [figures({ kind: 'mailbox', provider: 'quiet.test' })])).toEqual(
      [],
    )
  })

  /**
   * The account-kind vocabulary is open and a shelf is a claim, so a kind with
   * no shelf is left off rather than filed on a guessed one.
   */
  it('skips a kind no shelf maps to rather than guessing one', () => {
    const synthesized = measuredOnlyRecipes(
      [],
      [figures({ kind: 'sourdough', provider: 'bakery.test', attempted: 9, proved: 4 })],
    )

    expect(synthesized).toEqual([])
  })

  /** The synthesized rows are ordinary rows, so the entry builder needs no special case. */
  it('groups onto an entry like any other row', () => {
    const synthesized = measuredOnlyRecipes(
      [],
      [figures({ kind: 'mailbox', provider: 'somewhere.test', attempted: 8, proved: 5 })],
    )
    const entries = atlasEntries(
      synthesized,
      new Map(),
      new Set(synthesized.map((one) => figureKey(one.kind, one.provider))),
    )

    expect(entries).toHaveLength(1)
    expect(entries[0]?.source).toBe('measured')
    expect(entries[0]?.status).toBe('unwritten')
  })
})

/**
 * Both labels print nothing in their ordinary state, so the great majority of
 * entries read exactly as they did before (`#856`, `#860`).
 */
describe('what the two labels say out loud', () => {
  it('says nothing about an entry a maintainer wrote and somebody confirmed', () => {
    expect(atlasSourcePhrase('curated')).toBe('')
    expect(atlasHealthPhrase('ok')).toBe('')
  })

  it('says who wrote the other two kinds', () => {
    expect(atlasSourcePhrase('walk-published')).toContain('citizen who walked it')
    expect(atlasSourcePhrase('measured')).toContain('Nobody has written this entry')
  })

  /** Each of the three names what to do about it, which is the point of saying it at all. */
  it('names what to do about a withdrawn, stale or risky entry', () => {
    expect(atlasHealthPhrase('retired')).toContain('Do not walk it')
    expect(atlasHealthPhrase('stale')).toContain('provider-report')
    expect(atlasHealthPhrase('caution')).toContain('Take care')
  })
})
