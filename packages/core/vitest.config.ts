import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Tests live next to the code they cover: `foo.ts` -> `foo.test.ts`.
    include: ['src/**/*.test.ts'],
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/index.ts'],
    },
  },
})
