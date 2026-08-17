/**
 * Put a number in front of whoever is adding to the MCP surface (`#388`).
 *
 * ## What it does
 *
 * Runs the one test that connects a real client to a real server for each tier
 * and weighs what came back, then renders the result as Markdown for a job
 * summary or a pull-request comment. With `--base` it renders the change as
 * well, signed.
 *
 * ## Why it drives a test rather than measuring by itself
 *
 * The measurement has to go through `createMcpServer` with the dependencies the
 * suite already constructs, and those fixtures are deliberately kept out of
 * `dist` (`scripts/check-dist.mjs`). A script that built its own stand-in for
 * them would be measuring something other than what is served, which `#388`
 * names as worse than measuring nothing — the figure would be trusted for
 * exactly as long as it took somebody to act on it.
 *
 * So the test writes the JSON and this reads it. The rendering lives in
 * `apps/api/src/mcp/surface-size.ts`, which is production code and is in `dist`,
 * so both halves of the report come from the same module.
 *
 * ## What it never does, and where the refusal lives instead
 *
 * **Fail on a surface that grew.** This renders three tiers and returns a
 * string; there is no ceiling here and no verdict in what it prints. The one
 * thing that exits non-zero is the measurement failing to run at all, because a
 * silent zero would read as *the surface is fine* rather than as *nobody
 * measured it*.
 *
 * That is no longer the same as *nothing fails anywhere* (`#1118`). The
 * `authenticated` tier is held to a floor by `catalogue-budget.ts` (`#889`) —
 * the last committed measurement, moving down freely and up only in a commit
 * that says why — and `scripts/check-catalogue-budget.mjs` is what exits
 * non-zero on growth. Keeping the two apart is deliberate: this one reports on
 * every tier including the two nobody floors, and a report that also refuses is
 * a report people stop reading past the verdict.
 *
 * So a reader of this file should not conclude that a growing catalogue merges.
 * It does not; it merges when the floor moves, and moving the floor upward costs
 * a sentence.
 *
 * ## Usage
 *
 *     node scripts/measure-mcp-surface.mjs --out surface.json
 *     node scripts/measure-mcp-surface.mjs --out head.json --base base.json
 *     node scripts/measure-mcp-surface.mjs --json
 */
import { spawn } from 'node:child_process'
import console from 'node:console'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MEASURING_TEST = 'src/mcp/surface-size.test.ts'

const flag = (name) => process.argv.includes(`--${name}`)
const option = (name) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? undefined : process.argv[at + 1]
}

/** Run the measuring test with the report path set, and hand back what it wrote. */
const measure = async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'mcp-surface-'))
  const report = join(scratch, 'surface.json')

  try {
    const code = await new Promise((done) => {
      const run = spawn('npx', ['vitest', 'run', MEASURING_TEST], {
        cwd: join(ROOT, 'apps', 'api'),
        env: { ...process.env, MCP_SURFACE_REPORT: report },
        stdio: ['ignore', 'ignore', 'inherit'],
      })
      run.on('close', done)
    })

    if (code !== 0) throw new Error(`the measuring test exited ${code}`)
    return JSON.parse(await readFile(report, 'utf8'))
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

const baselineFrom = async (path) => {
  if (path === undefined) return []
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    // A missing or unreadable baseline is not a failure: the first run on a
    // branch has nothing to compare against, and the report says `—` rather
    // than inventing a delta.
    console.error(`No baseline read from ${path}; reporting without a change column.`)
    return []
  }
}

const main = async () => {
  const { renderSurfaceReport } = await import(
    pathToFileURL(join(ROOT, 'apps', 'api', 'dist', 'mcp', 'surface-size.js')).href
  )

  const head = await measure()
  const base = await baselineFrom(option('base'))

  const out = option('out')
  if (out !== undefined) await writeFile(out, JSON.stringify(head, null, 2), 'utf8')

  console.log(flag('json') ? JSON.stringify(head, null, 2) : renderSurfaceReport(head, base))
}

await main()
