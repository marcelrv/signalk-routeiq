// Node test reporter that guards against a run that ends early and still
// exits 0. It checks every test file named on the command line (a `*.test.js`
// argument) against its compiled source: each file must have reported at least
// as many tests as it declares (`it(`/`test(` calls; loops only add more), and
// none may be silent (a file with a skipped suite is only
// required to report something). Globs such as `dir/*.test.js` are expanded here.
// It prints one summary line and sets a failing exit code on a shortfall. Used next to the `spec` reporter, see the `test` scripts.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

const DECL = /^\s*(?:it|test)(?:\.(?:only|skip|todo))?\(/gm;
const GLOB_CHARS = /[*?]/;

// Turns the command line into test files. Flags are skipped; an entry with a
// `*` or `?` in its file name (`dir/*.test.js`) is expanded here, because a
// shell that does not expand it hands it over as is. Anything that cannot be
// resolved to a readable file is reported, never thrown.
function resolveTestFiles(argv, problems) {
  const files = [];
  for (const arg of argv) {
    if (arg.startsWith('-')) continue;
    if (!GLOB_CHARS.test(arg) && !/\.test\.js$/.test(arg)) continue;
    if (GLOB_CHARS.test(arg)) {
      const dir = dirname(arg);
      if (GLOB_CHARS.test(dir)) {
        problems.push(`cannot expand ${arg}: wildcards are only supported in the file name`);
        continue;
      }
      const re = new RegExp(
        `^${basename(arg)
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '[^/]*')
          .replace(/\?/g, '[^/]')}$`,
      );
      let names;
      try {
        names = readdirSync(dir).filter((n) => re.test(n) && /\.test\.js$/.test(n));
      } catch (error) {
        problems.push(`cannot expand ${arg}: ${error.message}`);
        continue;
      }
      if (names.length === 0) problems.push(`no test files match ${arg}`);
      for (const n of names.sort()) files.push(resolve(dir, n));
    } else {
      files.push(resolve(arg));
    }
  }
  return [...new Set(files)];
}

export default async function* countReporter(source) {
  // Leaf tests that ran (passed, failed or were skipped one by one).
  const executed = new Map();
  // Files that reported something: a leaf test, or a skipped suite.
  const active = new Set();
  // A skipped suite never reports its children, so a file holding one cannot be
  // held to its declared count (it must still report something). An
  // individually skipped test is already counted in `executed`.
  const hasSkippedSuite = new Set();
  for await (const { type, data } of source) {
    if ((type !== 'test:pass' && type !== 'test:fail') || !data.file) continue;
    if (data.details?.type === 'suite') {
      if (data.skip) {
        hasSkippedSuite.add(data.file);
        active.add(data.file);
      }
    } else {
      executed.set(data.file, (executed.get(data.file) ?? 0) + 1);
      active.add(data.file);
    }
  }
  const problems = [];
  const files = resolveTestFiles(process.argv, problems);
  let total = 0;
  let declared = 0;
  for (const f of files) {
    const n = executed.get(f) ?? 0;
    let d = 0;
    try {
      if (!statSync(f).isFile()) throw new Error('not a file');
      d = (readFileSync(f, 'utf8').match(DECL) ?? []).length;
    } catch (error) {
      problems.push(`cannot read ${f}: ${error.message}`);
      continue;
    }
    total += n;
    declared += d;
    if (!active.has(f)) problems.push(`no results from ${f}`);
    else if (n < d && !hasSkippedSuite.has(f)) problems.push(`${f}: ran ${n} of ${d} declared tests`);
  }
  if (files.length === 0) problems.push('no test files given');
  if (problems.length > 0) {
    process.exitCode = 1;
    yield `\ntest-count guard FAILED:\n  ${problems.join('\n  ')}\n`;
  } else {
    yield `\ntest-count guard ok: ${total} tests from ${files.length} files (${declared} declared)\n`;
  }
}
