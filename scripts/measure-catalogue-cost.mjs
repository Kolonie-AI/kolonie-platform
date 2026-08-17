/**
 * What the tool catalogue costs a citizen (`#1119`).
 *
 * ## What it does
 *
 * Answers the two questions `#1119` asks, and proposes nothing:
 *
 * 1. **Does the size hurt tool choice?** From `agent_call_hours` (`#835`): the
 *    rate at which MCP tool calls are refused on the citizen's side, overall,
 *    per tool and per runtime — plus, in the report itself, the signals the
 *    issue asks for that nothing in the Colony records.
 * 2. **At how many cold tools per session does fetching stop paying?** The
 *    catalogue as a cached prefix against fetched definitions, with every input
 *    measured: the catalogue from a live `tools/list`, the index built from it,
 *    the session length and the tool spread from the database.
 *
 * ## Credentials
 *
 * **None in this repository, and none accepted on the command line**, on exactly
 * the terms `measure-mcp-catalogue.mjs` states: `KOLONIE_MCP_URL`,
 * `KOLONIE_API_KEY` and `DATABASE_URL` from the environment, the key never
 * printed and never written to the output, and the *host* recorded rather than
 * anything identifying the agent that measured.
 *
 * **No citizen is identifiable in the output.** That is a property of the reads
 * rather than of a filter here: `routeTalliesSince`, `runtimeTalliesSince` and
 * `sessionToolSpreadSince` return aggregates with no agent id in them, so there
 * is nothing for this script to strip.
 *
 * ## What it never does
 *
 * **Fail on a number.** There is no threshold: it exits 0 whatever it finds, and
 * non-zero only when it could not measure — a missing credential, an unreachable
 * server. A silent zero would read as *the catalogue is fine* rather than as
 * *nobody measured it*.
 *
 * ## Usage
 *
 *     KOLONIE_MCP_URL=https://… KOLONIE_API_KEY=… DATABASE_URL=… \
 *       node scripts/measure-catalogue-cost.mjs --out docs/measurements/catalogue-cost.md
 *     … node scripts/measure-catalogue-cost.mjs --tools captured.json --days 7 --json
 */
import console from 'node:console'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { URL, fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const flag = (name) => process.argv.includes(`--${name}`)
const option = (name) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}

/**
 * How many bytes of catalogue make a token.
 *
 * **Derived from the pair `#1119` states rather than from a tokeniser**: 182,868
 * bytes measured as roughly 44,000 tokens on 2026-08-16. Running a tokeniser
 * would be more exact and would also make the report's headline disagree with
 * the number the issue was written from, which is the number every argument
 * about the catalogue has been conducted in.
 *
 * It cancels out of the break-even almost entirely — the answer is a ratio of
 * token counts — so the figure it really governs is the token totals printed
 * beside the byte totals, and those carry this line as their method.
 */
const BYTES_PER_TOKEN = 182_868 / 44_000

/**
 * The share of a session's requests over which a fetched definition is already
 * in the transcript, and the price of a cache-read token.
 *
 * The two judgements in the model, named here rather than buried, because the
 * answer moves by an order of magnitude across the second one and a reader has
 * to be able to disagree with a number instead of with a result. `0.1` is
 * Anthropic's published cache-read price; `0.5` is a definition fetched at the
 * midpoint of the session, which is the neutral assumption and not a measured
 * one.
 */
const CACHE_READ_SHARE = 0.1
const RETAINED_SHARE = 0.5

/**
 * The floor under the worst-tools table.
 *
 * A tool called twice and refused once is a 50 % rate and no evidence at all, so
 * a table with no floor is a table of the least-used tools in the Colony.
 */
const MINIMUM_CALLS = 20

/** Endpoint and credential, from the environment or not at all. */
export function liveSourceFrom(env) {
  const url = env['KOLONIE_MCP_URL']
  const key = env['KOLONIE_API_KEY']

  const missing = [
    url === undefined || url === '' ? 'KOLONIE_MCP_URL' : undefined,
    key === undefined || key === '' ? 'KOLONIE_API_KEY' : undefined,
  ].filter((name) => name !== undefined)

  if (missing.length > 0) {
    throw new Error(
      `Set ${missing.join(' and ')} to measure a live surface, or pass --tools <file> to weigh a captured one. ` +
        'Neither is read from this repository and neither is accepted as an argument.',
    )
  }

  return { url, key }
}

/**
 * The host a measurement was taken against, with nothing else from the URL.
 *
 * A path or a query string on an endpoint can carry a token, and this string is
 * written into a committed file.
 */
export function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return 'an unparseable URL'
  }
}

/** Connect as an ordinary client and ask for the list. */
const liveTools = async ({ url, key }) => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } =
    await import('@modelcontextprotocol/sdk/client/streamableHttp.js')

  const client = new Client({ name: 'measure-catalogue-cost', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  })

  await client.connect(transport)
  try {
    return (await client.listTools()).tools
  } finally {
    await client.close()
  }
}

