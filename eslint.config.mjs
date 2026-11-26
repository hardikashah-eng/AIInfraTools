// Lint gate (CI: .github/workflows/lint.yml; locally: npm run lint after `npm install --no-save eslint@9 @eslint/js@9 globals@15`).
// ESLint's recommended rules: undefined names, unused code, unreachable blocks, duplicate keys, needless escapes.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['**/node_modules/**', 'skills/*/scripts/**', 'site/**', '**/dist/**'] },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node, ...globals.browser } },
    rules: {
      // arguments and caught errors document the shape of a call; an unused local or import is dead code
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  // the browser bundles and shared UMD modules are scripts, not ES modules
  { files: ['**/*.js'], languageOptions: { sourceType: 'script' } },
];
