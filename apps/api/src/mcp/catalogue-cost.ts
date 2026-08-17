/**
 * What the catalogue's size actually costs a citizen (`#1119`).
 *
 * ## Why this exists beside `catalogue-size.ts`
 *
 * That module weighs the catalogue and asks *is a namespace worth what it
 * charges*. It answers in bytes, and bytes are what a redesign has been argued
 * from for weeks. This module answers the two questions that were never asked:
 * **does the size hurt tool choice**, and **at how many unfamiliar tools per
 * session does fetching definitions stop paying**.
 *
 * Both are arithmetic over records the Colony already holds — `agent_call_hours`
 * (`#835`) and `agent_sessions` — and neither produces a verdict on what to
 * build. `#1119` is explicit that it "answers two questions and proposes
 * nothing", so nothing here returns an `ok`, a threshold or a recommendation.
 *
 * ## Why the break-even is a calculation and not an experiment
 *
 * The counter-argument `#1119` names cannot be run: there is no second Colony
 * serving a tiered catalogue to compare against, and building one to find out
 * whether it is worth building is the decision this report exists to inform.
 * What *is* measurable is every quantity the arithmetic needs — the catalogue's
 * size, an index's size, a definition's size, how many requests a session makes
 * and how many distinct tools it touches. So the model is stated, its inputs are
 * measured rather than assumed, and the sensitivity that matters is reported as
 * a range instead of hidden inside one number.
 *
 * ## The one thing this module refuses to do
 *
 * **Answer question one approximately.** `#1119`'s rejection case is that "if the
 * records cannot answer a question, the report says so and names what would have
 * to be recorded". Two of the three signals it names are not recorded anywhere,
 * and `unrecordedSignals` below is that finding as data rather than as a
 * paragraph somebody could delete without noticing what went with it.
 *
 * ## Why a committed report is held to `PERMISSION_AGGREGATE_FLOOR`
 *
 * The aggregates here name no citizen, and on the runtime table that is not
 * enough. **A citizen's platform is on its public page**, so *"`hermes`: one
 * citizen, 747 calls, 3.08 % refused"* is a published fact about whichever
 * citizen that is — the shape `#147` forbids, stated in a file that is committed
 * and quoted rather than served once. `#1119`'s own definition of done says "no
 * citizen identifiable in it", so both tables suppress a row below the floor and
 * `withheld` says what went.
 *
 * The floor is imported and not redefined at 5. `#909` is the precedent for
 * splitting one when the subject differs, and here the subject is the same one
 * `PERMISSION_AGGREGATE_FLOOR` already protects: a citizen, not a provider.
 */

import { PERMISSION_AGGREGATE_FLOOR } from '@kolonie-ai/core'
import type { PublishedTool } from './catalogue-size.js'

/**
 * The prefix every MCP tool name carries, which is also its route key.
 *
 * `apps/api/src/mcp/create-server.ts` keys the rollup on the tool's own name, so
 * a row in `agent_call_hours` whose key starts with this came through the MCP
 * door and everything else came through an HTTP route or matched none
 * (`UNROUTED_ROUTE_KEY`). The two surfaces have to be told apart before any rate
 * here means anything: a 404 on a mistyped URL is not evidence about the tool
 * catalogue.
 *
 * It lives here rather than in `@kolonie-ai/core` because nothing in the domain
 * model branches on it — it is a fact about how one observation point names its
 * rows, and the one query that needs it in SQL is handed it as an argument.
 */
export const TOOL_ROUTE_PREFIX = 'kolonie.'

/** Whether a route key names an MCP tool rather than an HTTP route. */
export function isToolRouteKey(routeKey: string): boolean {
  return routeKey.startsWith(TOOL_ROUTE_PREFIX)
}

/** One route key's calls over the window. Structurally what `@kolonie-ai/db` returns. */
export interface RouteTally {
  readonly routeKey: string
  readonly calls: number
  readonly ok: number
  readonly clientErrors: number
  readonly serverErrors: number
  /** How many citizens called it. A rate over one citizen is that citizen, not the surface. */
  readonly citizens: number
}

