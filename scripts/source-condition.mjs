import { defaultServerConditions } from 'vite'

/**
 * The export condition under which a workspace resolves to its TypeScript source
 * instead of its build output (`#1156`).
 *
 * ## What it is for
 *
 * Every library workspace here exports `./dist/index.js`, so `@kolonie-ai/core`
 * inside a test used to mean *a built artefact*, and nothing downstream could be
 * run until `tsc -b` had finished for everything upstream. That is why
 * `npm run test` began with `npm run build`, and why a targeted
 * `vitest run --root packages/db` meant nothing without a rebuild in front of it.
 *
 * A condition, rather than a vitest `alias`: an alias would make tests resolve to
 * source while `tsc` kept resolving to `dist`, which is two resolutions and two
 * truths for the same import. One condition covers vitest, `tsc` and Node
 * together — `node --conditions=@kolonie-ai/source` resolves the same way this
 * does, and `customConditions` in `tsconfig.base.json` is the third reader.
 *
 * ## Why the name is namespaced rather than `development`
 *
 * `development` is the conventional name and it would need no configuration at
 * all, because Vite applies it by itself in dev mode. That is exactly the hazard.
 * These packages are published, `files` ships `dist` and not `src`, and any
 * Vite-based consumer running in dev mode would silently pick up a condition
 * pointing at `./src/index.ts` that is not in the tarball — a hard resolution
 * error in somebody else's repository, caused by a convenience in this one.
 *
 * A namespaced condition is applied by nothing automatically. Every reader here
 * opts in explicitly and no consumer can opt in by accident, which is the trade
 * this file exists to make. Node's own guidance is that community conditions be
 * namespaced, and the cost is the opt-ins below.
 */
export const SOURCE_CONDITION = '@kolonie-ai/source'

/**
 * The condition, then the list Vitest itself would have used.
 *
 * **`resolve.conditions` replaces Vite's list rather than extending it**, so
 * naming this condition alone would drop `node` and a dependency that publishes
 * separate node and browser entry points would resolve to the wrong one — a
 * failure that looks nothing like its cause.
 *
 * **`module` is filtered out because Vitest filters it out**, in
 * `getDefaultResolveOptions` for Vite 6 and above. Spreading Vite's own list
 * unchanged would put it back and change how third-party packages resolve under
 * test, which is a change this issue is not making: `module` commonly points at
 * an ESM build meant for a bundler rather than for Node.
 */
const CONDITIONS = [SOURCE_CONDITION, ...defaultServerConditions.filter((it) => it !== 'module')]

/**
 * Spread into a vitest config, at the top level. Shared rather than repeated
 * because eleven configs holding the same list is eleven chances for one of them
 * to drift, and a workspace resolving siblings differently from its neighbours is
 * the exact divergence the condition was chosen to avoid.
 *
 * **Three keys, because Vitest resolves through three environments and each
 * reads its own.** Every one of them was arrived at by removing `dist` and
 * watching what still failed, which is the only way to find them: a missing one
 * does not warn, it goes back to reading the build output.
 */
export const sourceResolve = {
  // What a non-test Vite build of this config would read. It resolves nothing
  // under `vitest run` — it is here so that the three cannot disagree.
  resolve: { conditions: CONDITIONS },

  // **The test graph.** Vitest runs node test files through the `ssr`
  // environment. Setting only the top-level `resolve` above left the whole suite
  // resolving to `dist` exactly as before, silently — measured with
  // `packages/core/dist` removed: 41 of 53 verifiers files failed with *"Failed
  // to resolve entry for package @kolonie-ai/core"*.
  ssr: { resolve: { conditions: CONDITIONS } },

  // **`globalSetup`, and nothing else.** Vitest gives itself an environment of
  // its own — `server.environments.__vitest__`, declared in its project plugin
  // as `{ dev: {} }` with no `resolve` — and loads `globalSetup` through that
  // runner rather than through `ssr`. So `packages/db`, whose `globalSetup`
  // builds the template database and therefore imports the schema, failed on
  // `@kolonie-ai/core` with both keys above already set and every test file
  // resolving correctly. The failure arrives before collection, as *"No test
  // files found"* followed by an unhandled resolve error.
  //
  // An internal name, and the reason it is written here rather than avoided:
  // the alternative is a `globalSetup` that may not import a sibling workspace,
  // which is a rule nothing enforces and everything would break. It is asserted
  // in `source-condition.test.ts`, so a Vitest that renames it fails loudly.
  environments: { __vitest__: { resolve: { conditions: CONDITIONS } } },
}
