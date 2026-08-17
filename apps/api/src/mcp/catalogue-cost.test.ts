import { PERMISSION_AGGREGATE_FLOOR } from '@kolonie-ai/core'
import { describe, expect, it } from 'vitest'
import {
  breakEven,
  choiceEvidence,
  firstSentenceOf,
  isToolRouteKey,
  measureIndex,
  renderCostReport,
  sessionSpread,
  UNRECORDED_SIGNALS,
  type CostModel,
  type RouteTally,
} from './catalogue-cost.js'

/**
 * `#1119`. The arithmetic behind the report, asserted against constructed
 * inputs, because a fixture is the only way to know what the right answer is.
 *
 * The report itself is produced by `scripts/measure-catalogue-cost.mjs` against
 * a live catalogue and a real database — that half is not fixtured here, for the
 * reason `catalogue-size.test.ts` states about measuring anything other than
 * what is served.
 */

/**
 * Clears the citizen floor by default, so a test about the *call* floor or about
 * the arithmetic is not silently answered by the privacy one. The tests that are
 * about the citizen floor set `citizens` themselves.
 */
const tally = (routeKey: string, over: Partial<RouteTally> = {}): RouteTally => ({
  routeKey,
  calls: 100,
  ok: 100,
  clientErrors: 0,
  serverErrors: 0,
  citizens: PERMISSION_AGGREGATE_FLOOR + 3,
  ...over,
})

describe('telling the two observation points apart', () => {
  it('counts a tool name as a tool and a route template as not', () => {
    expect(isToolRouteKey('kolonie.me')).toBe(true)
    expect(isToolRouteKey('kolonie.accounts.list')).toBe(true)
    expect(isToolRouteKey('/v1/agents/:id')).toBe(false)
  })

  /**
   * `<unrouted>` is every request that matched no route and is 4xx by
   * construction. Folding it in would produce a catalogue error rate that is
   * mostly people mistyping URLs, which is the one mistake this rate has to not
   * make.
   */
  it('leaves the unrouted bucket out of the tool surface', () => {
    expect(isToolRouteKey('<unrouted>')).toBe(false)

    const evidence = choiceEvidence(
      [tally('kolonie.me'), tally('<unrouted>', { calls: 900, ok: 0, clientErrors: 900 })],
      [],
      10,
    )

    expect(evidence.calls).toBe(100)
    expect(evidence.clientErrorRate).toBe(0)
  })
})

describe('the rate question one is answered with', () => {
  it('divides refused calls by calls across every tool', () => {
    const evidence = choiceEvidence(
      [
        tally('kolonie.me', { calls: 300, ok: 297, clientErrors: 3 }),
        tally('kolonie.tasks.list', { calls: 100, ok: 98, clientErrors: 1, serverErrors: 1 }),
      ],
      [],
      10,
    )

    expect(evidence.toolsCalled).toBe(2)
    expect(evidence.calls).toBe(400)
    expect(evidence.clientErrorRate).toBe(4 / 400)
    expect(evidence.serverErrorRate).toBe(1 / 400)
  })

  /**
   * The floor is the whole point of the worst-tools table. Without it the table
   * is sorted by *least used*, since a tool called twice and refused once beats
   * every real rate in the Colony.
   */
  it('keeps a tool below the call floor out of the worst list', () => {
    const evidence = choiceEvidence(
      [
        tally('kolonie.rare', { calls: 2, ok: 1, clientErrors: 1 }),
        tally('kolonie.common', { calls: 500, ok: 450, clientErrors: 50 }),
      ],
      [],
      10,
    )

    expect(evidence.worstTools.map((tool) => tool.routeKey)).toEqual(['kolonie.common'])
    expect(evidence.worstTools[0]?.clientErrorRate).toBe(0.1)
  })

  it('reports a rate per runtime and never one number over all of them', () => {
    const evidence = choiceEvidence(
      [],
      [
        { platform: 'claude', citizens: 8, calls: 900, clientErrors: 9, serverErrors: 0 },
        { platform: 'openclaw', citizens: 6, calls: 100, clientErrors: 50, serverErrors: 0 },
      ],
      10,
    )

    expect(evidence.byRuntime.map((row) => row.platform)).toEqual(['claude', 'openclaw'])
    expect(evidence.byRuntime[0]?.clientErrorRate).toBe(0.01)
    expect(evidence.byRuntime[1]?.clientErrorRate).toBe(0.5)
  })

  it('answers null rather than zero when nothing was called', () => {
    const evidence = choiceEvidence([], [], 10)

    expect(evidence.clientErrorRate).toBeNull()
    expect(evidence.serverErrorRate).toBeNull()
  })
})

/**
 * A citizen's runtime is on its public page, so a runtime row of one is a
 * published fact about a citizen the reader can name — the shape `#147` forbids
 * and `#1119`'s definition of done rules out of this report specifically.
 */
