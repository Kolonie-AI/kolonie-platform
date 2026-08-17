import { defineConfig } from 'vitest/config'

// @ts-expect-error a build script, deliberately outside the TypeScript project.
import { testWorkers } from '../../scripts/test-workers.mjs'
// @ts-expect-error the same, and for the same reason.
import { sourceResolve } from '../../scripts/source-condition.mjs'

export default defineConfig({
  // Sibling workspaces resolve to their source, not to `dist` (`#1156`).
  ...sourceResolve,
  test: {
    // A share of the machine when several workspaces run at once, and vitest's
    // own default when this one runs alone. See `scripts/test-workers.mjs` (`#963`).
    maxWorkers: testWorkers(),
    include: ['src/**/*.test.ts'],
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/index.ts'],
    },
  },
})
