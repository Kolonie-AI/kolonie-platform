import { defineConfig } from 'vitest/config'

/**
 * The root's own tests, which are the tests of the scripts in `scripts/`.
 *
 * Every other test in this repository belongs to a workspace and is run by that
 * workspace's vitest. `scripts/run-workspace-tests.mjs` belongs to none of them —
 * it is the thing that runs them — and until `#285` there was nowhere for a test
 * of it to live. That mattered because the one property it must have is the one
 * that cannot be observed by using it: a suite reported green while a workspace
 * inside it failed looks, from the outside, exactly like a suite that passed.
 */
export default defineConfig({
  test: {
    include: ['scripts/**/*.test.ts'],
  },
})
