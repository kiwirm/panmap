module.exports = {
  env: {
    node: true,
    es2019: true,
  },
  extends: ['standard', 'prettier'],
  globals: {},
  parserOptions: {
    ecmaFeatures: {},
    sourceType: 'module',
  },
  plugins: [],
  rules: {
    // House convention: named `function` declarations (hoisted, better stack
    // traces, TS overloads); arrow functions stay allowed for callbacks and
    // const helpers. Bans stray `const x = function () {}` expressions.
    'func-style': ['error', 'declaration', { allowArrowFunctions: true }],
  },
  settings: {},
  overrides: [
    {
      files: ['*.ts', '**/*.ts'],
      parser: '@typescript-eslint/parser',
      plugins: ['@typescript-eslint'],
      parserOptions: {
        sourceType: 'module',
      },
      rules: {
        'no-use-before-define': 'off',
      },
    },
  ],
}