/** How one runtime fared. Structurally what `@kolonie-ai/db` returns. */
export interface RuntimeTally {
  readonly platform: string
  readonly citizens: number
  readonly calls: number
  readonly clientErrors: number
  readonly serverErrors: number
}

/**
 * The rate question one is answered with, over one population.
 *
 * **A rate per call and not a narrative**, which is the acceptance criterion
 * verbatim. It is comparable against a later run because every term in it is a
 * column: nothing here is judged, sampled or weighted.
 */
export interface ChoiceEvidence {
  /** Distinct tools called at least once in the window. */
  readonly toolsCalled: number
  readonly calls: number
  readonly clientErrors: number
  readonly serverErrors: number
  /** `clientErrors / calls`, or `null` when nothing was called. */
  readonly clientErrorRate: number | null
  /** `serverErrors / calls`, or `null` when nothing was called. */
  readonly serverErrorRate: number | null
  /**
   * Tools whose own client-error rate is worth looking at, worst first.
   *
   * **Floored at `minimumCalls`**, because a tool called twice and refused once
   * is a 50 % rate and no evidence at all — and a table sorted by rate with no
   * floor is a table of the least-used tools in the Colony.
   */
  readonly worstTools: readonly (RouteTally & { readonly clientErrorRate: number })[]
  /** Every runtime that called anything, so a rate that belongs to one is not read as the surface's. */
  readonly byRuntime: readonly (RuntimeTally & { readonly clientErrorRate: number | null })[]
  /**
   * What the citizen floor took out of the two tables above.
   *
   * **Reported rather than dropped.** A row that vanishes silently makes the
   * table read as the whole of what happened, and the totals above already say
   * it is not — a reader who can see 4,973 calls and add up 4,100 in the table
   * deserves the reason for the gap rather than an arithmetic puzzle.
   */
  readonly withheld: {
    readonly runtimes: number
    readonly runtimeCalls: number
    readonly tools: number
    readonly toolCalls: number
  }
}

/**
 * What question one asks of the call records.
 *
 * **HTTP rows are dropped and said so rather than folded in.** `<unrouted>` is
 * every request that matched no route — 4xx by construction, and the largest
 * single source of client errors in the table. Counting it would produce a
 * catalogue error rate that is mostly people mistyping URLs.
 *
 * **The totals are over every tool; only the two tables are floored.** A
 * headline computed from what survives the floor would move whenever a runtime
 * gained a fifth citizen, which is a change in who may be described and not a
 * change in how often citizens get a call wrong.
 */
export function choiceEvidence(
  routes: readonly RouteTally[],
  runtimes: readonly RuntimeTally[],
  minimumCalls: number,
  citizenFloor: number = PERMISSION_AGGREGATE_FLOOR,
): ChoiceEvidence {
  const tools = routes.filter((row) => isToolRouteKey(row.routeKey))

  const calls = tools.reduce((sum, row) => sum + row.calls, 0)
  const clientErrors = tools.reduce((sum, row) => sum + row.clientErrors, 0)
  const serverErrors = tools.reduce((sum, row) => sum + row.serverErrors, 0)

  const namedTools = tools.filter((row) => row.calls >= minimumCalls && row.clientErrors > 0)
  const worstTools = namedTools
    .filter((row) => row.citizens >= citizenFloor)
    .map((row) => ({ ...row, clientErrorRate: row.clientErrors / row.calls }))
    .sort((a, b) => b.clientErrorRate - a.clientErrorRate || b.calls - a.calls)

  const namedRuntimes = runtimes.filter((row) => row.citizens >= citizenFloor)

  return {
    toolsCalled: tools.length,
    calls,
    clientErrors,
    serverErrors,
    clientErrorRate: calls === 0 ? null : clientErrors / calls,
    serverErrorRate: calls === 0 ? null : serverErrors / calls,
    worstTools,
    byRuntime: namedRuntimes
      .map((row) => ({
        ...row,
        clientErrorRate: row.calls === 0 ? null : row.clientErrors / row.calls,
      }))
      .sort((a, b) => b.calls - a.calls || a.platform.localeCompare(b.platform)),
    withheld: {
      runtimes: runtimes.length - namedRuntimes.length,
      runtimeCalls: runtimes
        .filter((row) => row.citizens < citizenFloor)
        .reduce((sum, row) => sum + row.calls, 0),
      tools: namedTools.length - worstTools.length,
      toolCalls: namedTools
        .filter((row) => row.citizens < citizenFloor)
        .reduce((sum, row) => sum + row.calls, 0),
    },
  }
}

