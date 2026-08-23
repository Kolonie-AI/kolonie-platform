/**
 * What a citizen pays to be told what it *could* call (`#388`).
 *
 * ## Why this is measured at all
 *
 * A client fetches `tools/list` once, at connect, and holds the answer in its
 * system prompt for the whole session. So the size of that answer is not a
 * network cost paid once — it is context-window rent, charged to every citizen
 * in every run, whether or not it calls a single one of the tools described.
 *
 * The surface grew from **53 tools on 2026-08-02** (`#211`) to **96 tools and
 * 171,583 bytes on 2026-08-05**, and nothing reported it. It was not that
 * anybody weighed 81 % in three days and decided it was acceptable: nobody was
 * looking, because there was no number to look at.
 *
 * ## What this weighs, and what does not hold it
 *
 * `#388` reported and refused to gate, on the ground that a hard ceiling is a
 * number somebody picks and new tools have to be able to exist. `#1118` then
 * held the `authenticated` tier to a **floor** — the last committed measurement,
 * raised only in a commit that said why.
 *
 * **That floor is gone** (`#1649`, D-137). It raised itself on every merge, so
 * the catalogue grew 112 → 123 tools and 194,396 → 221,007 bytes in four days
 * while it was in force, and what it charged for recording that growth was a
 * queue round trip per merge. Size is watched in practice now: it shows up in
 * session cost and in agent behaviour, and it is answered by better descriptions
 * and data-shaped tools rather than by a merge blocker.
 *
 * So this file is the measurement and there is no longer a gate anywhere for it
 * to be confused with. {@link measureToolList} returns figures and never a
 * verdict — there is no `ok` field here, and now nothing computes one.
 *
 * ## The two figures the sum hides (`#1653`)
 *
 * A total is the one number that hides both problems the catalogue work is
 * actually steered by. **A sum permits any single tool**: a 7 KB entry passes as
 * long as something else shrank, and on 2026-08-23 the heaviest non-exempt tool
 * was 7,381 bytes against a median of 1,394 — five times over, with nothing
 * measuring it. `#1235` asked for a per-tool ceiling and was closed without one;
 * `#388` refused one before that. **And the prose share is the number `#1650`
 * exists to move**, and it lived in a document last written on 2026-08-14 rather
 * than in the report that runs on every pull request.
 *
 * Both are now in the report, and both fail nothing. `proseBytesOf` is imported
 * from `catalogue-size.ts` rather than reimplemented — one definition of what
 * counts as prose, or the committed measurements and the pull-request comment
 * would answer the same question differently.
 */
import { proseBytesOf } from './catalogue-size.js'
import { WARM_SET } from './defensive-prose.js'

/** One tool's share of the published list. */
export interface ToolMeasurement {
  readonly name: string
  /** Bytes of this tool's entry, serialised the way the server publishes it. */
  readonly bytes: number
  /** Bytes of its `description` alone — the part read before it is chosen. */
  readonly descriptionBytes: number
  /** Bytes of its `inputSchema` — the part read only after it is chosen. */
  readonly schemaBytes: number
  /**
   * What a reader has to read to know what this tool is for: its own
   * `description` plus every `description` nested in its schema.
   *
   * **Not the same as {@link ToolMeasurement.descriptionBytes}**, which is the
   * tool's own sentence alone. A paragraph on a property is paid for exactly as
   * often as the paragraph on the tool, so the question *how much of this entry
   * is prose* has to count both. `proseBytesOf` is the one definition, shared
   * with the committed catalogue measurements.
   */
  readonly proseBytes: number
}

/** One tier's published `tools/list`, weighed. */
export interface SurfaceMeasurement {
  readonly tier: string
  readonly tools: number
  readonly bytes: number
  readonly tokens: number
  /** Every tool, heaviest first. */
  readonly byWeight: readonly ToolMeasurement[]
}

/**
 * The divisor behind every token figure in this file, stated rather than
 * buried.
 *
 * **Four bytes to the token, and it is an approximation on purpose.** The real
 * number depends on a tokeniser this repository does not ship and would have to
 * keep in step with somebody else's release — and the question being asked is
 * *is this surface getting cheaper or more expensive*, which a stable
 * approximation answers as well as an exact count would. A figure that is
 * consistently 8 % out still ranks two revisions correctly.
 *
 * It is named and exported so that a reader who wants the bytes can have the
 * bytes: every report carries both, and the byte count is the measured one.
 */
