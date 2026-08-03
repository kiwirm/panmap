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
  rules: {},
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
