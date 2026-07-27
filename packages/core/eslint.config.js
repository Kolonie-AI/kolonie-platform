import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**'],
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
)