describe('the citizen floor under a committed report', () => {
  it('withholds a runtime fewer than the floor stand behind', () => {
    const evidence = choiceEvidence(
      [],
      [
        {
          platform: 'claude',
          citizens: PERMISSION_AGGREGATE_FLOOR,
          calls: 900,
          clientErrors: 9,
          serverErrors: 0,
        },
        { platform: 'other', citizens: 1, calls: 579, clientErrors: 100, serverErrors: 0 },
      ],
      10,
    )

    expect(evidence.byRuntime.map((row) => row.platform)).toEqual(['claude'])
    expect(evidence.withheld.runtimes).toBe(1)
    expect(evidence.withheld.runtimeCalls).toBe(579)
  })

  it('withholds a tool fewer than the floor called', () => {
    const evidence = choiceEvidence(
      [
        tally('kolonie.narrow', { calls: 100, ok: 50, clientErrors: 50, citizens: 2 }),
        tally('kolonie.wide', {
          calls: 100,
          ok: 90,
          clientErrors: 10,
          citizens: PERMISSION_AGGREGATE_FLOOR,
        }),
      ],
      [],
      10,
    )

    expect(evidence.worstTools.map((tool) => tool.routeKey)).toEqual(['kolonie.wide'])
    expect(evidence.withheld.tools).toBe(1)
    expect(evidence.withheld.toolCalls).toBe(100)
  })

  /**
   * The headline may not move when a runtime gains its fifth citizen: that is a
   * change in who may be described, not in how often a call goes wrong.
   */
  it('leaves the totals over every tool rather than over what survives the floor', () => {
    const rows = [
      tally('kolonie.narrow', { calls: 100, ok: 50, clientErrors: 50, citizens: 1 }),
      tally('kolonie.wide', { calls: 100, ok: 90, clientErrors: 10, citizens: 9 }),
    ]

    const evidence = choiceEvidence(rows, [], 10)

    expect(evidence.toolsCalled).toBe(2)
    expect(evidence.calls).toBe(200)
    expect(evidence.clientErrorRate).toBe(60 / 200)
  })

  it('says an empty table was withheld rather than saying nothing was refused', () => {
    const evidence = choiceEvidence(
      [tally('kolonie.narrow', { calls: 100, ok: 50, clientErrors: 50, citizens: 1 })],
      [],
      10,
    )

    expect(evidence.worstTools).toEqual([])
    expect(evidence.withheld.tools).toBe(1)
  })
})

/**
 * The rejection case `#1119` requires, asserted so that a rewrite cannot quietly
 * drop it. It is the part of a measurement that reads like an omission — *we
 * could not tell* — and is therefore the part most likely to go.
 */
describe('what the records cannot answer', () => {
  it('names all three signals the issue asks about', () => {
    expect(UNRECORDED_SIGNALS).toHaveLength(3)
    expect(UNRECORDED_SIGNALS.map((signal) => signal.signal)).toEqual([
      'Calls to names that do not exist',
      'Calls rejected on their arguments',
      'Attempts abandoned after a failed call',
    ])
  })

  it('says of each what would have to be recorded', () => {
    for (const signal of UNRECORDED_SIGNALS) {
      expect(signal.because.length).toBeGreaterThan(40)
      expect(signal.wouldNeed.length).toBeGreaterThan(40)
    }
  })
})

describe('the index a tiered catalogue would keep in the prompt', () => {
  it('takes the first sentence and leaves the rest', () => {
    expect(firstSentenceOf('What it is. Then a paragraph about it.')).toBe('What it is.')
    expect(firstSentenceOf('  Leading space, then an end!  Second.')).toBe(
      'Leading space, then an end!',
    )
  })

  /** A description with no sentence end is the whole of what there is to summarise. */
  it('returns a description that never ends a sentence whole', () => {
    expect(firstSentenceOf('A label with no full stop')).toBe('A label with no full stop')
  })

  /**
   * A decimal point inside a sentence is not the end of it — the boundary is a
   * stop *followed by space or the end*, which is why `3.5` survives.
   */
  it('does not end a sentence inside a number', () => {
    expect(firstSentenceOf('Pays 0.5 SOL. And more besides.')).toBe('Pays 0.5 SOL.')
  })

  it('weighs the index against the catalogue it would replace', () => {
    const measurement = measureIndex([
      { name: 'kolonie.me', description: 'Who you are. A long second sentence about it.' },
      { name: 'kolonie.wakeup', description: 'What changed. Another long second sentence.' },
    ])

    expect(measurement.tools).toBe(2)
    expect(measurement.indexBytes).toBeLessThan(measurement.catalogueBytes)
    expect(measurement.indexShare).toBeCloseTo(
      measurement.indexBytes / measurement.catalogueBytes,
      10,
    )
    expect(measurement.definitionBytes).toBe(Math.round(measurement.catalogueBytes / 2))
  })

  it('reports zeros rather than dividing by an empty catalogue', () => {
    expect(measureIndex([]).definitionBytes).toBe(0)
    expect(measureIndex([]).indexShare).toBe(0)
  })
})

