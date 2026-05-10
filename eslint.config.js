// Flat ESLint config (ESLint 9+).
// Goal: catch real bugs without flooding the codebase with noise on day one.
// Tighten rules over time as the team triages existing findings.

const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.d.ts',
      'packages/admin-api/public/**',
      'scripts/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['packages/*/src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // The codebase has ~127 explicit `any`s today. Don't block on them;
      // surface as warnings so new code is nudged toward better types.
      '@typescript-eslint/no-explicit-any': 'warn',

      // Allow `_`-prefixed unused vars/args (common pattern for intentional
      // unused destructure / handler signatures).
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],

      // We use `require()` in this config file and a few CommonJS-y spots.
      // The TS compiler enforces import shape elsewhere.
      '@typescript-eslint/no-require-imports': 'off',

      // Empty functions show up as no-op handler stubs and default exports.
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
  {
    // Test files get a looser baseline.
    files: ['packages/*/test/**/*.ts', 'packages/*/src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
];
