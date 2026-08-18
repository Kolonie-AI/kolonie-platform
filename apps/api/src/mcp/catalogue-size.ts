/**
 * What the tool catalogue costs, and how well citizens do with it (`#888`).
 *
 * ## Why this exists beside `surface-size.ts` rather than inside it
 *
 * `surface-size.ts` answers *is the surface getting bigger*, per tier, and it is
 * built for a pull request: connect, weigh, compare against the branch point.
 * This answers a different question, asked once before a consolidation and again
 * after it — **is a namespace worth what it charges**. That needs two things the
 * surface measurement has no business carrying: the share of the bytes that is
 * *prose* rather than machine-readable schema, and the rates at which citizens
 * actually pass and get rejected on the rungs that tell them to call it.
 *
 * Folding both into one module would give the per-pull-request report a
 * dependency on the database, which is how a measurement that runs everywhere
 * becomes one that runs nowhere.
 *
 * ## Why prose is measured separately from bytes
 *
 * Measured 2026-08-13 against the live surface (`#888`): 159,656 bytes of
 * `tools/list`, of which **105,449 is prose** — tool descriptions plus the
 * `description` of every property nested in a schema. Verbatim duplication
 * across all of it is 2,632 bytes, **2.5 %**. There is no boilerplate to strip:
 * the passages that restate a rule are written afresh each time. So the only
 * lever is *how many tools carry prose at all*, and that is a question about
 * namespaces, which is why every figure here is grouped by one.
 *
 * ## What this deliberately is not
 *
 * **A verdict.** Like `surface-size.ts` it returns measurements and never an
 * `ok` field, and for the same reason: `#388`'s decision that the surface
 * reports rather than gates was the maintainer's, and a second module quietly
 * introducing a threshold would overturn it without an issue. `#889` is where a
 * budget is argued for, and it is a separate check reading these numbers rather
 * than a flag added here.
 */

/** A tool as `tools/list` publishes it. Structural, so a live response fits without conversion. */
export interface PublishedTool {
  readonly name: string
  readonly description?: string
  readonly inputSchema?: unknown
}

/** One namespace's share of the catalogue. */
export interface NamespaceMeasurement {
  readonly namespace: string
  readonly tools: number
  /** Bytes of every tool in this namespace, serialised the way the server publishes them. */
  readonly bytes: number
  /** Of those, the bytes that are prose a reader has to read. */
  readonly proseBytes: number
  /** `bytes / tools`, rounded. The Colony's own exchange rate for a namespace. */
  readonly bytesPerTool: number
}

/** The whole published catalogue, weighed. */
export interface CatalogueMeasurement {
  readonly tools: number
  readonly bytes: number
  readonly bytesPerTool: number
  readonly proseBytes: number
  /** `proseBytes / bytes`, between 0 and 1. */
  readonly proseShare: number
  /** Every namespace, heaviest first. */
  readonly byNamespace: readonly NamespaceMeasurement[]
}

/** Bytes of a value as the server would put it on the wire. */
const wireBytes = (value: unknown): number =>
  value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value), 'utf8')

/** Bytes of a string as it stands, without the quotes JSON would add around it. */
const textBytes = (value: string): number => Buffer.byteLength(value, 'utf8')

/**
 * Which namespace a tool belongs to.
 *
 * The second dotted segment: `kolonie.accounts.list` is `accounts`, and
 * `kolonie.me` is `me`. A one-segment namespace is a real one rather than a
 * degenerate case — `me`, `wakeup` and `register` each carry a single tool, and
 * a grouping that dropped them would be reporting on part of the catalogue while
 * printing a total for all of it.
 *
 * A name with no dot at all is returned whole rather than discarded, for the
 * same reason: this is a measurement, and a tool that does not fit the naming
 * convention is exactly the thing a measurement must not hide.
 */
export function namespaceOf(name: string): string {
  const segments = name.split('.')
  if (segments.length < 2) return name
  return segments[0] === 'kolonie' ? (segments[1] ?? name) : (segments[0] ?? name)
}

/**
 * Every `description` string inside a value, at any depth.
 *
 * **Only string values under that key.** A schema whose own property is called
 * `description` — `kolonie.vault.describe` has one — maps that key to an object,
 * and counting the object would charge the property's entire schema to prose.
 * The string nested inside it is counted, because that one is prose.
 *
 * Arrays are walked, because `anyOf` and `items` carry descriptions and both are
 * arrays. Counted as text rather than as JSON: the quotes and escapes are what
 * the transport costs, and what is being asked here is how much a reader reads.
 */
const proseInside = (value: unknown): number => {
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + proseInside(item), 0)
  if (value === null || typeof value !== 'object') return 0

  let bytes = 0
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'description' && typeof nested === 'string') bytes += textBytes(nested)
    else bytes += proseInside(nested)
  }
  return bytes
}

/**
 * What a reader has to read to know what one tool is for.
 *
 * The tool's own `description` plus every `description` nested in its schema.
 * The two are one number because they are one cost: a client puts the whole
 * entry in its system prompt at connect, so a paragraph on a property is paid
 * for exactly as often as the paragraph on the tool.
 */
