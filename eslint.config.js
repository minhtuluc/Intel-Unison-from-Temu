import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
    },
    rules: {
      'no-var': 'error',
      'prefer-const': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-console': 'off',
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      // UT-011: showToast takes one options object. Passing a bare string first
      // destructured to an empty message and rendered a blank toast silently, so
      // the wrong shape is rejected at lint time rather than discovered in the UI.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'CallExpression[callee.name="showToast"] > Literal:first-child, ' +
            'CallExpression[callee.name="showToast"] > TemplateLiteral:first-child, ' +
            'CallExpression[callee.name="showToast"] > BinaryExpression:first-child',
          message: 'showToast expects a single options object: showToast({ message, type }).',
        },
      ],
    },
  },
  {
    files: ['public/sw.js'],
    languageOptions: { globals: { ...globals.serviceworker } },
  },
  {
    ignores: ['node_modules/', 'coverage/', 'temp/', '.temp/', 'dist/'],
  },
];