/** A signal question one asks for that nothing in the Colony records. */
export interface UnrecordedSignal {
  /** The signal, in the words `#1119` asks for it. */
  readonly signal: string
  /** Why the records cannot produce it — a place in the code, not an opinion. */
  readonly because: string
  /** What would have to be recorded for a later run to answer it. */
  readonly wouldNeed: string
}

/**
 * The three signals `#1119` names, and which of them exist.
 *
 * **Written down rather than described.** The rejection case is the part of a
 * measurement most likely to be dropped in a rewrite — it is the part that says
 * *we could not tell*, and it reads like an omission rather than a finding. As
 * data it renders itself into the report and a test can assert it is still
 * there.
 *
 * The two absences are not oversights in the rollup: `guardTools` wraps a tool's
 * *callback*, and the MCP SDK rejects an unknown name and an argument-schema
 * failure before any callback runs. So the rollup is not merely silent about
 * them, it is structurally incapable of seeing them, and the fix named below is
 * a second observation point rather than a column.
 */
export const UNRECORDED_SIGNALS: readonly UnrecordedSignal[] = [
  {
    signal: 'Calls to names that do not exist',
    because:
      'The SDK answers `Tool <name> not found` from its own dispatch, before the ' +
      'registered callback runs. `guardTools` wraps that callback and the rollup is ' +
      'wired into `guardTools`, so no row is written and no counter moves.',
    wouldNeed:
      'A handler at the MCP door itself, counting a rejected `tools/call` by the name ' +
      'that was asked for — bounded to names the catalogue has ever served, so a ' +
      'mistyped name cannot become a route key of its own.',
  },
  {
    signal: 'Calls rejected on their arguments',
    because:
      'The SDK validates against the published input schema and answers ' +
      '`Input validation error` before the callback runs. Same seam, same silence. ' +
      '`publishLeanSchemas` prunes what is published and states that validation on the ' +
      'way in is unchanged, so this is not a consequence of the lean schemas either.',
    wouldNeed:
      'The same handler, counting a schema rejection against the tool name that was ' +
      'called. Which property failed would say far more, and is the thing to weigh ' +
      'against writing a citizen’s arguments into a table that today holds none.',
  },
  {
    signal: 'Attempts abandoned after a failed call',
    because:
      '`agent_call_hours` is a rollup: one row per citizen, route and hour, with no ' +
      'attempt id and no per-call timestamp beyond the first and the last in the hour. ' +
      'An attempt and a call cannot be put in order inside an hour, so "after" is not a ' +
      'question the table can be asked.',
    wouldNeed:
      'Nothing new stored, if the question is narrowed: the attempt records already ' +
      'carry an abandonment rate per rung (`attemptTallies`), and a rung whose citizens ' +
      'abandon far more often than the rest is the evidence `#1088` was. Linking an ' +
      'individual abandonment to an individual failed call needs a request log, which ' +
      '`#835` decided against on purpose.',
  },
]

/**
 * What one tiered index entry would carry: the name and the first sentence.
 *
 * The lookup tool the redesign proposes has to leave enough in the prefix for a
 * citizen to know a tool exists and roughly what it is for. A name alone does
 * not do that for `kolonie.accounts.thread`; the first sentence does, and it is
 * the one boundary in the existing prose that is already written to stand alone.
 */
export function firstSentenceOf(description: string): string {
  const trimmed = description.trim()
  const end = trimmed.search(/[.?!](\s|$)/u)
  return end === -1 ? trimmed : trimmed.slice(0, end + 1)
}

