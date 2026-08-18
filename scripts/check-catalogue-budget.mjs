/**
 * Hold the MCP tool catalogue to its committed floor (`#889`).
 *
 * ## What it does, and the one thing it will not do
 *
 * It runs `apps/api/src/mcp/catalogue-budget.test.ts` with
 * `CATALOGUE_BUDGET_REPORT` set, reads the figures that test writes, and
 * compares them against `apps/api/src/mcp/catalogue-budget.json`. Over the floor
 * it exits non-zero. Under it, **it lowers the floor and exits zero**.
 *
 * Since `#1235` there are three figures rather than two: the two sums, and the
 * heaviest single non-exempt tool. A sum permits any single tool — four small
 * tools removed is room for one enormous one, and the ratchet would call that a
 * saving — so the third figure moves under exactly the same rule as the other
 * two, and is refused, lowered and committed in the same run.
 *
 * **It can only ever lower it.** Given a measurement above the floor it refuses
 * and says so. That asymmetry is the mechanism: lowering after a consolidation
 * is bookkeeping and should cost nothing at all, while raising is a decision and
 * has to cost a sentence somebody wrote in a commit naming the record
 * (`kolonie-docs#346`) and what the new tools are vocabulary-free for. There is
 * no flag that raises it, deliberately — a flag is what the next author reaches
 * for at 6pm.
 *
 * ## Lowering used to cost a command, and `#1118` took that away
 *
 * `#889` made a reduction *fail* and print `--write`. The reasoning was that a
 * saving should be recorded deliberately; what it actually bought was a red run
 * on the branch that had just made the catalogue smaller, and a second command
 * before the good news counted. So the reduction now writes itself in the run
 * that measured it, and `.github/workflows/mcp-surface.yml` commits the result
 * to the branch that earned it. `--write` is still accepted and still means
 * exactly this, because it is in commit messages and in the floor's own
 * `command` field.
 *
 * What that does not touch is the raise. Nothing here can check the commit that
 * moved the floor, because at the time this runs that commit does not exist yet.
 * `scripts/check-catalogue-floor.mjs` is the half that reads history, and it is
 * a separate entry point so that the rule costs no database to enforce.
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

// `--write` is accepted and no longer read (`#1118`): a reduction writes itself
// either way, and the flag stays spellable because it is quoted in commit
// messages and in the `command` field of every floor committed before this.

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

/**
 * The per-tool ceiling (`#1235`).
 *
 * A missing `heaviest` in the report is a catalogue of nothing but warm tools,
 * which the suite already asserts against — treated here as a broken report
 * rather than a passing measurement, for the same reason the missing report is.
 */
const heaviest = measured.heaviest
if (heaviest === undefined || heaviest === null || typeof heaviest.bytes !== 'number') {
  console.error(
    `The catalogue was measured but its heaviest tool was not: ${TEST} wrote no \`heaviest\`.\n` +
      'That is a broken suite rather than a catalogue over budget — read the vitest output above.',
  )
  process.exit(1)
}

const ceiling = budget.heaviest ?? { name: '', bytes: 0 }
const ceilingOver = heaviest.bytes > ceiling.bytes
// A rename at the same weight moves the ceiling nowhere and is still written:
// the name is what a refusal quotes and what a raise has to name, so it is
// recorded rather than inferred.
const ceilingMoved = heaviest.bytes !== ceiling.bytes || heaviest.name !== ceiling.name

if (grew) {
  console.error(
    `The catalogue grew past its budget: ${measured.tools} tools and ${measured.bytes} bytes ` +
      `against a floor of ${budget.tools} and ${budget.bytes} (measured ${budget.measuredAt}).\n` +
      'If this is a new rung, it belongs in a `kind` enum and costs zero tools — see\n' +
      '  kolonie-docs/state/decisions/the-catalogue-encodes-grammar-never-vocabulary.md\n' +
      'If it is a genuinely new verb, edit apps/api/src/mcp/catalogue-budget.json by hand and say\n' +
      'in the commit message which record you are applying and what the new tools are\n' +
      'vocabulary-free for — scripts/check-catalogue-floor.mjs reads that message and\n' +
      'refuses a raise without it. Nothing here will do it for you.',
  )
}

if (ceilingOver) {
  console.error(
    `\`${heaviest.name}\` weighs ${heaviest.bytes} bytes, past the per-tool ceiling of ` +
      `${ceiling.bytes} set by \`${ceiling.name}\` (measured ${budget.measuredAt}).\n` +
      'No tool may be heavier than the heaviest one already published. The sums have room\n' +
      'for it and that is exactly why this figure exists: a sum permits any single tool.\n' +
      'Cut its prose to fit — AGENTS.md §3 says what a description is written to — or raise\n' +
      'the ceiling by hand in apps/api/src/mcp/catalogue-budget.json, in a commit naming the\n' +
      'record, naming this tool, and saying why it is worth more than every other tool in the\n' +
      'Colony. scripts/check-catalogue-floor.mjs reads that message and refuses a raise\n' +
      'without it. Nothing here will do it for you.',
  )
}

if (grew || ceilingOver) process.exit(1)

if (!shrank && !ceilingMoved) {
  console.log(
    `The catalogue is exactly its budget: ${measured.tools} tools, ${measured.bytes} bytes, ` +
      `heaviest \`${heaviest.name}\` at ${heaviest.bytes}.`,
  )
  process.exit(0)
}

writeFileSync(
  BUDGET,
  `${JSON.stringify(
    {
      tools: measured.tools,
      bytes: measured.bytes,
      heaviest: { name: heaviest.name, bytes: heaviest.bytes },
      measuredAt: today(),
      // The command as it is spelled now, not the one that wrote the previous
      // floor: this field exists so a reader can reproduce the figure, and a
      // flag that is no longer read is not the way to reproduce anything.
      command: 'node scripts/check-catalogue-budget.mjs',
    },
    null,
    2,
  )}\n`,
  'utf8',
)

console.log(
  `The floor came down to ${measured.tools} tools and ${measured.bytes} bytes, ` +
    `with \`${heaviest.name}\` at ${heaviest.bytes} setting the per-tool ceiling. ` +
    'Commit apps/api/src/mcp/catalogue-budget.json.',
)