export const BYTES_PER_TOKEN = 4

/** Bytes of a value as the server would put it on the wire. */
const wireBytes = (value: unknown): number =>
  value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value), 'utf8')

/**
 * Weigh one tier's tool list.
 *
 * Takes the tools the client actually received rather than anything this module
 * builds itself. **A measurement of something other than what is served is
 * worse than no measurement**, because it is trusted for exactly as long as it
 * takes somebody to act on it.
 */
export function measureToolList(
  tier: string,
  tools: readonly { name: string; description?: string; inputSchema?: unknown }[],
): SurfaceMeasurement {
  const byWeight = tools
    .map((tool) => ({
      name: tool.name,
      bytes: wireBytes(tool),
      descriptionBytes: wireBytes(tool.description),
      schemaBytes: wireBytes(tool.inputSchema),
      proseBytes: proseBytesOf(tool),
    }))
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name))

  const bytes = wireBytes(tools)

  return {
    tier,
    tools: tools.length,
    bytes,
    tokens: Math.round(bytes / BYTES_PER_TOKEN),
    byWeight,
  }
}

/** A signed count, so a reader never has to work out which way it went. */
const signed = (delta: number): string =>
  delta === 0
    ? '±0'
    : delta > 0
      ? `+${delta.toLocaleString('en-US')}`
      : delta.toLocaleString('en-US')

const count = (bytes: number): string => bytes.toLocaleString('en-US')

/**
 * The middle tool by bytes.
 *
 * **The median and not the mean**, because the mean is the sum divided by the
 * count and the sum is the figure this whole block exists to look past: one
 * 7 KB tool moves a mean of 123 by 45 bytes and moves a median not at all. What
 * is being asked is *how far from ordinary is the heaviest one*, and only a
 * middle answers that.
 *
 * Even counts take the lower of the two middles rather than averaging them, so
 * the figure printed is always a tool that exists.
 */
const medianBytes = (byWeight: readonly ToolMeasurement[]): number =>
  byWeight.length === 0 ? 0 : (byWeight[(byWeight.length - 1) >> 1]?.bytes ?? 0)

/**
 * The tier the two figures are about: `authenticated`, or nothing.
 *
 * **Deliberately not the widest tier**, which is what the byte table above
 * ranks. `warden` is `authenticated` plus one tool, so it is always the widest
 * and its figures are always almost identical — and *almost* is the problem. It
 * is the tier a handful of agents see, and these figures exist to steer work on
 * the one **every citizen pays for, in every session**, which is the sentence
 * this whole file opens with.
 *
 * A deployment serving no `authenticated` tier falls back to the widest rather
 * than printing nothing: the figures are still true of what they name, and the
 * block names its tier.
 */
const steeredTier = (head: readonly SurfaceMeasurement[]): SurfaceMeasurement | undefined =>
  head.find((measurement) => measurement.tier === 'authenticated')

/**
 * The heaviest single tool and the prose share (`#1653`).
 *
 * **Two figures, no threshold, no target and no budget file.** They fail
 * nothing and add no status check; what they replace is a sum, which is the one
 * number that hides both of the things they say.
 *
 * **The exempt set is `WARM_SET`**, as everywhere else. The thirteen are read by
 * every citizen on every waking and nothing is cut from them (`#1116`), so
 * ranking them would put a tool nobody may touch at the top of a list about what
 * to touch. A tier consisting only of exempt tools prints no heaviest line
 * rather than an untrue one.
 *
 * The median is taken over **every** tool in the tier, exempt ones included: it
 * is what an ordinary entry in this catalogue weighs, and leaving out thirteen
 * of the most-read tools would make the comparison flatter than the catalogue
 * is.
 */