/** An index built from the catalogue, weighed against it. */
export interface IndexMeasurement {
  readonly tools: number
  /** Bytes of the whole catalogue as `tools/list` publishes it. */
  readonly catalogueBytes: number
  /** Bytes of the index that would replace it in the prefix. */
  readonly indexBytes: number
  /** `catalogueBytes / tools`, rounded: what one fetched definition costs. */
  readonly definitionBytes: number
  /** `indexBytes / catalogueBytes`, between 0 and 1. */
  readonly indexShare: number
}

/**
 * Weigh the index a tiered catalogue would keep in the prompt.
 *
 * Serialised the way the catalogue is, so the two numbers are comparable: a
 * measurement that weighed the index as bare text and the catalogue as JSON
 * would flatter the index by every quotation mark.
 *
 * **`definitionBytes` is the whole entry and not the part the index left out.**
 * A lookup returns the tool as `tools/list` would have published it — the
 * summary the citizen already read does not come off the wire cheaper for having
 * been read.
 */
export function measureIndex(tools: readonly PublishedTool[]): IndexMeasurement {
  const index = tools.map((tool) => ({
    name: tool.name,
    summary: tool.description === undefined ? '' : firstSentenceOf(tool.description),
  }))

  const catalogueBytes = Buffer.byteLength(JSON.stringify(tools), 'utf8')
  const indexBytes = Buffer.byteLength(JSON.stringify(index), 'utf8')

  return {
    tools: tools.length,
    catalogueBytes,
    indexBytes,
    definitionBytes: tools.length === 0 ? 0 : Math.round(catalogueBytes / tools.length),
    /**
     * Guarded on the tool count and not on the byte count. An empty catalogue
     * still serialises to `[]`, so a division would happily answer *the index is
     * 100 % of the catalogue* about a catalogue that does not exist.
     */
    indexShare: tools.length === 0 ? 0 : indexBytes / catalogueBytes,
  }
}

/**
 * Everything the break-even arithmetic needs. Every field is measured.
 *
 * The two shares are the only judgements, and both are named rather than folded
 * into a constant, because the answer moves by an order of magnitude across
 * them and a reader has to be able to disagree with one number instead of with
 * the result.
 */
export interface CostModel {
  /** Tokens of catalogue sitting in the cached prefix. */
  readonly catalogueTokens: number
  /** Tokens of index that would sit there instead. */
  readonly indexTokens: number
  /** Tokens one fetched definition costs. */
  readonly definitionTokens: number
  /**
   * What a cache-read token costs relative to a fresh one — 0.1 on Anthropic's
   * published pricing. This is the whole reason the catalogue is cheap where it
   * sits, and it is what the redesign gives up.
   */
  readonly cacheReadShare: number
  /**
   * The share of a session's requests over which a fetched definition is already
   * in the transcript. A definition fetched at the midpoint is present for half
   * of them, so 0.5 is the neutral assumption and the report says so.
   */
  readonly retainedShare: number
  /** Requests in a session. Measured, not assumed — see `requestsPerSession`. */
  readonly requests: number
}

/** Where fetching stops paying, under one assumption about the transcript. */
export interface BreakEven {
  /**
   * Which regime this is: whether the tokens a fetched definition leaves behind
   * are themselves cache-read on later requests, or paid fresh every time.
   */
  readonly transcript: 'cached' | 'uncached'
  /** Cold tools per session at the measured request count. */
  readonly atRequests: number
  /** What it converges to as a session grows long. The kinder of the two. */
  readonly asRequestsGrow: number
}

