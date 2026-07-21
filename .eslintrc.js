/**
 * ESLint configuration for production-grade Node.js code quality enforcement.
 */
module.exports = {
  env: {
    node: true,
    es2022: true,
  },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'commonjs',
  },
  extends: ['eslint:recommended'],
  rules: {
    'no-console': 'off',           // winston handles logging
    'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'no-var': 'error',
    'prefer-const': 'error',
    'eqeqeq': ['error', 'always'],
    'no-throw-literal': 'error',
    'handle-callback-err': 'error',
    'no-process-exit': 'off',      // intentional in entry points
    'consistent-return': 'warn',
    'no-await-in-loop': 'off',     // intentional in polling loops
  },
  ignorePatterns: ['node_modules/', 'dist/'],
};
