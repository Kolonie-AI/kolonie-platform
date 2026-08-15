import { cpus } from 'node:os'
import { defineConfig } from 'vitest/config'

// @ts-expect-error the runner's helpers are build scripts, deliberately outside
// the TypeScript project — the same reason `scripts/run-workspace-script.test.ts`
// says this over its own import. This file is not typechecked either: the
// package's tsconfig includes `src/**/*.ts` and nothing else.
import { testWorkers } from '../../scripts/test-workers.mjs'

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
 *
 * **`testWorkers` can only lower this** (`#963`). When `npm run check` runs
 * several workspaces at once it publishes a share of the machine, and this
 * package takes the smaller of the two. It is a ceiling in both directions
 * rather than an assignment: the six above is about memory, so a thirty-two-core
 * machine must not be allowed to raise it. Run on its own — `npx vitest run
 * --root packages/db` — there is no budget and the six stands.
 */
const WORKERS = testWorkers(Math.max(1, Math.min(6, cpus().length - 2)))

/**
 * The files that keep per-file isolation.
 *
 * **Empty today, and it exists so that it can stop being** (`#295`). A file that
 * calls `vi.mock` or `vi.stubGlobal` at module scope belongs here: both depend
 * on starting from a clean slate, and with a shared module registry the mocked
 * module may already be resolved from an earlier file in the same worker, so the
 * mock never takes.
 *
 * That failure is the quiet kind. A file that needs isolation and is left out of
 * this list does not fail cleanly — it fails depending on which file loaded the
 * module first, so it can be green on the machine that wrote it and red on the
 * next one. The list is empty as of 2026-08-04 and this is the command that says
 * so, which is worth re-running rather than trusting:
 *
 * ```
 * grep -rl 'vi\.mock(\|vi\.stubGlobal(' packages/db/src --include='*.test.ts'
 * ```
 */
const ISOLATED: string[] = []

const EVERY_TEST = ['src/**/*.test.ts']

export default defineConfig({
  test: {
    // Tests live next to the code they cover: `foo.ts` -> `foo.test.ts`.
    include: EVERY_TEST,
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
     * The migrated template every test file's database is copied from (`#296`).
     *
     * Once per run in the main process, where `setupFiles` is once per file in a
     * worker. The two are a pair: this builds the thing, and the per-file path in
     * `connectForTests` copies it.
     */
    globalSetup: ['./src/test-template-setup.ts'],
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
    /**
     * **Two projects, so this package stops paying for isolation it does not
     * use** (`#295`). The same arrangement `#290` made for `apps/api`, and worth
     * more here because this package is the long pole of every `npm test`.
     *
     * Vitest gives every test file its own module registry and its own globals,
     * bought per file — a fresh worker and the module graph loaded again. What
     * that protects is not the database: every file here already drops `public`
     * and re-migrates it, and `#284` gave each worker slot a database of its
     * own. It protects module state, and nothing in this package has any that
     * matters — see {@link ISOLATED}.
     *
     * Measured on CLAUDE002 on 2026-08-04 at `fbbb8b6`, against a relaxed
     * server, all 1540 tests green in every row:
     *
     * | Arrangement | Wall |
     * |---|---|
     * | isolated | 106.5 s |
     * | not isolated | 54.3 s |
     * | not isolated, again | 55.7 s |
     * | not isolated, `--sequence.shuffle.files` | 60.6 s |
     *
     * Most of it is not the tests: aggregated setup time falls from 149 s to
     * 18 s, which is seventy-six module graphs that no longer get built.
     *
     * `extends: true` because everything above this — the worker count, the
     * setup file that creates each slot's database, the timeout, the console
     * rule — applies to both projects and must not be restated. A project that
     * silently lost `setupFiles` would connect to a database nobody created.
     */
    projects: [
      {
        extends: true,
        test: {
          name: 'shared',
          include: EVERY_TEST,
          ...(ISOLATED.length > 0 && { exclude: ISOLATED }),
          isolate: false,
        },
      },
      /**
       * **The second project exists only when something is in the list.**
       *
       * A project whose `include` is empty does not match nothing — it falls
       * back to Vitest's default include and matches everything, which ran all
       * seventy-seven files a second time: 154 files and 3138 tests, green and
       * meaningless, in 142 s. Measured rather than reasoned about, on the first
       * run of this config.
       */
      ...(ISOLATED.length > 0
        ? [{ extends: true as const, test: { name: 'isolated', include: ISOLATED } }]
        : []),
    ],
  },
})