export function proseBytesOf(tool: PublishedTool): number {
  return (
    (tool.description === undefined ? 0 : textBytes(tool.description)) +
    proseInside(tool.inputSchema)
  )
}

/**
 * What one tool costs a citizen — its whole entry, serialised as the list
 * serialises it.
 *
 * The schema as well as the prose, because both are paid for at connect and a
 * citizen is charged for neither separately. **The sum of these is not
 * {@link measureCatalogue}'s `bytes`**: that one weighs the array, whose own
 * brackets and separators are real bytes on the wire. They differ by exactly
 * those, and neither is the wrong number for its own question.
 *
 * `#1235`'s per-tool ceiling is the caller this was extracted for.
 */
export function toolBytesOf(tool: PublishedTool): number {
  return wireBytes(tool)
}

/**
 * Weigh a published `tools/list`.
 *
 * Takes what the client received, never a list this module builds — the same
 * rule `surface-size.ts` states, and for the same reason: a measurement of
 * something other than what is served is trusted for exactly as long as it takes
 * somebody to act on it.
 */
export function measureCatalogue(tools: readonly PublishedTool[]): CatalogueMeasurement {
  const grouped = new Map<string, { tools: number; bytes: number; proseBytes: number }>()

  for (const tool of tools) {
    const namespace = namespaceOf(tool.name)
    const running = grouped.get(namespace) ?? { tools: 0, bytes: 0, proseBytes: 0 }
    grouped.set(namespace, {
      tools: running.tools + 1,
      bytes: running.bytes + wireBytes(tool),
      proseBytes: running.proseBytes + proseBytesOf(tool),
    })
  }

  const byNamespace = [...grouped.entries()]
    .map(([namespace, running]) => ({
      namespace,
      tools: running.tools,
      bytes: running.bytes,
      proseBytes: running.proseBytes,
      bytesPerTool: Math.round(running.bytes / running.tools),
    }))
    .sort((a, b) => b.bytes - a.bytes || a.namespace.localeCompare(b.namespace))

  /**
   * The whole list serialised, not the sum of its entries. The array's own
   * brackets and separators are bytes the citizen is charged, and a total that
   * disagreed with what the transport moved would be the wrong number by exactly
   * the amount nobody would think to check.
   */
  const bytes = wireBytes(tools)
  const proseBytes = byNamespace.reduce((sum, entry) => sum + entry.proseBytes, 0)

  return {
    tools: tools.length,
    bytes,
    bytesPerTool: tools.length === 0 ? 0 : Math.round(bytes / tools.length),
    proseBytes,
    proseShare: bytes === 0 ? 0 : proseBytes / bytes,
    byNamespace,
  }
}

/** How one task type's citizens fared. Structurally what `@kolonie-ai/db` returns. */
export interface TaskTypeOutcome {
  readonly taskType: string
  readonly passed: number
  readonly failed: number
  readonly abandoned: number
}

/** How one task type's submissions were judged. Structurally what `@kolonie-ai/db` returns. */
export interface TaskTypeSubmissions {
  readonly taskType: string
  readonly passed: number
  readonly rejected: number
}

/** What citizens actually manage on the rungs that send them to one namespace. */
export interface NamespaceSuccess {
  readonly namespace: string
  /** The rungs whose instructions name a tool here, so a reader can check the mapping. */
  readonly taskTypes: readonly string[]
  /** Closed attempts: passed + failed + abandoned. */
  readonly attempts: number
  /** `passed / attempts`, or `null` when nothing has closed. */
  readonly passRate: number | null
  /** Judged submissions: passed + rejected. */
  readonly submissions: number
  /** `rejected / submissions`, or `null` when nothing has been judged. */
  readonly rejectionRate: number | null
}

/**
 * Attach the Academy's outcomes to the namespaces the rungs send citizens to.
 *
 * **The mapping is a task's own instructions**, parsed by the caller with the
 * one parser that already turns Colony-authored prose into tool names. There is
 * no column saying which namespace a rung is about, and inventing one would put
 * that fact in a second place that can disagree with the text the citizen reads.
 *
 * **A rung that names three namespaces counts in all three**, and the counts do
 * not sum to the Academy. That is the honest shape: `email-roundtrip` tells a
 * citizen to call `kolonie.academy.challenge` *and* `kolonie.academy.answer` and
 * a failure at it is evidence about both. Dividing the attempts between them
 * would invent a split nothing measured. `taskTypes` is returned so the division
 * is visible rather than implied.
 *
 * **Counts are summed and the rate is computed once**, never averaged across
 * rungs. A namespace with one rung at 100 % over two attempts and one at 20 %
 * over two hundred is not at 60 %.
 */
