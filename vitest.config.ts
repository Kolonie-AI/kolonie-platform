import { defineConfig } from 'vitest/config'

// @ts-expect-error a build script, deliberately outside the TypeScript project —
// which is the same sentence the doc comment below is about.
import { testWorkers } from './scripts/test-workers.mjs'
// @ts-expect-error the same, and for the same reason.
import { sourceResolve } from './scripts/source-condition.mjs'

/**
 * The root's own tests, which are the tests of the scripts in `scripts/`.
 *
 * Every other test in this repository belongs to a workspace and is run by that
 * workspace's vitest. `scripts/run-workspace-script.mjs` belongs to none of them —
 * it is the thing that runs them — and until `#285` there was nowhere for a test
 * of it to live. That mattered because the one property it must have is the one
 * that cannot be observed by using it: a suite reported green while a workspace
 * inside it failed looks, from the outside, exactly like a suite that passed.
 */
export default defineConfig({
  // Sibling workspaces resolve to their source, not to `dist` (`#1156`).
  ...sourceResolve,
  test: {
    // A share of the machine when several workspaces run at once, and vitest's
    // own default when this one runs alone. See `scripts/test-workers.mjs` (`#963`).
    maxWorkers: testWorkers(),
    include: ['scripts/**/*.test.ts'],
  },
})
