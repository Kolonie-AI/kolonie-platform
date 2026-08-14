/**
 * Hold the MCP tool catalogue to its committed floor (`#889`).
 *
 * ## What it does, and the one thing it will not do
 *
 * It runs `apps/api/src/mcp/catalogue-budget.test.ts` with
 * `CATALOGUE_BUDGET_REPORT` set, reads the two totals that test writes, and
 * compares them against `apps/api/src/mcp/catalogue-budget.json`. Over the floor
 * it exits non-zero. Under the floor it also exits non-zero, and `--write`
 * lowers the floor to what was measured.
 *
 * **`--write` can only ever lower it.** Given a measurement above the floor it
 * refuses and says so. That asymmetry is the mechanism: lowering after a
 * consolidation is bookkeeping and should cost one command, while raising is a
 * decision and has to cost a sentence somebody wrote in a commit naming the
 * record (`kolonie-docs#346`) and what the new tools are vocabulary-free for.
 * There is no flag that raises it, deliberately — a flag is what the next author
 * reaches for at 6pm.
 *
 * ## Why it drives the suite instead of measuring
 *
 * The same reason `scripts/measure-mcp-surface.mjs` does (`#388`): the catalogue
 * has to be weighed as it is *served*, which means a real client on a real
 * transport against a server built from the suite's fixtures — and fixtures are
 * kept out of `dist` by `scripts/check-dist.mjs`. A script that assembled the
 * server itself would be measuring something adjacent to the thing that ships.
 *
 * `#888`'s `scripts/measure-mcp-catalogue.mjs` is the other half and is not
 * duplicated here: it measures the live deployment, needs a credential and a
 * database, and reports rather than gates. This one needs neither and gates.
 *
 * ## The database
 *
 * The suite needs `DATABASE_URL` because the fixtures register a citizen to
 * connect as. That is the api suite's ordinary requirement and not a new one.
 */
import console from 'node:console'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const API = path.join(ROOT, 'apps', 'api')
const BUDGET = path.join(API, 'src', 'mcp', 'catalogue-budget.json')
const TEST = 'src/mcp/catalogue-budget.test.ts'

const write = process.argv.includes('--write')

/** Today, as `YYYY-MM-DD`. The floor carries the date it was measured (AGENTS.md §7). */
const today = () => new Date().toISOString().slice(0, 10)

const budget = JSON.parse(readFileSync(BUDGET, 'utf8'))

const reportDir = mkdtempSync(path.join(tmpdir(), 'catalogue-budget-'))
const reportPath = path.join(reportDir, 'measured.json')

/**
 * The suite's own failure is expected here rather than fatal: when the catalogue
 * is off its floor the test fails *and* writes the report, and `--write` needs
 * the report from precisely that run. A run that produced no report at all is
 * the real failure, and it is caught below.
 */
spawnSync('npx', ['vitest', 'run', TEST], {
  cwd: API,
  stdio: 'inherit',
  env: { ...process.env, CATALOGUE_BUDGET_REPORT: reportPath },
})

let measured
try {
  measured = JSON.parse(readFileSync(reportPath, 'utf8'))
} catch {
  console.error(
    `The catalogue was not measured: ${TEST} wrote no report.\n` +
      'That is a broken suite rather than a catalogue over budget — read the vitest output above. ' +
      'A `DATABASE_URL` reaching a PostgreSQL 16 is the usual cause.',
  )
  process.exit(1)
}

const grew = measured.tools > budget.tools || measured.bytes > budget.bytes
const shrank = measured.tools < budget.tools || measured.bytes < budget.bytes

if (!grew && !shrank) {
  console.log(
    `The catalogue is exactly its budget: ${measured.tools} tools, ${measured.bytes} bytes.`,
  )
  process.exit(0)
}

if (grew) {
  console.error(
    `The catalogue grew past its budget: ${measured.tools} tools and ${measured.bytes} bytes ` +
      `against a floor of ${budget.tools} and ${budget.bytes} (measured ${budget.measuredAt}).\n` +
      'If this is a new rung, it belongs in a `kind` enum and costs zero tools — see\n' +
      '  kolonie-docs/state/decisions/the-catalogue-encodes-grammar-never-vocabulary.md\n' +
      'If it is a genuinely new verb, edit apps/api/src/mcp/catalogue-budget.json by hand and say\n' +
      'in the commit message which record you are applying and what the new tools are\n' +
      'vocabulary-free for. `--write` will not do it for you.',
  )
  process.exit(1)
}

if (!write) {
  console.error(
    `The catalogue is smaller than its budget by ${budget.tools - measured.tools} tools and ` +
      `${budget.bytes - measured.bytes} bytes, and the floor has not come down with it.\n` +
      'Run `node scripts/check-catalogue-budget.mjs --write` and commit the result. ' +
      'A saving nobody records is one the next feature spends.',
  )
  process.exit(1)
}

writeFileSync(
  BUDGET,
  `${JSON.stringify(
    { tools: measured.tools, bytes: measured.bytes, measuredAt: today(), command: budget.command },
    null,
    2,
  )}\n`,
  'utf8',
)

console.log(
  `The floor came down to ${measured.tools} tools and ${measured.bytes} bytes. ` +
    'Commit apps/api/src/mcp/catalogue-budget.json.',
)
