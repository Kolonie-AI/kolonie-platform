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
 * ## What this weighs, and what holds it
 *
 * `#388` reported and refused to gate, on the ground that a hard ceiling is a
 * number somebody picks and new tools have to be able to exist. The report ran
 * for ten days and the catalogue grew anyway — which is the finding `#1118`
 * acted on, and it did not need a ceiling to act. **The `authenticated` tier is
 * held to a floor**: on a pull request against its merge base with a byte
 * tolerance (`#1266`), on `main` against the last committed measurement,
 * moving down freely and up only in a commit that says why. That is
 * `catalogue-budget.ts` (`#889`), and it carries no opinion about how big the
 * catalogue should be.
 *
 * This file is still the measurement and not the gate, which is why
 * {@link measureToolList} returns figures and never a verdict — there is no `ok`
 * field here, because the comparison lives in one place and this is not it. The
 * three tiers are all reported; only the one every citizen pays for is floored.
 * Flooring `warden` too would take a second pair of numbers, and nobody has
 * shown that surface growing.
 */

/** One tool's share of the published list. */
export interface ToolMeasurement {
  readonly name: string
  /** Bytes of this tool's entry, serialised the way the server publishes it. */
  readonly bytes: number
  /** Bytes of its `description` alone — the part read before it is chosen. */
  readonly descriptionBytes: number
  /** Bytes of its `inputSchema` — the part read only after it is chosen. */
  readonly schemaBytes: number
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
  }

  lines.push(
    '',
    '**The `authenticated` tier is held to a floor.** On a pull request the comparison is ' +
      'against the merge base: tools stay at zero, bytes get a 1,024-byte tolerance, and ' +
      'nothing writes the floor file. On a push to `main` the comparison is against ' +
      '`apps/api/src/mcp/catalogue-budget.json`, and a shrink lowers that file. Raising it ' +
      'takes a commit message naming `the-catalogue-encodes-grammar-never-vocabulary` and ' +
      'saying what the new tools are vocabulary-free for. The other tiers are weighed and ' +
      'reported, and nothing fails on them.',
  )

  return lines.join('\n')
}