export function namespaceSuccess(
  namespacesByTaskType: ReadonlyMap<string, readonly string[]>,
  attempts: readonly TaskTypeOutcome[],
  submissions: readonly TaskTypeSubmissions[],
): NamespaceSuccess[] {
  const running = new Map<
    string,
    { taskTypes: Set<string>; passed: number; closed: number; accepted: number; rejected: number }
  >()

  const forNamespace = (namespace: string) => {
    const found = running.get(namespace) ?? {
      taskTypes: new Set<string>(),
      passed: 0,
      closed: 0,
      accepted: 0,
      rejected: 0,
    }
    running.set(namespace, found)
    return found
  }

  for (const tally of attempts) {
    for (const namespace of namespacesByTaskType.get(tally.taskType) ?? []) {
      const entry = forNamespace(namespace)
      entry.taskTypes.add(tally.taskType)
      entry.passed += tally.passed
      entry.closed += tally.passed + tally.failed + tally.abandoned
    }
  }

  for (const tally of submissions) {
    for (const namespace of namespacesByTaskType.get(tally.taskType) ?? []) {
      const entry = forNamespace(namespace)
      entry.taskTypes.add(tally.taskType)
      entry.accepted += tally.passed
      entry.rejected += tally.rejected
    }
  }

  return [...running.entries()]
    .map(([namespace, entry]) => {
      const submitted = entry.accepted + entry.rejected
      return {
        namespace,
        taskTypes: [...entry.taskTypes].sort((a, b) => a.localeCompare(b)),
        attempts: entry.closed,
        passRate: entry.closed === 0 ? null : entry.passed / entry.closed,
        submissions: submitted,
        rejectionRate: submitted === 0 ? null : entry.rejected / submitted,
      }
    })
    .sort((a, b) => b.attempts - a.attempts || a.namespace.localeCompare(b.namespace))
}

/** A percentage, or an em dash where there is no denominator to divide by. */
const percent = (rate: number | null): string =>
  rate === null ? '—' : `${(rate * 100).toFixed(1)} %`

const count = (value: number): string => value.toLocaleString('en-US')

/**
 * Render the catalogue and the outcomes as one Markdown document.
 *
 * **`measuredAt` and `command` are required arguments and not defaults.**
 * `AGENTS.md` §7 requires a measurement to carry its date and the command that
 * produced it, and a default would let a report be written that carries neither
 * — which is the failure the rule exists to prevent, since the figure survives
 * in a file long after anybody remembers which surface it was taken against.
 */
export function renderCatalogueReport(options: {
  readonly measuredAt: string
  readonly command: string
  readonly source: string
  readonly catalogue: CatalogueMeasurement
  readonly success?: readonly NamespaceSuccess[]
  readonly successSource?: string
}): string {
  const { catalogue, measuredAt, command, source } = options
  const lines: string[] = []

  lines.push('### The tool catalogue, and what citizens do with it', '')
  lines.push(`Measured **${measuredAt}** against \`${source}\`:`, '')
  lines.push('```')
  lines.push(command)
  lines.push('```', '')

  lines.push(
    `**${count(catalogue.tools)} tools, ${count(catalogue.bytes)} bytes**, ` +
      `${count(catalogue.bytesPerTool)} bytes per tool, of which ` +
      `**${count(catalogue.proseBytes)} bytes is prose** ` +
      `(${(catalogue.proseShare * 100).toFixed(1)} % of the whole).`,
    '',
  )

  lines.push('| Namespace | Tools | Bytes | Bytes per tool | Prose bytes |')
  lines.push('|---|---:|---:|---:|---:|')
  for (const entry of catalogue.byNamespace) {
    lines.push(
      `| \`${entry.namespace}\` | ${entry.tools} | ${count(entry.bytes)} | ` +
        `${count(entry.bytesPerTool)} | ${count(entry.proseBytes)} |`,
    )
  }

  const success = options.success ?? []
  lines.push('', '#### What the rungs that name each namespace actually yield', '')

  if (success.length === 0) {
    /**
     * Said out loud rather than printed as an empty table. A measurement that
     * quietly omits half of itself reads as *there is nothing there*, and the
     * half missing here is the one that needs a database the caller may not have
     * given it.
     */
    lines.push(
      '**Not measured in this run.** No attempt records were read, so nothing below is a ' +
        'zero — it is an absence. Re-run with a database to fill it.',
    )
  } else {
    lines.push(
      `From ${options.successSource ?? 'the attempt records'}. A rung that names several ` +
        'namespaces counts in each of them, so these do not sum to the Academy.',
      '',
    )
    lines.push(
      '| Namespace | Rungs | Closed attempts | Pass rate | Judged submissions | Rejected |',
    )
    lines.push('|---|---:|---:|---:|---:|---:|')
    for (const entry of success) {
      /**
       * The rungs counted rather than named. Which rungs they are is in the JSON
       * beside this file, and a namespace named by thirty of them turns a table
       * cell into a paragraph nobody reads — while the number is the thing a
       * reader needs, because it is what makes the double-counting visible.
       */
      lines.push(
        `| \`${entry.namespace}\` | ${count(entry.taskTypes.length)} | ${count(entry.attempts)} | ` +
          `${percent(entry.passRate)} | ${count(entry.submissions)} | ` +
          `${percent(entry.rejectionRate)} |`,
      )
    }
  }

  lines.push(
    '',
    '**Nothing here is a gate.** This reports and never refuses — `#388` decided that for ' +
      'the surface and `#888` does not reopen it. A budget is `#889`, which reads these ' +
      'numbers rather than adding a verdict to them.',
  )

  return lines.join('\n')
}
