/**
 * Trade a *throwaway* PostgreSQL's crash-durability for speed, and prove it took.
 *
 * **This is not a tuning knob, it is a statement about which database this is**
 * (`#283`). `fsync`, `synchronous_commit` and `full_page_writes` exist so that a
 * server which loses power still has the rows it acknowledged. The integration
 * tests in this package acknowledge nothing anybody will ask for again:
 * `connectForTests` drops `public` and re-migrates it at the top of every test
 * file, and a crash mid-suite costs a re-run. So the guarantee is bought and
 * never collected.
 *
 * What it was costing, measured on CLAUDE002 (AMD Ryzen 9 3950X, 8 vCPU,
 * 7.2 GiB RAM) on 2026-08-04: `src/storage/attempts.test.ts` took 25.42 s against
 * a stock server and 11.50 s with these three off, 96 of 96 tests passing in
 * both. The whole package went 501 s to 235 s, with the same files failing before
 * and after. At the time `packages/db` was 501 s of a 559 s `npm test` — 90% of
 * it — while the machine sat at 3.5 GiB of 7.2 GiB and never touched swap.
 *
 * **Never point this at a database whose rows somebody wants tomorrow.** It says
 * so again below, at the place where the URL arrives, because that is where the
 * mistake would be made.
 *
 * ## Why it is applied to a running server rather than passed at startup
 *
 * A GitHub Actions service container takes no command arguments — `services:` in
 * `ci.yml` can set environment and health checks and nothing else. So the one
 * mechanism that works in both places is `ALTER SYSTEM` plus a reload, which
 * these three permit: `fsync` and `full_page_writes` have context `sighup`,
 * `synchronous_commit` has context `user`. Read from `pg_settings` on 2026-08-04
 * against postgres:16.
 *
 * ## Why it reads the settings back
 *
 * `ALTER SYSTEM` writes `postgresql.auto.conf` and reports success for doing so.
 * It is not a claim that the running server now uses the value — a setting the
 * build does not have, or one a `postgresql.conf` pins, is accepted here and
 * ignored there. The exit code would then say the suite is running fast while it
 * crawls, which is the quiet-wrong-answer shape this repository has been bitten
 * by often enough to have a rule about it: verify a write by reading it back.
 */
import console from 'node:console'
import process from 'node:process'
// Node globals, imported rather than reached for: the eslint config declares no
// environment for a script. Same as the storage barrel's generator.
import { fileURLToPath, URL } from 'node:url'
import postgres from 'postgres'

/**
 * The three settings, and the value each must report afterwards.
 *
 * `off` for all three is not a coincidence worth collapsing into a constant —
 * they are three independent guarantees that happen to share a spelling, and a
 * future fourth (`wal_level`, say) would not be a boolean at all.
 */
export const RELAXED = /** @type {const} */ ([
  ['fsync', 'off'],
  ['synchronous_commit', 'off'],
  ['full_page_writes', 'off'],
])

/**
 * What is still wrong, given what the server reported. Empty means it took.
 *
 * **A name that is absent from `rows` is a problem, not an absence of one.** That
 * is the case worth writing a function for: a query returning four rows instead
 * of five, because a setting was renamed or the server is a different major, is
 * indistinguishable from success to anything that only checks the rows it did
 * get. The suite would then run at stock speed under a green check forever.
 *
 * @param {readonly {name: string, setting: string}[]} rows
 * @returns {string[]} one human-readable complaint per setting that is not as wanted
 */
export const problemsWith = (rows) => {
  const reported = new Map(rows.map((row) => [row.name, row.setting]))

  return RELAXED.flatMap(([name, wanted]) => {
    const found = reported.get(name)
    if (found === undefined) return [`${name} was not reported by the server at all`]
    if (found !== wanted) return [`${name} is ${found}, wanted ${wanted}`]
    return []
  })
}

/**
 * Apply the settings to an open connection, reload, and report what is still wrong.
 *
 * `ALTER SYSTEM` takes no parameter binding for the setting name, so the names
 * are interpolated — they come from {@link RELAXED} above and never from input,
 * which is the only reason that is safe here.
 *
 * @param {import('postgres').Sql} sql
 * @returns {Promise<string[]>}
 */
export const relax = async (sql) => {
  for (const [name, wanted] of RELAXED) {
    await sql.unsafe(`alter system set ${name} = ${wanted}`)
  }
  await sql`select pg_reload_conf()`

  const names = RELAXED.map(([name]) => name)
  const rows = await sql`select name, setting from pg_settings where name = any(${names})`

  return problemsWith(rows)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // The same variable the tests read, and for the same reason: how the server
  // got there is the caller's business (D-009). What is *not* the caller's
  // business is what is in it — this drops the guarantee that survives a crash,
  // so a URL pointing at anything but a throwaway test server is a mistake this
  // script cannot detect and will not undo.
  const url = process.env.DATABASE_URL
  if (url === undefined || url.trim() === '') {
    console.error(
      'DATABASE_URL is not set, so there is no server to relax.\n' +
        'It must point at a throwaway PostgreSQL 16 that holds test rows only.',
    )
    process.exit(1)
  }

  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    const problems = await relax(sql).catch((error) => {
      // A server that is not there yet is the likeliest failure by far, and its
      // stack trace says `ECONNREFUSED` twelve frames deep. Whoever reads this is
      // trying to find out why their tests will not start.
      console.error(`Could not relax the test database at ${new URL(url).host}:`)
      console.error(`  ${error instanceof Error ? error.message : String(error)}`)
      console.error('\nIs the server up, and is DATABASE_URL pointing at it?')
      process.exit(1)
    })

    if (problems.length > 0) {
      console.error('The test database did not take the relaxed settings:')
      for (const problem of problems) console.error(`  - ${problem}`)
      console.error(
        '\nThe suite would run at full durability and roughly twice the wall clock.\n' +
          'This is reported rather than ignored because a slow green run looks exactly\n' +
          'like a fast one in a log.',
      )
      process.exit(1)
    }
    console.log(`test database relaxed: ${RELAXED.map(([name]) => name).join(', ')} off`)
  } finally {
    await sql.end()
  }
}
