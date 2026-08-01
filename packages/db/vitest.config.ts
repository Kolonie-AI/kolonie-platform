import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Tests live next to the code they cover: `foo.ts` -> `foo.test.ts`.
    include: ['src/**/*.test.ts'],
    // The database tests share one connection and one schema; running files in
    // parallel would have them truncating each other's rows mid-assertion.
    fileParallelism: false,
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