const steeringFigures = (measurement: SurfaceMeasurement): string[] => {
  const exempt = new Set(WARM_SET)
  const heaviest = measurement.byWeight.find((tool) => !exempt.has(tool.name))
  const middle = medianBytes(measurement.byWeight)
  const prose = measurement.byWeight.reduce((sum, tool) => sum + tool.proseBytes, 0)
  const share = measurement.bytes === 0 ? 0 : (prose / measurement.bytes) * 100

  const lines = [
    `The two figures the sum hides, for \`${measurement.tier}\`:`,
    '',
    '| | |',
    '|---|---|',
  ]

  if (heaviest !== undefined) {
    const times = middle === 0 ? undefined : (heaviest.bytes / middle).toFixed(1)
    lines.push(
      `| Heaviest tool outside \`WARM_SET\` | \`${heaviest.name}\` — ${count(heaviest.bytes)} B` +
        `${times === undefined ? '' : `, ${times}× the median`} |`,
    )
  }

  lines.push(
    `| Median tool | ${count(middle)} B over ${measurement.tools} tools |`,
    `| Prose | ${count(prose)} B — ${share.toFixed(1)} % of the tier |`,
    '',
    'Prose is each tool’s own `description` plus every `description` nested in its ' +
      'schema, counted by the same `proseBytesOf` the committed catalogue ' +
      'measurements use. A sum permits any single tool — a 7 KB entry passes as long ' +
      'as something else shrank — and the prose share is what `#1650` moves.',
  )

  return lines
}

/**
 * Render the tiers as Markdown, for a job summary or a pull-request comment.
 *
 * **Each tier separately, never one total.** They are three different readers
 * with three different budgets, and a single figure hides the finding that
 * `#384` turns on: the unauthenticated tier is three tools and healthy, and the
 * authenticated tier is where the discipline lapsed. A sum would have reported
 * that as one number getting slowly worse.
 */
export function renderSurfaceReport(
  head: readonly SurfaceMeasurement[],
  base: readonly SurfaceMeasurement[] = [],
  heaviest = 10,
): string {
  const baseline = new Map(base.map((measurement) => [measurement.tier, measurement]))
  const lines: string[] = []

  lines.push('### The MCP surface a citizen is handed at connect', '')
  lines.push(
    `Bytes are measured; tokens are bytes ÷ ${BYTES_PER_TOKEN}, which is an approximation and ` +
      'is here to be compared against itself rather than against a tokeniser.',
    '',
  )
  lines.push('| Tier | Tools | Bytes | ≈ tokens | Δ bytes | Δ tools |')
  lines.push('|---|---:|---:|---:|---:|---:|')

  for (const measurement of head) {
    const before = baseline.get(measurement.tier)
    lines.push(
      `| \`${measurement.tier}\` | ${measurement.tools} | ${measurement.bytes.toLocaleString('en-US')} | ` +
        `${measurement.tokens.toLocaleString('en-US')} | ` +
        `${before ? signed(measurement.bytes - before.bytes) : '—'} | ` +
        `${before ? signed(measurement.tools - before.tools) : '—'} |`,
    )
  }

  const widest = head.reduce<SurfaceMeasurement | undefined>(
    (worst, measurement) =>
      worst === undefined || measurement.bytes > worst.bytes ? measurement : worst,
    undefined,
  )

  if (widest !== undefined && widest.byWeight.length > 0) {
    lines.push('', `Where the weight sits in \`${widest.tier}\`, heaviest first:`, '')
    lines.push('| Tool | Bytes | of which description | of which schema |')
    lines.push('|---|---:|---:|---:|')
    for (const tool of widest.byWeight.slice(0, heaviest)) {
      lines.push(
        `| \`${tool.name}\` | ${tool.bytes.toLocaleString('en-US')} | ` +
          `${tool.descriptionBytes.toLocaleString('en-US')} | ${tool.schemaBytes.toLocaleString('en-US')} |`,
      )
    }

    lines.push('', ...steeringFigures(steeredTier(head) ?? widest))
  }

  lines.push(
    '',
    '**Nothing here is a gate.** No job in this workflow fails on a figure and no ' +
      'status check is added by it: the catalogue floor was removed on 2026-08-23 ' +
      '(`#1649`, D-137) because it raised itself on every merge, and no size gate is ' +
      'to be reintroduced in any form without a maintainer decision reversing that. ' +
      'These are numbers to read.',
  )

  return lines.join('\n')
}
