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
    // The webapp, now that it is a file ESLint can read rather than a script
    // tag inside index.html. Same reasoning as plotterext above: it genuinely
    // runs in a browser, so declaring the environment is honest. `L` is
    // Leaflet, loaded from vendor/ by a separate tag before this one.
    files: ['public/app.js'],
    languageOptions: {
      globals: {
        document: 'readonly',
        window: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        localStorage: 'readonly',
        location: 'readonly',
        navigator: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        Image: 'readonly',
        Blob: 'readonly',
        URL: 'readonly',
        FormData: 'readonly',
        Headers: 'readonly',
        Response: 'readonly',
        AbortSignal: 'readonly',
        AbortController: 'readonly',
        DOMParser: 'readonly',
        XMLHttpRequest: 'readonly',
        requestAnimationFrame: 'readonly',
        getComputedStyle: 'readonly',
        TextDecoder: 'readonly',
        L: 'readonly',
      },
    },
    rules: {
      // Every one of these is `try { localStorage… } catch {}`. Storage throws
      // in private mode and when it is disabled, and there is nothing useful to
      // do about it, so the empty block is the intent rather than an omission.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Pre-existing, found the moment this file became lintable. Warnings, not
      // errors, matching how src/ already carries its no-explicit-any backlog:
      // two redundant regex escapes, and two `var btn = this` aliases in
      // non-arrow event handlers. Worth clearing, not worth blocking on, and
      // not something to fix in the same commit that turns linting on.
      'no-useless-escape': 'warn',
      '@typescript-eslint/no-this-alias': 'warn',
    },
  },
  {
    ignores: [
      'dist/**/*',
      'dist-test/**/*',
      'node_modules/**/*',
      // Third-party, and the world-countries GeoJSON. public/app.js is ours
      // and is linted — see the block above.
      'public/vendor/**/*',
      'public/*.json',
      // Local-only directories, also listed in .gitignore. Repeated here on
      // purpose: ESLint does not read .gitignore, and --ignore-path is not
      // available under flat config, so gitignoring them alone still leaves
      // `npm run lint` failing on a working machine while CI — which checks
      // out neither — stays green.
      'node-server/**/*',
      'scratch*/**',
      // Vendored JavaScript inside the Python virtualenv under backend/.
      '**/.venv/**',
    ],
  }
);
