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
    // `ownerDocument.defaultView`, or through `globalThis`, so the Node
    // environment here never has to pretend a DOM exists.
    files: ['scripts/**/*.mjs', 'test/ui/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        URL: 'readonly',
      },
    },
  },
  {
    // The plotter extension really does run in a browser, so unlike the Node
    // test runners above it gets its globals declared outright — there is no
    // Node environment here being asked to pretend a DOM exists. It ships in
    // the npm package (see "files" in package.json) and was never linted,
    // because the lint script only ever covered src/.
    files: ['plotterext/**/*.js'],
    languageOptions: {
      globals: {
        document: 'readonly',
        window: 'readonly',
        fetch: 'readonly',
        Option: 'readonly',
        TextDecoder: 'readonly',
        AbortController: 'readonly',
      },
    },
  },
  {
    ignores: [
      'dist/**/*',
      'dist-test/**/*',
      'node_modules/**/*',
      // The webapp is 5,600 lines of JavaScript inline in index.html, which
      // ESLint cannot read without a plugin for script tags.
      'public/**/*',
      // Untracked local scratch. Absent from a CI checkout, but ESLint walks
      // the working tree and does not read .gitignore, so without these
      // `npm run lint` is unusable on a working machine even though CI is green.
      'node-server/**/*',
      'scratch*/**',
      // Vendored JavaScript inside the Python virtualenv under backend/.
      '**/.venv/**',
    ],
  }
);