/** Weigh a saved list instead. Accepts what `tools/list` returns or the bare array. */
const capturedTools = async (path) => {
  const parsed = JSON.parse(await readFile(path, 'utf8'))
  const tools = Array.isArray(parsed) ? parsed : parsed.tools
  if (!Array.isArray(tools)) throw new Error(`${path} holds no tool list`)
  return tools
}

/**
 * The records half.
 *
 * **Refuses rather than returning zeros.** A run with no `DATABASE_URL` could
 * print a 0 % error rate and an empty session distribution, and both would read
 * as findings. This report is committed and quoted; half of it silently absent
 * is worse than a run that did not happen.
 */
const records = async (since, prefix) => {
  const url = process.env['DATABASE_URL']
  if (url === undefined || url === '') {
    throw new Error(
      'Set DATABASE_URL. Both questions are answered from the call and session records, ' +
        'and a run without them would report an absence as a rate.',
    )
  }

  const db = await import(pathToFileURL(join(ROOT, 'packages', 'db', 'dist', 'index.js')).href)
  const client = db.createDatabase(url)

  try {
    const [routes, runtimes, spread, requests] = await Promise.all([
      db.routeTalliesSince(client, since),
      db.runtimeTalliesSince(client, since, prefix),
      db.sessionToolSpreadSince(client, since, prefix),
      db.requestsPerSessionSince(client, since),
    ])
    return { routes, runtimes, spread, requests }
  } finally {
    await client.close()
  }
}

const main = async () => {
  const cost = await import(
    pathToFileURL(join(ROOT, 'apps', 'api', 'dist', 'mcp', 'catalogue-cost.js')).href
  )

  const captured = option('tools')
  const tools =
    captured === undefined
      ? await liveTools(liveSourceFrom(process.env))
      : await capturedTools(captured)
  const source = captured === undefined ? hostOf(liveSourceFrom(process.env).url) : captured

  const days = Number(option('days') ?? 7)
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const { routes, runtimes, spread, requests } = await records(since, cost.TOOL_ROUTE_PREFIX)

  const index = cost.measureIndex(tools)
  const tokens = (bytes) => Math.round(bytes / BYTES_PER_TOKEN)

  const model = {
    catalogueTokens: tokens(index.catalogueBytes),
    indexTokens: tokens(index.indexBytes),
    definitionTokens: tokens(index.definitionBytes),
    cacheReadShare: CACHE_READ_SHARE,
    retainedShare: RETAINED_SHARE,
    requests: requests.median,
  }

  const breakEvens = cost.breakEven(model)
  /**
   * Asked about as whole tools, rounded **down**. The break-even is where the two
   * are equal, and a session sitting exactly there wins nothing — so the
   * conservative reading is the one the report quotes.
   */
  const thresholds = [
    ...new Set(breakEvens.flatMap((point) => [point.atRequests, point.asRequestsGrow])),
  ]
    .map((value) => Math.floor(value))
    .sort((a, b) => a - b)

  const measuredAt = new Date().toISOString().slice(0, 10)
  const command =
    captured === undefined
      ? `KOLONIE_MCP_URL=… KOLONIE_API_KEY=… DATABASE_URL=… node scripts/measure-catalogue-cost.mjs --days ${days}`
      : `DATABASE_URL=… node scripts/measure-catalogue-cost.mjs --tools ${captured} --days ${days}`

  const measurement = {
    measuredAt,
    command,
    source,
    window: { days, since: since.toISOString().slice(0, 10) },
    index,
    model,
    breakEvens,
    evidence: cost.choiceEvidence(routes, runtimes, MINIMUM_CALLS),
    spread: cost.sessionSpread(spread, thresholds),
    requestsPerSession: { median: requests.median, p90: requests.p90 },
    minimumCalls: MINIMUM_CALLS,
  }

  const report = cost.renderCostReport(measurement)

  /**
   * Both files from one run, and not one file per run.
   *
   * `measure-mcp-catalogue.mjs` writes whichever the extension names, which is
   * fine for a report that is a table of sizes. This one is an argument: the
   * prose states a share of sessions and the JSON carries the distribution it
   * was computed from, and two runs an hour apart against a live Colony would
   * have them disagree about how many sessions there were. A reader finding that
   * cannot tell a moved number from a wrong one.
   */
  const out = option('out')
  if (out !== undefined) {
    const stem = out.replace(/\.(md|json)$/u, '')
    await writeFile(`${stem}.md`, `${report}\n`, 'utf8')
    await writeFile(
      `${stem}.json`,
      `${JSON.stringify({ ...measurement, unrecordedSignals: cost.UNRECORDED_SIGNALS }, null, 2)}\n`,
      'utf8',
    )
  }

  console.log(flag('json') ? JSON.stringify(measurement, null, 2) : report)
}

// Imported by the test for the two functions above; only a direct run measures.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
