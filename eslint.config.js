import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // No environment was ever declared, so every Node global in the helper
    // scripts read as an undefined variable — 20 no-undef errors for `process`,
    // `console` and `setTimeout` alone. `npm run lint` only covers src/, so
    // these never reached CI, but they made `eslint scripts/` useless and
    // misreported working code as broken. Browser globals are deliberately not
    // listed: page.evaluate() callbacks reach them through the element's own
    // `ownerDocument.defaultView`, which is what the scripts already do.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
  {
    ignores: ['dist/**/*', 'dist-test/**/*', 'node_modules/**/*', 'public/**/*'],
  }
);
