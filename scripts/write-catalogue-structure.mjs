/**
 * Regenerate the committed structural snapshot of the MCP catalogue (`#1227`).
 *
 * ## What it is for
 *
 * `apps/api/src/mcp/catalogue-structure.test.ts` fails when the served
 * catalogue's shape stops matching `catalogue-structure.json`, and names the
 * paths that moved. When that change is the intended one, this rewrites the
 * snapshot so the structural diff stands on its own in the same commit — a few
 * lines, beside a rewrite of eight hundred lines of prose.
 *
 * It is a separate command rather than an auto-write, unlike
 * `check-catalogue-budget.mjs`. That check's finding *is* the new number, so
 * writing it down costs a reader nothing. This check's finding is the diff, and
 * a check that quietly rewrites what it compares against would leave the
 * reviewer exactly where `#1227` found them.
 *
 * ## Why it drives the suite
 *
 * The same reason `check-catalogue-budget.mjs` does: the catalogue has to be
 * read as it is *served*, through a real client on a real transport against a
 * server built from the api suite's fixtures — and fixtures are kept out of
 * `dist`. So `DATABASE_URL` has to reach a PostgreSQL 16, as it does for any
 * api test.
 *
 * ## Determinism
 *
 * A run that finds the structure already committed writes nothing at all — not
 * even a fresh `measuredAt`. `#1227` asks that regenerating on an unchanged tree
 * produce no diff, and a date stamped on every run is a diff.
 */
import console from 'node:console'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'
import { format, resolveConfig } from 'prettier'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const API = path.join(ROOT, 'apps', 'api')
const SNAPSHOT = path.join(API, 'src', 'mcp', 'catalogue-structure.json')
const TEST = 'src/mcp/catalogue-structure.test.ts'
const COMMAND = 'npm run catalogue-structure'

/** Today, as `YYYY-MM-DD`. The snapshot carries the date it was measured (AGENTS.md §7). */
const today = () => new Date().toISOString().slice(0, 10)

const outputDir = mkdtempSync(path.join(tmpdir(), 'catalogue-structure-'))
const outputPath = path.join(outputDir, 'served.json')

// The suite's failure is expected here rather than fatal: the run that fails is
// exactly the run whose structure this exists to record.
spawnSync('npx', ['vitest', 'run', TEST], {
  cwd: API,
  stdio: 'inherit',
  env: { ...process.env, CATALOGUE_STRUCTURE_OUT: outputPath },
})

let served
try {
  served = JSON.parse(readFileSync(outputPath, 'utf8'))
} catch {
  console.error(
    `The catalogue was not read: ${TEST} wrote nothing.\n` +
      'That is a broken suite rather than a changed catalogue — read the vitest output above. ' +
      'A `DATABASE_URL` reaching a PostgreSQL 16 is the usual cause.',
  )
  process.exit(1)
}

const committed = JSON.parse(readFileSync(SNAPSHOT, 'utf8'))
const shape = (snapshot) => JSON.stringify(snapshot.tools)

if (shape(committed) === shape(served)) {
  console.log(
    `The snapshot already describes the catalogue this build serves: ${served.tools.length} tools. Nothing written.`,
  )
  process.exit(0)
}

// Written through Prettier rather than through `JSON.stringify` alone: the file
// is 80 kB and `format:check` covers it, so a snapshot this script formats its
// own way is one that fails the gate in the same commit that regenerated it.
const snapshot = JSON.stringify(
  { measuredAt: today(), command: COMMAND, tools: served.tools },
  null,
  2,
)

writeFileSync(
  SNAPSHOT,
  await format(snapshot, { ...(await resolveConfig(SNAPSHOT)), filepath: SNAPSHOT }),
  'utf8',
)

console.log(
  `The snapshot now describes ${served.tools.length} tools. ` +
    'Commit apps/api/src/mcp/catalogue-structure.json — its diff is the structural change, and every ' +
    'line of it is one a reviewer should be able to account for.',
)
