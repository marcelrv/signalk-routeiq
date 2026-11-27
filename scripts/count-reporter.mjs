// Node test reporter that guards against a run that ends early and still
// exits 0. It checks every test file named on the command line (a `*.test.js`
// argument) against its compiled source: each file must have reported at least
// as many tests as it declares (`it(`/`test(` calls; loops only add more), and
// none may be silent (a file with a skipped suite is only
// required to report something). It prints one summary line and sets a failing exit code
// on a shortfall. Used next to the `spec` reporter, see the `test` scripts.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DECL = /^\s*(?:it|test)(?:\.(?:only|skip|todo))?\(/gm;

export default async function* countReporter(source) {
  const executed = new Map();
  // A skipped suite never reports its children, so a file holding one cannot be
  // held to its declared count (it must still report something).
  const hasSkip = new Set();
  for await (const { type, data } of source) {
    if ((type === 'test:pass' || type === 'test:fail') && data.skip && data.file) {
      hasSkip.add(data.file);
    }
    if (
      (type === 'test:pass' || type === 'test:fail') &&
      data.details?.type !== 'suite' &&
      data.file
    ) {
      executed.set(data.file, (executed.get(data.file) ?? 0) + 1);
    }
  }
  const files = process.argv.filter((a) => /\.test\.js$/.test(a)).map((a) => resolve(a));
  const problems = [];
  let total = 0;
  let declared = 0;
  for (const f of files) {
    const n = executed.get(f) ?? 0;
    const d = (readFileSync(f, 'utf8').match(DECL) ?? []).length;
    total += n;
    declared += d;
    if (n === 0) problems.push(`no results from ${f}`);
    else if (n < d && !hasSkip.has(f)) problems.push(`${f}: ran ${n} of ${d} declared tests`);
  }
  if (files.length === 0) problems.push('no test files given');
  if (problems.length > 0) {
    process.exitCode = 1;
    yield `\ntest-count guard FAILED:\n  ${problems.join('\n  ')}\n`;
  } else {
    yield `\ntest-count guard ok: ${total} tests from ${files.length} files (${declared} declared)\n`;
  }
}
