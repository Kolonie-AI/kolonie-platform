import { cpus } from 'node:os'
import { defineConfig } from 'vitest/config'

/**
 * How many test files run at once.
 *
 * Derived from the machine rather than fixed to the one it was tuned on, and
 * capped on both sides for a reason. Below, a two-core runner should not be told
 * to keep six databases busy; above, the returns had gone flat when measured — on
 * CLAUDE002 (8 vCPU, 7.2 GiB RAM) on 2026-08-04 this package took 82 s across
 * four workers and 68 s across six.
 *
 * **The ceiling is memory, not cores.** Every worker holds a connection pool and
 * a Postgres backend of its own, and in the same session running this package six
 * ways *while* the other six workspaces ran took the machine to 5.5 GiB of
 * 7.2 GiB and touched swap for the first time.
 */
const WORKERS = Math.max(1, Math.min(6, cpus().length - 2))

export default defineConfig({
  test: {
    // Tests live next to the code they cover: `foo.ts` -> `foo.test.ts`.
    include: ['src/**/*.test.ts'],
    /**
     * **Each worker owns a database, so files no longer share one** (`#284`).
     *
     * This said the opposite until 2026-08-04, and what it said was true of the
     * arrangement rather than of the tests: *"the database tests share one
     * connection and one schema; running files in parallel would have them
     * truncating each other's rows mid-assertion."* Every file here already drops
     * `public` and re-migrates at the top of itself, so each is written as though
     * it owns a database. It was simply handed the same one as everybody else.
     *
     * `setupFiles` creates `<database>_w<slot>` for the slot the worker occupies
     * and `databaseTestTarget` hands the file that URL. Files in one slot still
     * never overlap, because a slot runs one file at a time; files in different
     * slots are in different databases and cannot see each other's rows at all.
     *
     * Measured on CLAUDE002 on 2026-08-04 against a server with durability
     * relaxed (`#283`): 235 s in series, 68 s across six workers, the same files
     * failing in both.
     */
    fileParallelism: true,
    maxWorkers: WORKERS,
    setupFiles: ['./src/test-worker-setup.ts'],
    /**
     * **Vitest's default is five seconds, and that is a unit-test default.**
     * Every test in this package makes real round trips to a real Postgres, and
     * the ones that build a corpus make dozens: `briefing.test.ts`'s bounded-corpus
     * test registers seventy citizens, opens and closes seventy attempts, and
     * files and moderates seventy reports, one after another.
     *
     * It went over the cliff on 2026-08-01. The test took 2740 ms on a
     * maintainer's machine and 5409 ms on a CI runner, and the run before it —
     * `a275a9e`, which made registration do more work — was green. So the default
     * was not measuring whether anything was wrong; it was measuring which
     * machine ran it, and the first commit to land on a slow runner was told its
     * change had broken a test it never touched.
     *
     * Thirty seconds is far above any healthy test here and far below a hang, so
     * it still fails a query that never returns — which is the only thing a
     * timeout in this package is good for.
     */
    testTimeout: 30_000,
    // Vitest buffers worker console output and only shows it around failures.
    // A skipped suite is not a failure, so the explanation of *why* the database
    // tests did not run would be swallowed — leaving exactly the silent skip
    // D-009 forbids. This sends it straight to the terminal.
    disableConsoleIntercept: true,
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/index.ts'],
    },
  },
})