/**
 * The break-even count, both ways round.
 *
 * ## The model, written out
 *
 * A session makes `R` requests, and every request re-sends the prefix.
 *
 * - **As it stands.** The catalogue is in the prefix and prompt caching serves
 *   it, so it costs `C · ρ` per request: `C · ρ · R` over the session.
 * - **Tiered.** The index is in the prefix instead: `I · ρ · R`. Each of `N`
 *   cold tools is then fetched at runtime, costing `d` tokens at full price
 *   once — and staying in the transcript, where it is re-read on the `φ` share
 *   of requests that come after it.
 *
 * Whether that tail is cheap is the question the redesign never asked, and it is
 * exactly where the answer forks:
 *
 * - **`cached`** — the client keeps a cache breakpoint at the end of the
 *   conversation, so the tail is re-read at `ρ` like everything else. Tiered
 *   costs `I·ρR + N·d·(1 + ρφR)`, and `ρ` cancels in the limit:
 *   `N* → (C − I) / (d · φ)`.
 * - **`uncached`** — the tail is paid fresh on every request, which is the case
 *   `#1119` describes when it says a fetched definition "stays in the transcript
 *   for the rest of the session". Tiered costs `I·ρR + N·d·(1 + φR)` and
 *   `N* → ρ(C − I) / (d · φ)` — smaller by a factor of `ρ`, which is to say ten
 *   times harsher on the redesign.
 *
 * **Both are reported and neither is chosen here.** Which one a citizen is in is
 * a fact about its client, not about the Colony, and a report that picked one
 * would be answering a question about somebody else's software.
 *
 * `asRequestsGrow` is the limit, and it is the *upper* bound: a short session
 * has less prefix to save and breaks even sooner. So a session below the limit
 * is not automatically a win, and a session above it never is.
 */
export function breakEven(model: CostModel): readonly BreakEven[] {
  const {
    catalogueTokens,
    indexTokens,
    definitionTokens,
    cacheReadShare,
    retainedShare,
    requests,
  } = model

  const saved = cacheReadShare * requests * (catalogueTokens - indexTokens)

  const at = (tailPrice: number): BreakEven => ({
    transcript: tailPrice === cacheReadShare ? 'cached' : 'uncached',
    atRequests: saved / (definitionTokens * (1 + tailPrice * retainedShare * requests)),
    asRequestsGrow:
      (cacheReadShare * (catalogueTokens - indexTokens)) /
      (definitionTokens * tailPrice * retainedShare),
  })

  return [at(cacheReadShare), at(1)]
}

/** How many distinct tools a session touched, and how many sessions did. */
export interface ToolSpreadBucket {
  readonly tools: number
  readonly sessions: number
}

/** A distribution reduced to what the acceptance criterion asks of it. */
export interface SessionSpread {
  readonly sessions: number
  readonly median: number
  readonly p90: number
  readonly max: number
  /** Sessions at or below a count, for each break-even this run produced. */
  readonly below: readonly { readonly tools: number; readonly sessions: number }[]
}

/** The count at a quantile of the distribution, counting sessions rather than buckets. */
const quantile = (buckets: readonly ToolSpreadBucket[], share: number): number => {
  const total = buckets.reduce((sum, bucket) => sum + bucket.sessions, 0)
  if (total === 0) return 0

  let seen = 0
  for (const bucket of [...buckets].sort((a, b) => a.tools - b.tools)) {
    seen += bucket.sessions
    if (seen >= total * share) return bucket.tools
  }
  return buckets.reduce((most, bucket) => Math.max(most, bucket.tools), 0)
}

/**
 * Where real sessions sit against the break-even counts.
 *
 * **`thresholds` are counted at or below**, because the break-even is the point
 * where the two are equal and equality is not a win. Rounding is the caller's:
 * a threshold of 18.7 asked about as 18 is a deliberately conservative reading
 * and the report says which number it used.
 */
export function sessionSpread(
  buckets: readonly ToolSpreadBucket[],
  thresholds: readonly number[],
): SessionSpread {
  const sessions = buckets.reduce((sum, bucket) => sum + bucket.sessions, 0)

  return {
    sessions,
    median: quantile(buckets, 0.5),
    p90: quantile(buckets, 0.9),
    max: buckets.reduce((most, bucket) => Math.max(most, bucket.tools), 0),
    below: thresholds.map((tools) => ({
      tools,
      sessions: buckets
        .filter((bucket) => bucket.tools <= tools)
        .reduce((sum, bucket) => sum + bucket.sessions, 0),
    })),
  }
}

const count = (value: number): string => value.toLocaleString('en-US')

const percent = (rate: number | null): string =>
  rate === null ? '—' : `${(rate * 100).toFixed(2)} %`

