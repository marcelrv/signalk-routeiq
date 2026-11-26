// Bundles the plugin into dist/ (run by `npm run build`, after `tsc` has
// type-checked src/ into dist-tsc/ and routeiq-core has been built).
//
// Layout stays flat, dist/*.js, because several modules locate files relative
// to their own URL:
//   src/index.ts          dist/.. is the plugin root
//   src/provider.ts       ../package.json
//   src/plotterext.ts     createRequire(import.meta.url)
//   core sqlite-worker-store.ts  db-worker.js next to the module that starts it
//   core engine-client.ts        worker-host.js next to the module that starts it
// db-worker is a second entry point (taken from routeiq-core's sources) so it
// exists as dist/db-worker.js (worker-host is a third, for EngineClient), and sqlite-worker-store.ts (inlined into
// dist/index.js) finds it in the same directory.
//
// External: node built-ins and the root package's runtime dependencies.
// routeiq-core is a workspace package, not a dependency, and is inlined, so the published
// package needs nothing from a registry beyond its own dependencies.
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build, context } from 'esbuild';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {}).flatMap((name) => [
  name,
  `${name}/*`,
]);

rmSync(new URL('dist', root), { recursive: true, force: true });

const options = {
  absWorkingDir: fileURLToPath(root),
  entryPoints: {
    index: 'src/index.ts',
    'db-worker': 'packages/routeiq-core/src/db-worker.ts',
    'worker-host': 'packages/routeiq-core/src/worker-host.ts',
  },
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  external: ['node:*', ...external],
  logLevel: 'info',
};

// --watch: rebuild dist/ on every change to src/ or routeiq-core's dist/ (used
// by `npm run build:watch`; type-checking is left to `tsc --watch`).
if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('watching for changes');
} else {
  await build(options);
}
