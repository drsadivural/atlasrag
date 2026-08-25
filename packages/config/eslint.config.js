import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import globals from 'globals';

/** Files that are never linted, anywhere in the monorepo. */
export const ignores = [
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/node_modules/**',
  '**/.venv/**',
  '**/.wrangler/**',
  '**/playwright-report/**',
  '**/test-results/**',
  '**/storybook-static/**',
  '**/drizzle/**',
  'artifacts/**',
  'docs/product/**',
  // Local throwaway scripts; gitignored and never shipped.
  '.scratch/**',
  '**/*.d.ts',
];

/**
 * Rules that encode the product's non-negotiables:
 *  - no `any` leaking through the evidence/citation path,
 *  - no raw `dangerouslySetInnerHTML` in the web app (document text is untrusted),
 *  - configuration is read through the env module so Workers builds stay portable.
 */
const sharedRules = {
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/no-unused-vars': [
    'error',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
  ],
  '@typescript-eslint/consistent-type-imports': [
    'error',
    { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
  ],
  '@typescript-eslint/no-non-null-assertion': 'error',
  eqeqeq: ['error', 'smart'],
  'no-console': ['error', { allow: ['warn', 'error'] }],
};

export const baseConfig = tseslint.config(js.configs.recommended, ...tseslint.configs.recommended, {
  languageOptions: {
    ecmaVersion: 2023,
    sourceType: 'module',
    globals: { ...globals.node, ...globals.es2023 },
  },
  rules: sharedRules,
});

export const reactRules = {
  files: ['**/*.tsx'],
  plugins: { 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
  languageOptions: { globals: { ...globals.browser } },
  rules: {
    ...reactHooks.configs.recommended.rules,
    ...jsxA11y.flatConfigs.recommended.rules,
    // Screen-reader correctness is an acceptance requirement, not a suggestion.
    'jsx-a11y/label-has-associated-control': ['error', { assert: 'either' }],
    'no-restricted-syntax': [
      'error',
      {
        selector: 'JSXAttribute[name.name="dangerouslySetInnerHTML"]',
        message: 'Document text is untrusted. Render it as text, never as HTML.',
      },
    ],
  },
};

/** Relaxations for config files, scripts, seeds and tests. */
export const toolingOverrides = {
  files: [
    '**/*.config.{ts,js,mts,mjs,cts}',
    '**/scripts/**',
    '**/tests/**',
    '**/*.test.{ts,tsx}',
    '**/*.spec.{ts,tsx}',
    '**/src/env.ts',
    '**/seed.ts',
    // Command-line entry points whose output IS their user interface.
    '**/src/migrate.ts',
    '**/src/reset.ts',
  ],
  rules: {
    'no-console': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-non-null-assertion': 'off',
  },
};

export default baseConfig;
