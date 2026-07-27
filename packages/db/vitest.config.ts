import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Tests live next to the code they cover: `foo.ts` -> `foo.test.ts`.
    include: ['src/**/*.test.ts'],
    // The database tests share one connection and one schema; running files in
    // parallel would have them truncating each other's rows mid-assertion.
    fileParallelism: false,
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
