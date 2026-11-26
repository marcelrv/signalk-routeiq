// Runs from dist-test/, so the package root is one level up.
// Core must run on node built-ins alone: its compiled output may import only
// `node:*` modules and files inside its own dist/. Catches a third-party or
// plugin import that slips past the lint rule (e.g. through a dynamic import).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(pkgRoot, "dist");

function jsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...jsFiles(full));
    else if (name.endsWith(".js")) out.push(full);
  }
  return out;
}

// Static imports and re-exports start a line (tsc emits them that way), which
// keeps prose in comments and strings ("... from "unknown" into ...") out.
const SPECIFIER_PATTERNS = [
  /^\s*(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']/gm,
  /^\s*import\s*["']([^"']+)["']/gm,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function specifiers(source: string): string[] {
  const found: string[] = [];
  for (const re of SPECIFIER_PATTERNS) {
    for (const m of source.matchAll(re)) found.push(m[1]);
  }
  return found;
}

test("core's compiled output imports only node built-ins and its own files", () => {
  const files = jsFiles(distDir);
  assert.ok(files.length > 0, "dist/ is empty, build core first");
  const offenders: string[] = [];
  for (const file of files) {
    for (const spec of specifiers(readFileSync(file, "utf8"))) {
      if (spec.startsWith("node:")) continue;
      if (spec.startsWith("./") || spec.startsWith("../")) {
        const rel = relative(distDir, resolve(dirname(file), spec));
        if (!rel.startsWith("..") && !rel.startsWith(sep)) continue;
      }
      offenders.push(`${relative(pkgRoot, file)}: ${spec}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("core's package.json declares no runtime dependencies", () => {
  const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
  assert.equal(pkg.dependencies, undefined);
});