/**
 * Render both answers as one Markdown document.
 *
 * `measuredAt` and `command` are required arguments for the reason
 * `renderCatalogueReport` gives: `AGENTS.md` §7 requires a measurement to carry
 * its date and its method, and a default would let a report be written carrying
 * neither.
 */
export function renderCostReport(options: {
  readonly measuredAt: string
  readonly command: string
  readonly source: string
  readonly window: { readonly days: number; readonly since: string }
  readonly index: IndexMeasurement
  readonly model: CostModel
  readonly breakEvens: readonly BreakEven[]
  readonly evidence: ChoiceEvidence
  readonly spread: SessionSpread
  readonly requestsPerSession: { readonly median: number; readonly p90: number }
  readonly minimumCalls: number
}): string {
  const { evidence, index, model, spread } = options
  const lines: string[] = []

  lines.push('### What the tool catalogue costs a citizen', '')
  lines.push(
    `Measured **${options.measuredAt}** against \`${options.source}\`, over the ` +
      `${options.window.days} days from \`${options.window.since}\`:`,
    '',
  )
  lines.push('```', options.command, '```', '')
  lines.push(
    '**This answers two questions and proposes nothing** (`#1119`). There is no ' +
      'threshold here and no recommendation: whether the catalogue is redesigned is a ' +
      'separate decision that these figures inform.',
    '',
  )

  lines.push('#### Question one: does the size hurt tool choice?', '')
  lines.push(
    `**${percent(evidence.clientErrorRate)} of MCP tool calls were refused on the ` +
      `citizen's side** — ${count(evidence.clientErrors)} of ${count(evidence.calls)} calls ` +
      `across ${count(evidence.toolsCalled)} distinct tools. Server errors, which are the ` +
      `Colony's own faults and not evidence about tool choice, were ` +
      `${percent(evidence.serverErrorRate)}.`,
    '',
  )
  lines.push(
    'That is the rate to compare a later run against. It counts only route keys the MCP ' +
      'door wrote; HTTP routes and `<unrouted>` are excluded, because a 404 on a mistyped ' +
      'URL is not evidence about a tool catalogue.',
    '',
  )

  if (evidence.byRuntime.length > 0) {
    lines.push('| Runtime | Citizens | Calls | Refused | Rate |')
    lines.push('|---|---:|---:|---:|---:|')
    for (const runtime of evidence.byRuntime) {
      lines.push(
        `| \`${runtime.platform}\` | ${count(runtime.citizens)} | ${count(runtime.calls)} | ` +
          `${count(runtime.clientErrors)} | ${percent(runtime.clientErrorRate)} |`,
      )
    }
    lines.push('')
  }

  if (evidence.withheld.runtimes > 0 || evidence.withheld.tools > 0) {
    const withheld = [
      evidence.withheld.runtimes > 0
        ? `${count(evidence.withheld.runtimes)} runtime${evidence.withheld.runtimes === 1 ? '' : 's'} ` +
          `(${count(evidence.withheld.runtimeCalls)} calls)`
        : undefined,
      evidence.withheld.tools > 0
        ? `${count(evidence.withheld.tools)} tool${evidence.withheld.tools === 1 ? '' : 's'} ` +
          `(${count(evidence.withheld.toolCalls)} calls)`
        : undefined,
    ].filter((part) => part !== undefined)

    lines.push(
      `**Withheld from the tables above: ${withheld.join(' and ')}**, for having fewer than ` +
        `${count(PERMISSION_AGGREGATE_FLOOR)} citizens behind them. A citizen's runtime is on ` +
        'its public page, so a row of one is a published fact about a citizen the reader can ' +
        'name. The totals above are over every tool and are not floored — a headline that ' +
        'moved when a runtime gained its fifth citizen would be measuring who may be described ' +
        'rather than how often a call goes wrong.',
      '',
    )
  }

  if (evidence.worstTools.length === 0) {
    /**
     * Two ways to reach an empty table, and they are opposite findings. Saying
     * *nothing refused a call* when the rows were withheld for having one
     * citizen behind them would turn a privacy floor into a clean bill of
     * health.
     */
    lines.push(
      evidence.withheld.tools > 0
        ? `**No tool clears both floors.** Every tool called at least ` +
            `${count(options.minimumCalls)} times that refused anything had fewer than ` +
            `${count(PERMISSION_AGGREGATE_FLOOR)} citizens behind it, so this table is empty ` +
            'because of who it would describe and not because nothing was refused.'
        : `**No tool called at least ${count(options.minimumCalls)} times refused a single ` +
            'call.** That is an absence rather than a zero: it is what the table holds.',
      '',
    )
  } else {
    lines.push(
      `Tools called at least ${count(options.minimumCalls)} times by at least ` +
        `${count(PERMISSION_AGGREGATE_FLOOR)} citizens that refused anything, worst first. Two ` +
        'floors: a tool called twice and refused once is a 50 % rate and no evidence at all, ' +
        'and a rate over fewer citizens than that describes them rather than the surface:',
      '',
    )
    lines.push('| Tool | Calls | Refused | Rate | Citizens |')
    lines.push('|---|---:|---:|---:|---:|')
    for (const tool of evidence.worstTools.slice(0, 15)) {
      lines.push(
        `| \`${tool.routeKey}\` | ${count(tool.calls)} | ${count(tool.clientErrors)} | ` +
          `${percent(tool.clientErrorRate)} | ${count(tool.citizens)} |`,
      )
    }
    lines.push('')
  }

  lines.push('##### What the records cannot answer, and what would have to be recorded', '')
  lines.push(
    '`#1119` names three signals. **Two of them are not recorded anywhere in the Colony**, ' +
      'and this is that finding rather than an approximation of them:',
    '',
  )
  for (const signal of UNRECORDED_SIGNALS) {
    lines.push(`- **${signal.signal}.** ${signal.because}`, `  *Would need:* ${signal.wouldNeed}`)
  }
  lines.push('')

  lines.push('#### Question two: at how many cold tools per session does fetching stop paying?', '')
  lines.push(
    `The catalogue is **${count(index.catalogueBytes)} bytes across ${count(index.tools)} ` +
      `tools** — ${count(model.catalogueTokens)} tokens at the rate this run used. An index ` +
      `of name plus first sentence is **${count(index.indexBytes)} bytes** ` +
      `(${(index.indexShare * 100).toFixed(1)} % of the catalogue, ` +
      `${count(model.indexTokens)} tokens), and one fetched definition costs ` +
      `${count(model.definitionTokens)} tokens.`,
    '',
  )
  lines.push(
    `A session makes **${count(options.requestsPerSession.median)} calls at the median** ` +
      `and ${count(options.requestsPerSession.p90)} at the 90th percentile; the model below ` +
      `uses ${count(model.requests)}. A cache-read token is priced at ` +
      `${model.cacheReadShare}, and a fetched definition is taken to sit in the transcript ` +
      `for ${model.retainedShare} of the requests that follow it.`,
    '',
  )
  lines.push('| Transcript | Break-even at the measured session | As a session grows long |')
  lines.push('|---|---:|---:|')
  for (const point of options.breakEvens) {
    lines.push(
      `| ${point.transcript} | ${point.atRequests.toFixed(1)} cold tools | ` +
        `${point.asRequestsGrow.toFixed(1)} cold tools |`,
    )
  }
  lines.push('')
  lines.push(
    '**`cached`** is a client that keeps a cache breakpoint at the end of the conversation, ' +
      'so what a fetch leaves behind is re-read at cache price like everything else. ' +
      '**`uncached`** is the case `#1119` describes — the definition "stays in the transcript ' +
      'for the rest of the session" at full price — and it is ten times harsher on the ' +
      'redesign, because that is exactly the factor prompt caching is worth. Which one a ' +
      'citizen is in is a fact about its client and not about the Colony.',
    '',
  )

  lines.push('##### How many real sessions fall on each side', '')
  lines.push(
    `Across ${count(spread.sessions)} sessions in the window: **median ` +
      `${count(spread.median)} distinct tools**, ${count(spread.p90)} at the 90th ` +
      `percentile, ${count(spread.max)} at the most.`,
    '',
  )
  lines.push('| At or below | Sessions | Share |')
  lines.push('|---:|---:|---:|')
  for (const point of spread.below) {
    lines.push(
      `| ${count(point.tools)} tools | ${count(point.sessions)} | ` +
        `${spread.sessions === 0 ? '—' : `${((point.sessions / spread.sessions) * 100).toFixed(1)} %`} |`,
    )
  }
  lines.push('')
  lines.push(
    "**This over-counts on both sides of the same word.** A session's tools are counted by " +
      'joining its window against the hour buckets of the citizen that ran it, so two ' +
      "sessions of one citizen inside one hour each take credit for the other's tools. And " +
      'a *cold* tool is one whose definition is not already in the prefix — with a warm set ' +
      'kept there, cold tools are fewer than distinct tools by however many the warm set ' +
      'covers. Both errors push the same way: the real counts are lower than these, so a ' +
      'conclusion that sessions sit below the break-even is not weakened by either.',
    '',
  )

  lines.push('#### Which outcome this supports', '')
  lines.push(...supportedOutcome(options))

  return lines.join('\n')
}

