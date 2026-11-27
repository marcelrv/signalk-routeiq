import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { CORE_VERSION } from '../dist/index.js';

describe('routeiq-core', () => {
  it('CORE_VERSION matches package.json', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    assert.strictEqual(CORE_VERSION, pkg.version);
  });
});
