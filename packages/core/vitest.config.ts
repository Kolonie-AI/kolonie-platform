import { defineConfig } from 'vitest/config'

// @ts-expect-error a build script, deliberately outside the TypeScript project.
import { testWorkers } from '../../scripts/test-workers.mjs'

export default defineConfig({
  test: {
    // A share of the machine when several workspaces run at once, and vitest's
    // own default when this one runs alone. See `scripts/test-workers.mjs` (`#963`).
    maxWorkers: testWorkers(),
    // Tests live next to the code they cover: `foo.ts` -> `foo.test.ts`.
    include: ['src/**/*.test.ts'],
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/index.ts'],
    },
  },
})
