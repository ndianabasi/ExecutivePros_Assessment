import eslint from '@eslint/js'
import globals from 'globals'
import jsdoc from 'eslint-plugin-jsdoc'
import tseslint from 'typescript-eslint'

const sourceFiles = ['services/*/src/**/*.{js,jsx,cjs,mjs,ts,tsx}']

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/test-results/**',
      '**/playwright-report/**',
      'services/frontend/src/vite-env.d.ts',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: sourceFiles,
    languageOptions: {
      globals: globals.node,
    },
    plugins: { jsdoc },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { args: 'all', argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }],
      'arrow-body-style': ['error', 'always'],
      curly: ['error', 'all'],
      eqeqeq: ['error', 'always'],
      'no-console': ['warn', { allow: ['error', 'warn'] }],
      'no-control-regex': 'off',
      'no-var': 'error',
      'object-shorthand': ['error', 'always'],
      'prefer-const': 'error',
      'jsdoc/require-jsdoc': ['error', {
        contexts: ['FunctionDeclaration', 'ClassDeclaration', 'MethodDefinition'],
        enableFixer: false,
        exemptEmptyConstructors: false,
      }],
      'jsdoc/require-description': 'error',
    },
  },
  {
    files: ['services/frontend/src/**/*.{js,jsx,ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
)
