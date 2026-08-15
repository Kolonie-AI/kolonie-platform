import { describe, expect, it } from 'vitest'
import { AccountKindSchema, AccountProviderSchema } from './account.js'
import {
  atlasEntries,
  atlasEntryHealth,
  atlasEntryStatus,
  atlasEntrySource,
  atlasEntryWalkers,
  atlasHealthPhrase,
  atlasSourcePhrase,
  figureKey,
  measuredOnlyRecipes,
} from './atlas.js'
import { noFigures } from './atlas-figures.js'
import type { AtlasFigures } from './atlas-figures.js'
import { RECIPE_STALE_AFTER_DAYS, RecipeStatusSchema, recipeStatusIsPublic } from './recipe.js'
import type { ProviderRecipe, RecipeStatus } from './recipe.js'

const daysAgo = (days: number): string =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

const figures = (input: {
  kind: string
  provider: string
  attempted?: number
  proved?: number
  suppressed?: boolean
  evidenced?: boolean
}): AtlasFigures => ({
  ...noFigures(input.kind, input.provider),
  attempted: input.attempted ?? 0,
  proved: input.proved ?? 0,
  suppressed: input.suppressed ?? false,
  /**
   * **Defaulted from the counts so that a fake row cannot be a shape the Colony
   * never serves** (`#977`). A suppressed row arrives from the database with its
   * counts zeroed, so a test writing `attempted: 2, suppressed: true` is
   * describing a row that does not exist — which is how `#909` shipped a
   * function that could not fire. Pass `evidenced` explicitly to build the real
   * suppressed shape: zeroed counts, and a citizen behind them.
   */
  evidenced: input.evidenced ?? ((input.attempted ?? 0) > 0 || (input.proved ?? 0) > 0),
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
    /** Unscoped: this file is about provenance, not the axis (`#976`). */
    direction: null,
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
    walls: [],
    agentApi: 'unknown',
    signupCode: 'unknown',
    needs: [],
    terms: 'unknown',
    cost: 'unknown',
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

  /**
   * An entry is a provider and its rows are kinds (`#960`). The citizen who
   * walked the mailbox and the one who walked the website are both walkers of
   * the provider — naming only the row a reader scrolled to would make the
   * attribution depend on where they stopped.
   */
  it('unions the walkers of every row into the entry', () => {
    const mailbox = recipe({ kind: 'mailbox', provider: 'somewhere.test', walked: true })
    const website = recipe({ kind: 'website', provider: 'somewhere.test', walked: true })

    const named = atlasEntryWalkers(
      [mailbox, website],
      new Map([
        [figureKey(mailbox.kind, mailbox.provider), ['grace']],
        [figureKey(website.kind, website.provider), ['ada']],
      ]),
    )

    // Sorted, so two readers of the same entry read the same sentence.
    expect(named).toEqual(['ada', 'grace'])
  })

  /** One citizen who walked two kinds at a provider is one walker of it, not two. */
  it('names a citizen once however many rows it walked', () => {
    const mailbox = recipe({ kind: 'mailbox', provider: 'somewhere.test', walked: true })
    const website = recipe({ kind: 'website', provider: 'somewhere.test', walked: true })

    expect(
      atlasEntryWalkers(
        [mailbox, website],
        new Map([
          [figureKey(mailbox.kind, mailbox.provider), ['ada']],
          [figureKey(website.kind, website.provider), ['ada']],
        ]),
      ),
    ).toEqual(['ada'])
  })

  /** Absent means unattributed rather than unwalked, and renders without them. */
  it('carries an empty list for an entry nobody is named on', () => {
    const rows = [recipe({ kind: 'github', provider: 'github.com', walked: true })]

    expect(atlasEntries(rows, new Map(), new Set())[0]?.walkers).toEqual([])
  })

  it('carries the walkers through onto the entry', () => {
    const row = recipe({ kind: 'github', provider: 'github.com', walked: true })

    const [entry] = atlasEntries(
      [row],
      new Map(),
      new Set(),
      new Map([[figureKey(row.kind, row.provider), ['ada']]]),
    )

    expect(entry?.walkers).toEqual(['ada'])
    expect(entry?.source).toBe('walk-published')
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
  it('stands a measured row in for a provider nobody has written up', () => {
    const synthesized = measuredOnlyRecipes(
      [],
      [figures({ kind: 'mailbox', provider: 'somewhere.test', attempted: 8, proved: 5 })],
    )

    expect(synthesized).toHaveLength(1)
    /**
     * **`measured` since `#903`, and the rename is the point of it.** Both
     * labels say *nobody has written the route*; only this one also says
     * *citizens have been here*, which is why this function exists at all.
     */
    expect(synthesized[0]?.status).toBe('measured')
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
   * **The row exists from the first proof, and the counts stay behind the floor**
   * (`#909`, on `kolonie-docs#352`). This test asserted the opposite until then,
   * on the argument that publishing *this provider exists because somebody tried
   * it* is the same disclosure as the numbers wearing a different shape.
   *
   * The measurement is what overturned it: the largest provider sample in the
   * Colony was **3** on 2026-08-14 against a floor of 5, so the skip never
   * delayed a row — it meant none was ever synthesised, which is the feature not
   * existing. And the two claims are not the same claim: *three citizens hold a
   * mailbox here* is a number about three citizens, *a citizen got in here* is a
   * fact about the provider and names nobody.
   */
  it('stands a row in for a pair whose counts are below the floor', () => {
    const synthesized = measuredOnlyRecipes(
      [],
      /**
       * **The shape a suppressed row actually has** (`#977`): the counts are
       * zeroed on the way out of {@link atlasFigures}, not merely flagged, and
       * `evidenced` is what is left knowing a citizen was here. This test asked
       * for `attempted: 2, proved: 1, suppressed: true` until then — a row the
       * Colony never serves — and passed on it while the real one was being
       * dropped.
       */
      [
        figures({
          kind: 'mailbox',
          provider: 'somewhere.test',
          attempted: 0,
          proved: 0,
          suppressed: true,
          evidenced: true,
        }),
      ],
    )

    expect(synthesized).toHaveLength(1)
    expect(synthesized[0]?.status).toBe('measured')
    /**
     * The row and nothing else. A measured entry's content is that citizens got
     * in, so it may carry no route, no warning and no sentence about succeeding
     * — the absence is the content rather than a gap in it.
     */
    expect(synthesized[0]?.steps).toEqual([])
    expect(synthesized[0]?.caution).toBeNull()
    expect(synthesized[0]?.proves).toBeNull()
  })

  /**
   * **The floor still governs the counts**, which is the half `#909` did not
   * change: suppression rides on the figures and the row carries none of them.
   */
  it('leaves the suppressed figures suppressed beside the row it stood in', () => {
    const suppressed = figures({
      kind: 'mailbox',
      provider: 'somewhere.test',
      attempted: 0,
      proved: 0,
      suppressed: true,
      evidenced: true,
    })

    const synthesized = measuredOnlyRecipes([], [suppressed])

    expect(synthesized).toHaveLength(1)
    expect(suppressed.suppressed).toBe(true)
    expect(suppressed.attempted).toBe(0)
    /**
     * The row carries nothing of the count either — it is a `ProviderRecipe`,
     * and the figures ride beside it where the floor can go on governing them.
     */
    expect(Object.keys(synthesized[0] ?? {})).not.toContain('proved')
  })

  /**
   * The rejection case that survives: a pair nobody has attempted is not
   * evidence, and no floor is involved in saying so.
   *
   * **It used to be written with `suppressed: true`, and that was the shape that
   * hid `#977` for a week.** No such row exists: {@link atlasFigures} sets
   * `suppressed` only where `attempted > 0`, so *nothing measured* and
   * *suppressed* never occur together. Asserting on the impossible pair made the
   * test green while the real suppressed row — zeroed counts, `suppressed: true`
   * — fell through the same guard, and the function `#909` shipped could not
   * fire once.
   */
  it('still skips a pair with nothing measured at all', () => {
    const synthesized = measuredOnlyRecipes(
      [],
      [
        figures({
          kind: 'mailbox',
          provider: 'untouched.test',
          attempted: 0,
          proved: 0,
          suppressed: false,
        }),
      ],
    )

    expect(synthesized).toEqual([])
  })

  /**
   * **A declaration is not a walk** (`#977`). `kolonie.accounts.declare` records
   * an account a citizen says it holds, and nothing has read it — so a pair with
   * one declared account and no proof and no report puts a citizen in
   * `attempted` while nobody has demonstrably been anywhere. Standing a
   * `measured` entry on that would report an intention as an outcome, which is
   * `#906`'s rule for the backfill; `evidenced` is the same predicate, so the
   * shelf and the backfill agree.
   */
  it('stands nothing in for a provider a citizen only declared', () => {
    const synthesized = measuredOnlyRecipes(
      [],
      [
        figures({
          kind: 'mailbox',
          provider: 'declared-only.test',
          attempted: 1,
          proved: 0,
          evidenced: false,
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
    /**
     * **`measured`, and it said `unwritten` until `#903` put the status in the
     * rollup.** This assertion was written when a synthesised row *was*
     * `unwritten`, so it went on passing after the label changed and quietly
     * became the test that held the bug in place — `atlasEntryStatus` ranks the
     * public statuses in a list, and one missing from it takes the
     * *no rows at all* fallback and reports itself as the very thing it is not.
     */
    expect(entries[0]?.status).toBe('measured')
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

  /**
   * The provenance line goes from *somebody* to *this one, and here is how to
   * reach them* (`#960`). Naming the handle without the call that resolves it
   * would be the half of it a reader cannot act on.
   */
  it('names the walker and the call that resolves the handle', () => {
    const said = atlasSourcePhrase('walk-published', ['ada'])

    expect(said).toContain('`ada`')
    expect(said).toContain('kolonie.citizens.read ada')
  })

  it('names every walker where several put an entry on the shelf', () => {
    const said = atlasSourcePhrase('walk-published', ['ada', 'grace'])

    expect(said).toContain('`ada`, `grace`')
    expect(said).toContain('kolonie.citizens.read grace')
  })

  /**
   * **The old sentence is the fallback and not an error.** An entry whose
   * walkers have all opted out is still an entry a citizen walked, and saying
   * so unattributed is the true thing to say about it.
   */
  it('keeps the unattributed sentence when nobody is named', () => {
    expect(atlasSourcePhrase('walk-published', [])).toContain('citizen who walked it')
    expect(atlasSourcePhrase('walk-published', [])).not.toContain('kolonie.citizens.read')
  })

  /** The line belongs to walked entries. A measured stub has no walker to name. */
  it('says nothing about walkers on an entry nobody walked', () => {
    expect(atlasSourcePhrase('measured', ['ada'])).not.toContain('ada')
    expect(atlasSourcePhrase('curated', ['ada'])).toBe('')
  })

  /** Each of the three names what to do about it, which is the point of saying it at all. */
  it('names what to do about a withdrawn, stale or risky entry', () => {
    expect(atlasHealthPhrase('retired')).toContain('Do not walk it')
    expect(atlasHealthPhrase('stale')).toContain('provider-report')
    expect(atlasHealthPhrase('caution')).toContain('Take care')
  })
})

/**
 * The rollup covers every status a stranger can see (`#903`).
 *
 * **A regression test for a bug that produced no error.** `atlasEntryStatus`
 * ranks the public statuses in a list and falls back to `unwritten` for an entry
 * with no rows at all. A status missing from that list takes the fallback — so
 * when `measured` shipped without being added, all seventeen measured entries in
 * production reported themselves as `unwritten` on 2026-08-14, which is the one
 * thing a measured row exists to stop being confused with.
 *
 * Asserting the coverage rather than the ordering is deliberate: the order is a
 * judgement each addition has to make, and this cannot make it. What it can do
 * is refuse an addition that was never placed at all.
 */
describe('the entry status rollup', () => {
  it('places every public status, so none can fall through to the default', () => {
    for (const status of RecipeStatusSchema.options.filter(recipeStatusIsPublic)) {
      expect(atlasEntryStatus([{ status }])).toBe(status)
    }
  })

  it('answers unwritten for an entry with no rows, which is what the default is for', () => {
    expect(atlasEntryStatus([])).toBe('unwritten')
  })

  it('puts a measured row under a walk and above a listing', () => {
    expect(atlasEntryStatus([{ status: 'measured' }, { status: 'unwritten' }])).toBe('measured')
    expect(atlasEntryStatus([{ status: 'draft' }, { status: 'measured' }])).toBe('draft')
  })
})
