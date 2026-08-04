/**
 * Run the four counted assertions that break together, and nothing else.
 *
 * ## What this is for
 *
 * Four assertions in this repository carry a number or a list that every new
 * table, enum or MCP tool moves. They are correct, they catch real defects — a
 * table added without an erasure rule, a tool registered and never listed — and
 * the comments beside them carry a running narrative of *why each table exists*,
 * which is worth keeping. The only problem is the price of finding out.
 *
 * Measured on 2026-08-04 shipping `#236`, `#147` and `#211` in one session:
 * three of six full `npm run check` runs — about five minutes of wall clock —
 * bought nothing but four numbers, discovered one run at a time because the four
 * live in three files nobody thinks of together (`#312`).
 *
 * | Assertion | Where |
 * |---|---|
 * | The tool list | `apps/api/src/mcp/tools/me.test.ts`, against `mcp.ts`'s two arrays |
 * | The table count | `packages/db/src/migrate.test.ts` |
 * | The enum count | `packages/db/src/migrate.test.ts` |
 * | The table list | `packages/db/src/schema/schema.test.ts` |
 *
 * The full check is not slow — 1:31 to 1:39 warm across six runs on 2026-08-04,
 * against the 1:28 D-080 measured. This does not make it faster. It gives the
 * cheapest possible feedback a price to match.
 *
 * ## Why {@link COUNTED} is a list of paths and not a pattern
 *
 * The tempting version selects tests by a tag or by a regex over their names —
 * *every test with a number in it*. That is wrong on the first day: `schema.test.ts`
 * alone holds dozens of assertions carrying a number, and none of the other four
 * has anything text-visible in common. Worse, it is the kind of wrong that fails
 * quietly, by matching fewer tests each time somebody rewords a test name.
 *
 * Four paths and three test names is a thing a reader can check against the table
 * above in ten seconds, and a thing that fails loudly when it stops matching —
 * see {@link expectedPassed}.
 *
 * ## What it does not cover
 *
 * Everything else. This is not a substitute for `npm run check` and it is not a
 * pre-push check: no formatting, no lint, no types, no migration drift, and none
 * of the other 2,900-odd tests. It answers exactly one question — *which of the
 * four numbers did my new table, enum or tool just move* — and a green run here
 * says nothing whatsoever about the rest of the repository.
 */
import { spawn } from 'node:child_process'
import console from 'node:console'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// `console` and `process` are Node globals, imported rather than reached for: the
// eslint config declares no environment for a script, and one import line is
// cheaper than a config block per file. `run-workspace-script.mjs` does the same.
import process from 'node:process'

const DATABASE_URL_VAR = 'DATABASE_URL'

/**
 * The four assertions, by the workspace that owns them, the files that hold them
 * and the test names that select them.
 *
 * `migrate.test.ts` carries two of the four in one test, which is why three test
 * names cover four numbers.
 */
const COUNTED = [
  {
    workspace: 'apps/api',
    files: ['src/mcp/tools/me.test.ts'],
    // The tool list: every registered tool appears in `UNAUTHENTICATED_TOOLS` or
    // `AUTHENTICATED_TOOLS`, and nothing else does.
    names: ['appears once a credential is presented'],
  },
  {
    workspace: 'packages/db',
    files: ['src/migrate.test.ts', 'src/schema/schema.test.ts'],
    names: [
      // The table count and the enum count, both in this one test.
      'applies to an empty database, then leaves it unchanged on re-run',
      // The table list, one array entry per table.
      'creates exactly the tables the MVP loop and the guidance subsystem need',
    ],
  },
]

/**
 * How many tests each group must report passed.
 *
 * **This is the load-bearing part of the script and the reason it does not simply
 * shell out to vitest.** A `-t` filter that matches nothing does not fail: vitest
 * skips every test in the file, prints `38 skipped`, and exits **0**. Measured on
 * 2026-08-04 with vitest 4.1.10. So the first person to reword one of the three
 * test names would be handed a green run that asserted nothing at all — the
 * silent-skip failure `#224` spent a whole issue removing from this repository,
 * reintroduced by the convenience script.
 *
 * Requiring the exact count turns a reworded test name into a loud failure that
 * names the file and the pattern that stopped matching.
 */
const expectedPassed = (group) => group.names.length

const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options })
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })

const runGroup = async (group, reportDirectory) => {
  const report = join(reportDirectory, group.workspace.replace(/\//gu, '-') + '.json')

  const code = await run(
    'npx',
    [
      'vitest',
      'run',
      '--root',
      group.workspace,
      ...group.files,
      '-t',
      // Anchored at the end and not at the start, because `-t` matches the full
      // name including every enclosing `describe` — the api test is really
      // `kolonie.me > appears once a credential is presented`. A leading `^`
      // matches nothing, and matching nothing is not an error to vitest, so the
      // wrong version of this line is caught by the count check below rather than
      // by the run failing.
      group.names.map((name) => `${name}$`).join('|'),
      '--reporter=default',
      '--reporter=json',
      `--outputFile.json=${report}`,
    ],
    { cwd: process.cwd() },
  )

  if (code !== 0) return { group, ok: false, reason: `vitest exited ${code}` }

  const summary = JSON.parse(await readFile(report, 'utf8'))
  const expected = expectedPassed(group)
  if (summary.numPassedTests !== expected || summary.numFailedTests !== 0)
    return {
      group,
      ok: false,
      reason:
        `expected exactly ${expected} passing test(s), got ${summary.numPassedTests} passed and ` +
        `${summary.numFailedTests} failed.\n` +
        `        A test name in ${group.workspace} no longer matches this script's filter. ` +
        `Reconcile scripts/check-counts.mjs with:\n        ` +
        group.files.map((file) => `${group.workspace}/${file}`).join('\n        '),
    }

  return { group, ok: true }
}

if ((process.env[DATABASE_URL_VAR] ?? '').trim() === '') {
  // Checked here rather than left to the test that needs it, because everything
  // before that test is a fourteen-second build. `databaseTestTarget` still
  // carries the argument and the fix; this only refuses to spend the build first.
  console.error(
    `${DATABASE_URL_VAR} is not set, so two of the four counted assertions cannot run — and\n` +
      `a check that quietly covered half of them would be worse than no check.\n\n` +
      `  npm run test:db:up\n\n` +
      `prints the URL to export. See packages/db/src/testing.ts for the longer answer.`,
  )
  process.exit(1)
}

// The same build the root `test` script runs first, and for the same reason
// (`#309`): these tests read `@kolonie-ai/core` from `dist/`, so a schema change
// made without rebuilding it fails on an unrelated-looking `TypeError`.
const built = await run('npm', ['run', 'build'])
if (built !== 0) process.exit(built)

const reportDirectory = await mkdtemp(join(tmpdir(), 'kolonie-check-counts-'))
try {
  // In parallel: the two groups share nothing but the build above, and the db
  // group is roughly the whole wall clock on its own.
  const results = await Promise.all(COUNTED.map((group) => runGroup(group, reportDirectory)))
  const failed = results.filter((result) => !result.ok)

  for (const result of failed) console.error(`\n  ${result.group.workspace}: ${result.reason}`)

  if (failed.length > 0) process.exit(1)
  console.log(
    `\nThe four counted assertions hold. This checked nothing else — no formatting, no lint,\n` +
      `no types, no migrations, and none of the other tests. Run \`npm run check\` before you push.`,
  )
} finally {
  await rm(reportDirectory, { recursive: true, force: true })
}
