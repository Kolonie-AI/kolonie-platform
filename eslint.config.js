import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // Globbed with **/ so they match inside every workspace, not just the root.
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      // Generated on every build and not in git (#271).
      'packages/db/src/storage/index.ts',
      // Written and removed within one test, and not in git (#1190).
      'packages/db/vitest.*-probe.config.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // The domain model is the public contract of this package: every exported
      // symbol must be intentional, so unused code is an error rather than noise.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // `verbatimModuleSyntax` already forces this at the type level; the rule
      // makes the failure readable instead of a compiler error.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // Domain rules must be explicit. An `any` here leaks into every consumer.
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    /**
     * The challenge pages' own scripts, which run in a browser and not in Node.
     *
     * **Linted rather than ignored, deliberately.** These files are the measuring
     * instrument the browser branch is built on (`#160`) — a typo in one of them fails
     * honest citizens on a rung the Colony cannot see failing. Excluding them would be
     * excluding the code with the least test coverage in the repository.
     *
     * The globals are declared rather than pulled from a `globals` package so this
     * config gains no dependency for six names. If a page needs a seventh, add it here.
     */
    files: ['apps/api/public/**/*.js'],
    languageOptions: {
      globals: {
        document: 'readonly',
        window: 'readonly',
        location: 'readonly',
        fetch: 'readonly',
        getComputedStyle: 'readonly',
        setTimeout: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
  },
)
