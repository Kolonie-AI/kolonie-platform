import { defineConfig } from 'vitest/config'

// @ts-expect-error the runner's helpers are build scripts, deliberately outside
// the TypeScript project. This file is not typechecked either — the app's
// tsconfig includes `src/**/*.ts` and nothing else.
import { memoryCeiling, testWorkers } from '../../scripts/test-workers.mjs'
// @ts-expect-error the same, and for the same reason.
import { sourceResolve } from '../../scripts/source-condition.mjs'

/**
 * The files that keep per-file isolation.
 *
 * `src/avatar.test.ts` mocks `node:dns` and stubs `fetch` to pin the SSRF
 * guards: an avatar URL may not resolve to a private or local address, directly
 * or through a redirect. Those assertions are why this project exists rather
 * than why isolation was turned off everywhere — a change here that makes the
 * suite faster and the check weaker is worse than no change (`#290`).
 */
const ISOLATED = ['src/avatar.test.ts', 'src/website.test.ts', 'src/atlas/provider-icon.test.ts']

const EVERY_TEST = ['src/**/*.test.ts']

/**
 * Two projects, because one file of seventy-one needs per-file isolation and
 * seventy do not (`#290`).
 *
 * Vitest gives every test file its own module registry and its own globals, and
 * that is bought per file — a fresh worker, the module graph loaded again.
 * Measured on 2026-08-04 at `ee5e64b`: 29.90 s as configured, 10.73 s with
 * `--no-isolate`. The pool is not the lever and is not touched; isolation is the
 * whole nineteen seconds.
 *
 * **Which project a new test file belongs in, and this is the thing that
 * drifts.** A file that calls `vi.mock` or `vi.stubGlobal` at module scope
 * belongs in {@link ISOLATED}. Both depend on starting from a clean slate: with
 * a shared module registry the mocked module may already be resolved from an
 * earlier file in the same worker, so the mock never takes, and with shared
 * globals a stub belongs to whoever assigned it last.
 *
 * It drifts quietly, which is the reason this paragraph is here. A file that
 * needs isolation and is left in `shared` does not fail cleanly — it fails
 * depending on which file loaded the module first, so it can be green on the
 * machine that wrote it and red on the next one.
 *
 * ## Why `import` looks larger than `tests`, and is not (D-085)
 *
 * Vitest sums both across workers. The graph below is loaded once per worker —
 * that is what `isolate: false` buys — so `import` grows with the worker count
 * while the wall clock does not: 7.8 s summed at one worker, 75.2 s at eight, for
 * the same 16–25 s stage. At one worker, where summed and wall are the same
 * thing, `tests` is twice `import`.
 *
 * The 7.5 s a worker is this workspace's own graph and not the fixture or the
 * SDK: measured 2026-08-04, the MCP SDK is 0.32 s and `connectedClient` costs
 * 0.27 s more than the server surface it wraps. There is nothing here to trim.
 */
export default defineConfig({
  // Sibling workspaces resolve to their source, not to `dist` (`#1156`).
  ...sourceResolve,
  test: {
    /**
     * **This workspace has never had an opinion about its pool, and that was the
     * problem** (`#963`). Vitest's default is roughly one worker a core, which is
     * correct for a workspace running alone and wrong for one of two running at
     * once: on CLAUDE002 this app and `packages/db` together asked for thirteen
     * workers on eight cores, the machine swapped, and both went red on timeouts
     * — reproducibly, on a diff of two Markdown files.
     *
     * **`#963` fixed the pair and left the default in place for the solo run,
     * and the solo run does not fit either** (`#1350`). This paragraph used to
     * end *`undefined` when nothing is running beside it, so `npx vitest run
     * --root apps/api` still gets the default* — measured on 2026-08-19 against
     * clean `origin/main`, with nothing else running, that default fails fifteen
     * tests in **12 m 12 s**, and the same command at four workers passes all
     * 4381 in **1 m 12 s**. The tell is `sys` at two and a half times `user`:
     * that is not test work, it is the machine paging. Peak resident across the
     * run that fits was 6405 MiB of 7186, with 781 MiB left.
     *
     * **The ceiling is memory and not cores, and the first version of this said
     * so and then multiplied by cores anyway** (`#1354`, correcting `#1350`).
     * `min(6, cpus - 2)` fixed the local failure and cost CI 23 % — measured as
     * an A/B on two pull requests a minute apart, 471 s against 580 s — because
     * on a four-core runner it asks for two workers where the published budget
     * already allowed four. That runner has 16 GiB and no memory problem; it was
     * being lowered by a rule derived from a 7 GiB laptop. {@link memoryCeiling}
     * is the same sentence with the arithmetic to match, and it keeps the cap of
     * six: past a handful of workers the shared Postgres saturates and no amount
     * of RAM changes that.
     *
     * `testWorkers` can still only lower it, so `npm run check` continues to
     * publish a smaller share and this workspace continues to take it.
     *
     * The 29.90 s → 10.73 s isolation measurement below is unaffected: that is
     * what per-file isolation costs, and it is orthogonal to how many workers
     * pay it.
     */
    maxWorkers: testWorkers(memoryCeiling()),
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/index.ts'],
    },
    projects: [
      {
        /**
         * **`extends: true`, because a project inherits nothing without it — and
         * what it was silently not inheriting was `resolve`** (`#1156`).
         *
         * Everything above this line lived in the root config and applied anyway,
         * because `maxWorkers` and `coverage` are read from the root before the
         * projects are built. `resolve` is not: it belongs to each project's own
         * Vite server, so the source condition never reached these test files.
         * With `packages/core/dist` removed, all 216 files failed at collection
         * with *"Failed to resolve entry for package @kolonie-ai/core"* while
         * `packages/db` — whose projects already said this — passed in full.
         *
         * Asserted in `scripts/source-condition.test.ts`: a `projects` entry
         * anywhere in the tree that omits it fails there rather than quietly
         * going back to reading `dist`.
         */
        extends: true,
        test: {
          name: 'shared',
          include: EVERY_TEST,
          exclude: ISOLATED,
          /**
           * The saving, and it is safe for these files precisely because none of
           * them mocks a module or stubs a global:
           * `grep -rl 'vi\.mock(\|vi\.stubGlobal(' src --include='*.test.ts'`
           * returns the isolated files and nothing else.
           *
           * **`website.test.ts` was written into `shared` and failed exactly as
           * the paragraph above says it would** (`#1606`, 2026-08-22): green run
           * alone, red in the full suite, because `vi.stubGlobal('fetch')`
           * belongs to whoever assigned it last. The grep is what found it, and
           * it is quoted here rather than described so that it can be run.
           */
          isolate: false,
        },
      },
      {
        extends: true,
        test: {
          name: 'isolated',
          include: ISOLATED,
        },
      },
    ],
  },
})