/**
 * The paragraph `#1119` requires: *which of the two outcomes does this support*.
 *
 * **Composed from the figures rather than written beside them**, so that a later
 * run against different numbers cannot keep a conclusion that no longer follows
 * from them. The rule it applies is stated in the output itself: a size that is
 * costing citizens something would show up as citizens getting tool calls wrong,
 * and a redesign that pays would show up as sessions sitting below the break-even
 * count. Each half is answered separately, because they can disagree — and if
 * they do, that is the finding.
 */
function supportedOutcome(options: {
  readonly evidence: ChoiceEvidence
  readonly breakEvens: readonly BreakEven[]
  readonly spread: SessionSpread
}): string[] {
  const { evidence, spread } = options
  const rate = evidence.clientErrorRate
  const lines: string[] = []

  const harshest = options.breakEvens.reduce(
    (lowest, point) => Math.min(lowest, point.asRequestsGrow),
    Number.POSITIVE_INFINITY,
  )
  const under = spread.below.reduce<{ tools: number; sessions: number } | undefined>(
    (best, point) =>
      point.tools <= harshest && (best === undefined || point.tools > best.tools) ? point : best,
    undefined,
  )
  const share =
    under === undefined || spread.sessions === 0 ? null : under.sessions / spread.sessions

  lines.push(
    '**On question one: the records do not show the catalogue costing citizens their tool ' +
      `choice.** The rate is ${percent(rate)}, and the two signals that would show a citizen ` +
      'reaching for the wrong tool — a name that does not exist, arguments that do not fit — ' +
      'are the two that are not recorded. So this is *no evidence of harm* and not *evidence ' +
      'of no harm*, and the difference is the whole reason the previous paragraph names what ' +
      'would have to be recorded.',
    '',
  )

  if (share === null) {
    lines.push(
      '**On question two: no session distribution was read**, so the break-even stands ' +
        'without anything to compare it against.',
    )
  } else {
    lines.push(
      `**On question two: ${(share * 100).toFixed(1)} % of sessions sit at or below ` +
        `${count(under?.tools ?? 0)} distinct tools**, which is the harshest break-even this ` +
        'run produced — the uncached-transcript limit, the assumption least favourable to ' +
        'fetching definitions. Under the kinder one the share is higher still. The ' +
        'counter-argument that tiering could cost more than it saves is therefore real ' +
        'arithmetic but not the ordinary case: it needs a session touching several times as ' +
        'many distinct tools as any session in this window did.',
      '',
    )
    lines.push(
      '**The two do not point the same way, and that is the result.** Tiering would save ' +
        'tokens for essentially every session measured — and nothing measured here says those ' +
        'tokens were costing anybody an outcome. A redesign argued from this report is argued ' +
        'from token cost alone, which is a smaller claim than the one it has been carrying.',
    )
  }

  return lines
}
