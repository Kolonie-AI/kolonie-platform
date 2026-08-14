/**
 * Weigh the tool catalogue and the Academy that sends citizens to it (`#888`).
 *
 * ## What it does
 *
 * Two halves, reported together and measurable apart:
 *
 * 1. **The catalogue.** Connects to a running Colony as an ordinary client,
 *    calls `tools/list`, and reports tool count, total bytes, bytes per tool and
 *    prose bytes — per namespace and overall.
 * 2. **What citizens manage with it.** Reads the attempt and submission records
 *    already in the database and reports, per namespace, the pass rate and the
 *    rejected-submission rate of the rungs whose instructions name that
 *    namespace.
 *
 * Neither half invents the other's numbers: the catalogue comes from a live
 * `tools/list` rather than from the registry this repository ships, and the
 * rates come from rows rather than from a fixture.
 *
 * ## Why it connects rather than importing the registry
 *
 * A measurement of something other than what is served is trusted for exactly as
 * long as it takes somebody to act on it. The tool list a client holds in its
 * context is the one the server sent it, so that is what is weighed.
 *
 * `--tools <file>` weighs a saved `tools/list` instead, which is how `#889` runs
 * this where there is no deployment to connect to. It is the same measurement of
 * a list somebody else captured, and the report says which it was.
 *
 * ## Credentials
 *
 * **None in this repository, and none accepted on the command line.** The URL
 * and the key come from `KOLONIE_MCP_URL` and `KOLONIE_API_KEY`; a key passed as
 * an argument would be in the shell history of whoever ran it and in the process
 * list of everybody else on the machine. The key is never printed, never written
 * to the output, and the report records the *host* it was measured against
 * rather than anything that identifies the agent that measured it.
 *
 * ## What it never does
 *
 * **Fail on a number.** There is no threshold here: a catalogue that grew is
 * reported and the script exits 0. It exits non-zero only when it could not
 * measure — a missing credential, an unreachable server — because a silent zero
 * would read as *the catalogue is fine* rather than as *nobody measured it*.
 *
 * ## Usage
 *
 *     KOLONIE_MCP_URL=https://… KOLONIE_API_KEY=… node scripts/measure-mcp-catalogue.mjs
 *     … node scripts/measure-mcp-catalogue.mjs --out docs/measurements/mcp-catalogue.md
 *     node scripts/measure-mcp-catalogue.mjs --tools captured.json --json
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
 * The endpoint and the credential, from the environment or not at all.
 *
 * **Refuses rather than falling back to a default.** A default endpoint would
 * mean a run that measured the wrong Colony and said nothing about it; a report
 * that names the wrong surface is worse than no report, because the figure
 * outlives the run in a committed file. Exported so the refusal itself is
 * tested.
 */
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
 * written into a committed file. The host is the whole of what a reader needs to
 * know which Colony this was.
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

  const client = new Client({ name: 'measure-mcp-catalogue', version: '1.0.0' })
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
 * The Academy half, or nothing at all.
 *
 * Returns `undefined` when there is no `DATABASE_URL`, and the report then says
 * the half was not measured. **It does not return zeros**: a namespace with no
 * attempts and a namespace nobody looked at read identically in a table and call
 * for opposite conclusions.
 */
const academy = async (tools) => {
  const url = process.env['DATABASE_URL']
  if (url === undefined || url === '') return undefined

  const db = await import(pathToFileURL(join(ROOT, 'packages', 'db', 'dist', 'index.js')).href)
  const { toolNamesIn } = await import(
    pathToFileURL(join(ROOT, 'apps', 'api', 'dist', 'mcp', 'tool-names.js')).href
  )
  const { namespaceOf, namespaceSuccess } = await import(
    pathToFileURL(join(ROOT, 'apps', 'api', 'dist', 'mcp', 'catalogue-size.js')).href
  )

  const served = new Set(tools.map((tool) => tool.name))
  // `createDatabase` hands back the query builder itself with a `close` bolted
  // on, so this *is* the handle the storage functions take.
  const client = db.createDatabase(url)

  try {
    const [attempts, submissions, instructions] = await Promise.all([
      db.attemptTallies(client),
      db.submissionTallies(client),
      db.instructionsByTaskType(client),
    ])

    /**
     * Only namespaces that are actually served. A rung naming a tool that has
     * since been renamed would otherwise open a namespace of its own in the
     * table, and a row measuring a namespace the catalogue does not have is the
     * kind of figure that gets quoted once and never checked.
     */
    const byTaskType = new Map(
      instructions.map(({ taskType, instructions: text }) => [
        taskType,
        [
          ...new Set(
            toolNamesIn(text)
              .filter((name) => served.has(name))
              .map(namespaceOf),
          ),
        ],
      ]),
    )

    return {
      success: namespaceSuccess(byTaskType, attempts, submissions),
      source: `${attempts.length} rungs' attempt and submission records`,
    }
  } finally {
    await client.close()
  }
}

const main = async () => {
  const { measureCatalogue, renderCatalogueReport } = await import(
    pathToFileURL(join(ROOT, 'apps', 'api', 'dist', 'mcp', 'catalogue-size.js')).href
  )

  const captured = option('tools')
  const tools =
    captured === undefined
      ? await liveTools(liveSourceFrom(process.env))
      : await capturedTools(captured)
  const source = captured === undefined ? hostOf(liveSourceFrom(process.env).url) : captured

  const catalogue = measureCatalogue(tools)
  const outcomes = await academy(tools)

  const measuredAt = new Date().toISOString().slice(0, 10)
  const command =
    captured === undefined
      ? 'KOLONIE_MCP_URL=… KOLONIE_API_KEY=… DATABASE_URL=… node scripts/measure-mcp-catalogue.mjs'
      : `node scripts/measure-mcp-catalogue.mjs --tools ${captured}`

  const report = renderCatalogueReport({
    measuredAt,
    command,
    source,
    catalogue,
    success: outcomes?.success,
    successSource: outcomes?.source,
  })

  const out = option('out')
  if (out !== undefined) {
    await writeFile(
      out,
      out.endsWith('.json')
        ? `${JSON.stringify({ measuredAt, command, source, catalogue, success: outcomes?.success ?? null }, null, 2)}\n`
        : `${report}\n`,
      'utf8',
    )
  }

  console.log(
    flag('json')
      ? JSON.stringify(
          { measuredAt, source, catalogue, success: outcomes?.success ?? null },
          null,
          2,
        )
      : report,
  )
}

// Imported by the test for the two functions above; only a direct run measures.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
