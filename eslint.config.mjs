// Root ESLint (flat config, ESLint 9). Non-type-checked TS rules keep it fast
// and low-noise; React-hooks rules guard the web app. Prettier owns formatting.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.d.ts',
      'packages/contracts/**', // Solidity + forge, not JS/TS-linted here
      'apps/web/scripts/**', // one-off screenshot tooling
      'e2e/**', // standalone audit harness (mixed browser/node globals, run via node/playwright — not app code)
      'simulation/**', // standalone bot-sim harness (Phase 4, run via node/tsx — not app code)
      'apps/server/scripts/*.cjs', // ops probes shipped raw over ssh (plain-node CJS, not app code)
      '**/*.config.{js,mjs,cjs,ts}',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Web app: browser globals + React hooks correctness.
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // Server / engine / shared / scripts: Node globals.
    files: ['apps/server/**/*.ts', 'packages/**/*.ts', 'scripts/**/*.ts', '**/*.test.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // Service worker: ServiceWorker + browser globals (self, caches, fetch…).
    files: ['apps/web/public/**/*.js'],
    languageOptions: { globals: { ...globals.serviceworker, ...globals.browser } },
  },
);
