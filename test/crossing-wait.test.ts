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
  const waitSeconds = (crossings: unknown[], config = {}, segments?: unknown[]) => {
    const engine = Object.create(RoutingEngine.prototype) as {
      _config: unknown;
      crossingWaitSeconds: (c: unknown[], s?: unknown[]) => number;
    };
    engine._config = { ...DEFAULT_CONFIG, ...config };
    return engine.crossingWaitSeconds(crossings, segments);
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

  it('counts a lock complex once, not once per chamber', () => {
    // Krammersluizen is four chambers side by side; the POI index has one entry
    // each and the route passes through exactly one of them.
    const chambers = [0, 40, 80, 120].map((m) => lock({ distanceFromStart: m }));
    assert.strictEqual(waitSeconds(chambers), 3600);
  });

  it('counts an opening and a fixed span over the same cut once', () => {
    // Middelburg: Stationsbrug exists as both, carrying different roads.
    const pair = [
      opening({ distanceFromStart: 1000 }),
      fixed({ distanceFromStart: 1030 }),
    ];
    assert.strictEqual(waitSeconds(pair), 1800);
    // and the other way round, so ordering cannot change the answer
    assert.strictEqual(waitSeconds([...pair].reverse()), 1800);
  });

  it('lets a lock absorb the span over its own head', () => {
    // Zandkreeksluis: the lock, the bridge over its outer head, and the next
    // span, all within a couple of hundred metres.
    const complex = [
      opening({ distanceFromStart: 0 }),
      lock({ distanceFromStart: 80 }),
      opening({ distanceFromStart: 190 }),
    ];
    assert.strictEqual(waitSeconds(complex), 3600);
  });

  it('keeps genuinely separate crossings separate', () => {
    // Two locks a mile apart are two lockings.
    assert.strictEqual(
      waitSeconds([lock({ distanceFromStart: 0 }), lock({ distanceFromStart: 1852 })]),
      2 * 3600,
    );
    // Just beyond the grouping distance stays separate.
    assert.strictEqual(
      waitSeconds([opening({ distanceFromStart: 0 }), opening({ distanceFromStart: 251 })]),
      2 * 1800,
    );
  });

  it('groups a run of fixed spans into no wait at all', () => {
    const stack = [0, 0, 0].map((m) => fixed({ distanceFromStart: m }));
    assert.strictEqual(waitSeconds(stack), 0);
  });

  it('uses the locks the route actually traversed when the database says', () => {
    // Three POIs for parallel chambers, but the edges name one lock: one
    // locking, not three, and not the grouped guess either.
    const chambers = [0, 40, 80].map((m) => lock({ distanceFromStart: m }));
    const segments = [{ lockIds: [7] }, {}, { lockIds: [7] }];
    assert.strictEqual(waitSeconds(chambers, {}, segments), 3600);
  });

  it('counts distinct traversed locks, not lock edges', () => {
    // A lock spans a dozen edges; that is still one locking.
    const segments = [{ lockIds: [5] }, { lockIds: [5] }, { lockIds: [9] }, { lockIds: [9] }];
    assert.strictEqual(waitSeconds([], {}, segments), 2 * 3600);
  });

  it('still charges opening bridges when the locks are known', () => {
    // Edge data covers locks only; no schema marks an opening span, so those
    // stay proximity-based even on a database that knows its locks.
    const crossings = [lock({ distanceFromStart: 0 }), opening({ distanceFromStart: 5000 })];
    assert.strictEqual(waitSeconds(crossings, {}, [{ lockIds: [3] }]), 3600 + 1800);
  });

  it('falls back to the crossing list when the database has no lock data', () => {
    // nv-chart has no lock_id column at all: segments carry nothing.
    const crossings = [lock({ distanceFromStart: 0 })];
    assert.strictEqual(waitSeconds(crossings, {}, [{}, {}]), 3600);
    assert.strictEqual(waitSeconds(crossings, {}, undefined), 3600);
  });

  it('is unbothered by nothing to wait for', () => {
    assert.strictEqual(waitSeconds([]), 0);
    assert.strictEqual(waitSeconds(undefined as never), 0);
    // a bridge with no subtype is not known to open, so it costs nothing
    assert.strictEqual(waitSeconds([{ type: 'bridge', name: 'unclassified' }]), 0);
  });
});
