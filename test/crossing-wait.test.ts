/**
 * Waiting time at locks and opening bridges.
 *
 * The rule worth pinning is which crossings cost time and which do not: a lock
 * always does, an opening span does, and a fixed span never does — you either
 * fit under it or the route should not be crossing it. And that a per-crossing
 * figure from the database beats the configured default, since that is the
 * extension point the pipeline is expected to use.
 */
import assert from 'node:assert';
import { describe, it } from 'node:test';
import { RoutingEngine } from '../dist/routing.js';
import { DEFAULT_CONFIG } from '../dist/types.js';

describe('crossing wait time', () => {
  /**
   * Reach the wait calculation without standing up a database. `config` is a
   * getter over `_config`, so the backing field is what has to be set.
   */
  const waitSeconds = (crossings: unknown[], config = {}) => {
    const engine = Object.create(RoutingEngine.prototype) as {
      _config: unknown;
      crossingWaitSeconds: (c: unknown[]) => number;
    };
    engine._config = { ...DEFAULT_CONFIG, ...config };
    return engine.crossingWaitSeconds(crossings);
  };

  const lock = (extra = {}) => ({ type: 'lock', name: 'A lock', ...extra });
  const opening = (extra = {}) => ({ type: 'bridge', subtype: 'opening', name: 'A span', ...extra });
  const fixed = (extra = {}) => ({ type: 'bridge', subtype: 'fixed', name: 'A span', height: 12, ...extra });

  it('defaults to an hour per lock and half an hour per opening bridge', () => {
    assert.strictEqual(DEFAULT_CONFIG.lockWaitMinutes, 60);
    assert.strictEqual(DEFAULT_CONFIG.bridgeWaitMinutes, 30);
    assert.strictEqual(waitSeconds([lock()]), 3600);
    assert.strictEqual(waitSeconds([opening()]), 1800);
  });

  it('charges nothing for a fixed span', () => {
    assert.strictEqual(waitSeconds([fixed()]), 0);
    // and a fixed span alongside real waits does not inflate them
    assert.strictEqual(waitSeconds([fixed(), lock(), fixed()]), 3600);
  });

  it('adds up over a route', () => {
    // Two locks and three opening spans: 2h + 1h30.
    const route = [lock(), opening(), fixed(), opening(), lock(), opening()];
    assert.strictEqual(waitSeconds(route), 2 * 3600 + 3 * 1800);
  });

  it('follows the configured values', () => {
    assert.strictEqual(waitSeconds([lock()], { lockWaitMinutes: 20 }), 1200);
    assert.strictEqual(waitSeconds([opening()], { bridgeWaitMinutes: 5 }), 300);
    // zero is a legitimate setting — a canal with permanently open spans
    assert.strictEqual(waitSeconds([lock(), opening()], { lockWaitMinutes: 0, bridgeWaitMinutes: 0 }), 0);
  });

  it('lets a per-crossing figure from the database win', () => {
    assert.strictEqual(waitSeconds([lock({ waitMinutes: 15 })]), 900);
    assert.strictEqual(waitSeconds([opening({ waitMinutes: 90 })]), 5400);
    // mixed: one known lock at 15 min, one unknown falling back to the default
    assert.strictEqual(waitSeconds([lock({ waitMinutes: 15 }), lock()]), 900 + 3600);
    // a fixed span stays free even if the database puts a figure on it
    assert.strictEqual(waitSeconds([fixed({ waitMinutes: 45 })]), 0);
  });

  it('is unbothered by nothing to wait for', () => {
    assert.strictEqual(waitSeconds([]), 0);
    assert.strictEqual(waitSeconds(undefined as never), 0);
    // a bridge with no subtype is not known to open, so it costs nothing
    assert.strictEqual(waitSeconds([{ type: 'bridge', name: 'unclassified' }]), 0);
  });
});
