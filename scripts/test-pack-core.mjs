// Pack contents check (`npm run test:pack-core`, after `npm run build`).
//
// routeiq-core is released as a tarball (see .github/workflows/release-core.yml).
// This runs `npm pack --dry-run --json` in the package and asserts that the
// tarball holds what an installer needs (entry point, typings, the two worker
// files the engine starts by path, docs, licence) and nothing that belongs to
// the repository only (sources, tests, compiled tests). Nothing is written.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pkgDir = fileURLToPath(new URL('../packages/routeiq-core/', import.meta.url));

const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
  cwd: pkgDir,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
});
const [packed] = JSON.parse(out);
const files = packed.files.map((f) => f.path);

const required = [
  'dist/index.js',
  'dist/index.d.ts',
  'dist/db-worker.js',
  'dist/worker-host.js',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'package.json',
];
for (const file of required) {
  assert.ok(files.includes(file), `the tarball must contain ${file}`);
}

const forbidden = [/^src\//, /^test\//, /^dist-test\//, /\.test\.(js|d\.ts)(\.map)?$/, /^tsconfig/];
for (const file of files) {
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(file), `the tarball must not contain ${file}`);
  }
}

// Everything is either one of the documented top-level files or under dist/.
for (const file of files) {
  assert.ok(file.startsWith('dist/') || required.includes(file), `unexpected file in the tarball: ${file}`);
}

console.log(`${packed.name}@${packed.version}: ${files.length} files, contents ok`);
