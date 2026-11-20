// Bundles the plugin into dist/ (run by `npm run build`, after `tsc` has
// type-checked src/ into dist-tsc/ and routeiq-core has been built).
//
// Layout stays flat, dist/*.js, because several modules locate files relative
// to their own URL:
//   src/index.ts          dist/.. is the plugin root
//   src/passage-profile.ts  ../package.json
//   src/plotterext.ts     createRequire(import.meta.url)
//   src/database.ts       db-worker.js next to the module that starts it
// db-worker is a second entry point so it exists as dist/db-worker.js, and
// database.ts (inlined into dist/index.js) finds it in the same directory.
//
// External: node built-ins and the root package's runtime dependencies.
// routeiq-core is a workspace devDependency and is inlined, so the published
// package needs nothing from a registry beyond its own dependencies.
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {}).flatMap((name) => [
  name,
  `${name}/*`,
]);

rmSync(new URL('dist', root), { recursive: true, force: true });

await build({
  absWorkingDir: fileURLToPath(root),
  entryPoints: { index: 'src/index.ts', 'db-worker': 'src/db-worker.ts' },
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  external: ['node:*', ...external],
  logLevel: 'info',
});