describe('where fetching definitions stops paying', () => {
  const model: CostModel = {
    catalogueTokens: 44_000,
    indexTokens: 2_000,
    definitionTokens: 450,
    cacheReadShare: 0.1,
    retainedShare: 0.5,
    requests: 100,
  }

  it('answers both transcript regimes and never one of them', () => {
    expect(breakEven(model).map((point) => point.transcript)).toEqual(['cached', 'uncached'])
  })

  /**
   * The limits are the arithmetic in the module's own comment: `ρ` cancels when
   * the tail is cache-read, and survives when it is not. Ten times apart, which
   * is what prompt caching is worth.
   */
  it('converges to the two limits the model derives', () => {
    const [cached, uncached] = breakEven(model)

    expect(cached?.asRequestsGrow).toBeCloseTo(42_000 / (450 * 0.5), 6)
    expect(uncached?.asRequestsGrow).toBeCloseTo((0.1 * 42_000) / (450 * 0.5), 6)
    expect(cached?.asRequestsGrow).toBeCloseTo((uncached?.asRequestsGrow ?? 0) * 10, 6)
  })

  /**
   * The limit is an upper bound and a short session is harsher, which is why the
   * report may not quote the limit alone.
   */
  it('breaks even sooner in a short session than in a long one', () => {
    for (const point of breakEven({ ...model, requests: 5 })) {
      const long = breakEven({ ...model, requests: 5_000 }).find(
        (other) => other.transcript === point.transcript,
      )
      expect(point.atRequests).toBeLessThan(long?.atRequests ?? 0)
      expect(point.atRequests).toBeLessThan(point.asRequestsGrow)
    }
  })

  /** A catalogue no bigger than its own index saves nothing, at any length of session. */
  it('breaks even at nothing when the index is the catalogue', () => {
    for (const point of breakEven({ ...model, indexTokens: model.catalogueTokens })) {
      expect(point.atRequests).toBe(0)
      expect(point.asRequestsGrow).toBe(0)
    }
  })
})

describe('where real sessions sit against it', () => {
  const buckets = [
    { tools: 1, sessions: 40 },
    { tools: 4, sessions: 30 },
    { tools: 12, sessions: 20 },
    { tools: 40, sessions: 10 },
  ]

  it('counts sessions rather than buckets at a quantile', () => {
    const spread = sessionSpread(buckets, [])

    expect(spread.sessions).toBe(100)
    expect(spread.median).toBe(4)
    expect(spread.p90).toBe(12)
    expect(spread.max).toBe(40)
  })

  it('counts a threshold at or below it', () => {
    expect(sessionSpread(buckets, [12, 18]).below).toEqual([
      { tools: 12, sessions: 90 },
      { tools: 18, sessions: 90 },
    ])
  })

  it('answers zeros rather than dividing by an empty window', () => {
    const spread = sessionSpread([], [18])

    expect(spread.sessions).toBe(0)
    expect(spread.median).toBe(0)
    expect(spread.below).toEqual([{ tools: 18, sessions: 0 }])
  })
})

describe('the report', () => {
  const render = (over: { readonly sessions?: readonly { tools: number; sessions: number }[] }) =>
    renderCostReport({
      measuredAt: '2026-08-17',
      command: 'node scripts/measure-catalogue-cost.mjs',
      source: 'example.invalid',
      window: { days: 7, since: '2026-08-10' },
      index: measureIndex([{ name: 'kolonie.me', description: 'Who you are. And more.' }]),
      model: {
        catalogueTokens: 44_000,
        indexTokens: 2_000,
        definitionTokens: 450,
        cacheReadShare: 0.1,
        retainedShare: 0.5,
        requests: 100,
      },
      breakEvens: breakEven({
        catalogueTokens: 44_000,
        indexTokens: 2_000,
        definitionTokens: 450,
        cacheReadShare: 0.1,
        retainedShare: 0.5,
        requests: 100,
      }),
      evidence: choiceEvidence(
        [tally('kolonie.me', { calls: 1_000, ok: 990, clientErrors: 10 })],
        [{ platform: 'claude', citizens: 7, calls: 1_000, clientErrors: 10, serverErrors: 0 }],
        10,
      ),
      spread: sessionSpread(over.sessions ?? [{ tools: 4, sessions: 90 }], [18]),
      requestsPerSession: { median: 40, p90: 200 },
      minimumCalls: 10,
    })

  it('carries the date and the command that produced it', () => {
    const report = render({})

    expect(report).toContain('2026-08-17')
    expect(report).toContain('node scripts/measure-catalogue-cost.mjs')
  })

  it('states plainly which outcome each question supports', () => {
    const report = render({})

    expect(report).toContain('Which outcome this supports')
    expect(report).toContain('no evidence of harm')
    expect(report).toMatch(/% of sessions sit at or below/u)
  })

  /** The absences travel into the document; they are not a comment in the source. */
  it('names every unrecorded signal in the document itself', () => {
    const report = render({})

    for (const signal of UNRECORDED_SIGNALS) expect(report).toContain(signal.signal)
  })

  it('says nothing was read rather than printing an empty share', () => {
    expect(render({ sessions: [] })).toContain('no session distribution was read')
  })
})
