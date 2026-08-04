/**
 * Make sure this worker's database exists, before the test file that needs it runs.
 *
 * `#284`. Registered as vitest's `setupFiles`, so it runs once per test file in
 * the worker that will run it — which is the only place with the two facts
 * needed: which slot this process occupies, and that nothing has connected yet.
 *
 * **Why here and not inside `connectForTests`.** Sixty of the seventy-two test
 * files in this package reach the database through that function, and the
 * remaining ones are the reason this is not good enough: `migrate.test.ts` opens
 * its own pool from `target.url` because the schema is what it is testing, and
 * `rewards.test.ts` and `tasks.test.ts` open a second pool to make two sessions
 * contend. Putting the guarantee in one of the paths would leave the others
 * connecting to a database nobody had created — and the failure would arrive as a
 * connection error in whichever file happened to be scheduled first, which is a
 * long way from the arrangement that caused it.
 *
 * ## What it costs, and why the cheaper arrangement was not taken
 *
 * One `select` against `pg_database` per test file: **5.3 s of a 72.1 s run**,
 * measured on CLAUDE002 on 2026-08-04 by running the package with this file
 * registered and again without it (66.8 s).
 *
 * The cheaper arrangement is `globalSetup` — create every worker's database once
 * in the main process, and pay nothing per file. It was not taken because it
 * needs the number of databases to equal `maxWorkers`, in a different file from
 * the one that sets `maxWorkers`. Those two agree today and nothing makes them
 * keep agreeing: lowering the worker count leaves unused databases, and raising it
 * leaves a worker connecting to one that was never created. This arrangement has
 * no such pair to keep in step — a worker asks about its own database, whatever
 * slot it turns out to occupy. 7% of the run is a fair price for removing a way
 * to be quietly wrong.
 *
 * ## The `setup` figure vitest prints is not this file's cost (D-084)
 *
 * This package reports a large `setup` and every other workspace reports `0ms`,
 * which reads as though a fifth of the run happens before the first assertion.
 * It does not. The number is where the module graph gets charged: the import
 * below pulls in the client, the schema and Drizzle, and a test file with no
 * setup file would load the same graph a moment later under `import` instead.
 * Measured by ablation on 2026-08-04 — remove this file and `setup` falls to
 * zero, `import` rises by as much, and the wall clock does not move.
 *
 * The `select` above is worth about 2 s summed and 1–2 s of wall. Do not reach
 * for the `setup` figure as evidence that it costs more; D-084 has the table.
 */
import { DATABASE_URL_VAR } from './client.js'
import { ensureWorkerDatabase, testWorkerSlot } from './testing.js'

const url = process.env[DATABASE_URL_VAR]

// Deliberately silent when the variable is missing, rather than throwing the
// obvious error here.
//
// `#224` made a missing DATABASE_URL a hard, *explaining* failure — the message
// in `databaseTestTarget` argues why the database tests cannot be skipped and
// what to run instead. That message is worth more than an earlier one, and a
// setup file that threw first would replace it with a worse one before any test
// file got the chance. A file that needs a database still fails; it fails saying
// something useful.
if (url !== undefined && url.trim() !== '') {
  await ensureWorkerDatabase(url, testWorkerSlot())
}
