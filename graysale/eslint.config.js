import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

const commonRules = {
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
  'no-console': 'off',
  'no-empty': ['error', { allowEmptyCatch: true }],
};

export default [
  {
    ignores: [
      'node_modules/**',
      'web/node_modules/**',
      'web/dist/**',
      'src/data/**',
      'coverage/**',
      // Packaging artifacts: extracted portable Node runtime + staged builds.
      'dist/**',
    ],
  },
  js.configs.recommended,
  // Node backend (src/, test/)
  {
    files: ['src/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: commonRules,
  },
  // Ad-hoc operator scripts (scripts/*.mjs)
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: commonRules,
  },
  // React front-end (web/src/)
  {
    files: ['web/src/**/*.js', 'web/src/**/*.jsx'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: {
      react,
      'react-hooks': reactHooks,
    },
    rules: {
      ...commonRules,
      // Core no-unused-vars cannot see JSX usage; these two rules mark
      // components referenced from JSX as used.
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'off',
      ...reactHooks.configs.recommended.rules,
      // Too opinionated to gate CI on: warns locally, never fails the build.
      'react-hooks/exhaustive-deps': 'warn',
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          vars: 'local',
          caughtErrors: 'none',
        },
      ],
    },
  },
];
