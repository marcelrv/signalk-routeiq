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
  const schedule = (crossings: unknown[], config = {}, segments?: unknown[]) => {
    const engine = Object.create(RoutingEngine.prototype) as {
      _config: unknown;
      crossingWaitSchedule: (
        coords: unknown[],
        s: unknown[],
        c?: unknown[],
      ) => Array<{ atMetres: number; seconds: number }>;
    };
    engine._config = { ...DEFAULT_CONFIG, ...config };
    const segs = (segments ?? []) as Array<{ distance?: number }>;
    // One coordinate per segment boundary; the helper only needs them to place
    // crossings that arrive without a chainage of their own.
    const coords = segs.map((_, i) => [4 + i * 0.001, 51] as [number, number]);
    coords.push([4 + segs.length * 0.001, 51]);
    return engine.crossingWaitSchedule(coords, segs, crossings);
  };
  const waitSeconds = (crossings: unknown[], config = {}, segments?: unknown[]) =>
    schedule(crossings, config, segments).reduce((t, w) => t + w.seconds, 0);

  const pos = { latitude: 51, longitude: 4 };
  const lock = (extra = {}) => ({ type: 'lock', name: 'A lock', position: pos, ...extra });
  const opening = (extra = {}) => ({ type: 'bridge', subtype: 'opening', name: 'A span', position: pos, ...extra });
  const fixed = (extra = {}) => ({ type: 'bridge', subtype: 'fixed', name: 'A span', height: 12, position: pos, ...extra });

  /** Spread crossings a mile apart so each is its own obstacle. */
  const apart = (...cs: Array<(e?: object) => object>) =>
    cs.map((make, i) => make({ distanceFromStart: i * 1852 }));

  it('defaults to an hour per lock and half an hour per opening bridge', () => {
    assert.strictEqual(DEFAULT_CONFIG.lockWaitMinutes, 60);
    assert.strictEqual(DEFAULT_CONFIG.bridgeWaitMinutes, 30);
    assert.strictEqual(waitSeconds([lock()]), 3600);
    assert.strictEqual(waitSeconds([opening()]), 1800);
  });

  it('charges nothing for a fixed span', () => {
    assert.strictEqual(waitSeconds([fixed()]), 0);
    // and a fixed span alongside real waits does not inflate them
    assert.strictEqual(waitSeconds(apart(fixed, lock, fixed)), 3600);
  });

  it('adds up over a route', () => {
    // Two locks and three opening spans: 2h + 1h30.
    const route = apart(lock, opening, fixed, opening, lock, opening);
    assert.strictEqual(waitSeconds(route), 2 * 3600 + 3 * 1800);
  });

  it('follows the configured values', () => {
    assert.strictEqual(waitSeconds([lock()], { lockWaitMinutes: 20 }), 1200);
    assert.strictEqual(waitSeconds([opening()], { bridgeWaitMinutes: 5 }), 300);
    // zero is a legitimate setting — a canal with permanently open spans
    assert.strictEqual(waitSeconds(apart(lock, opening), { lockWaitMinutes: 0, bridgeWaitMinutes: 0 }), 0);
  });

  it('lets a per-crossing figure from the database win', () => {
    assert.strictEqual(waitSeconds([lock({ waitMinutes: 15 })]), 900);
    assert.strictEqual(waitSeconds([opening({ waitMinutes: 90 })]), 5400);
    // mixed: one known lock at 15 min, one unknown falling back to the default
    assert.strictEqual(waitSeconds([lock({ waitMinutes: 15, distanceFromStart: 0 }), lock({ distanceFromStart: 1852 })]), 900 + 3600);
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
    const segments = [{ distance: 0, lockIds: [7] }, { distance: 40 }, { distance: 40, lockIds: [7] }];
    assert.strictEqual(waitSeconds(chambers, {}, segments), 3600);
  });

  it('counts distinct traversed locks, not lock edges', () => {
    // A lock spans a dozen edges; that is still one locking.
    // The gap has to sit on the segment *before* lock 9 starts: a marker is
    // placed at the chainage where its first edge begins.
    const segments = [{ distance: 100, lockIds: [5] }, { distance: 5000, lockIds: [5] },
                      { distance: 100, lockIds: [9] }, { distance: 100, lockIds: [9] }];
    assert.strictEqual(waitSeconds([], {}, segments), 2 * 3600);
  });

  it('absorbs the bridge over a lock head from either direction', () => {
    // Krammersluizen: the N-257 span sits over the far head. Entering from one
    // side it is ~100 m from where the lock edges start, from the other ~320 m
    // — so grouping from the lock's entry point charged the bridge on top of
    // the lock depending only on which way you were going.
    const segments = [{ distance: 200, lockIds: [7] }, { distance: 120, lockIds: [7] }];
    assert.strictEqual(
      waitSeconds([opening({ distanceFromStart: 360 })], {}, segments),
      3600,
    );
  });

  it('keeps a staircase lock counted as two lockings', () => {
    // Distinct lock ids sharing a head: the spans abut, but the edge data has
    // already said these are two lockings, so a span must not swallow a lock.
    const segments = [{ distance: 300, lockIds: [1] }, { distance: 300, lockIds: [2] }];
    assert.strictEqual(waitSeconds([], {}, segments), 2 * 3600);
  });

  it('still charges opening bridges when the locks are known', () => {
    // Edge data covers locks only; no schema marks an opening span, so those
    // stay proximity-based even on a database that knows its locks.
    const crossings = [lock({ distanceFromStart: 0 }), opening({ distanceFromStart: 5000 })];
    assert.strictEqual(waitSeconds(crossings, {}, [{ distance: 0, lockIds: [3] }]), 3600 + 1800);
  });

  it('falls back to the crossing list when the database has no lock data', () => {
    // nv-chart has no lock_id column at all: segments carry nothing.
    const crossings = [lock({ distanceFromStart: 0 })];
    assert.strictEqual(waitSeconds(crossings, {}, [{}, {}]), 3600);
    assert.strictEqual(waitSeconds(crossings, {}, undefined), 3600);
  });

  it('lets a lock swallow the bridge over it, however the lock was found', () => {
    // At most locks a span or two carries a road over the chamber, and it opens
    // with the lock — no extra wait. This is the case where the lock is known
    // only from the edges and the bridge only from the points of interest, so
    // they must still land in the same group.
    const crossings = [opening({ distanceFromStart: 60, name: 'bridge over the lock' })];
    const segments = [{ distance: 50, lockIds: [9] }, { distance: 500 }];
    assert.strictEqual(waitSeconds(crossings, {}, segments), 3600);
  });

  it('does not charge a lock twice when both the edges and a POI name it', () => {
    const crossings = [lock({ distanceFromStart: 30 })];
    const segments = [{ distance: 20, lockIds: [9] }, { distance: 900 }];
    assert.strictEqual(waitSeconds(crossings, {}, segments), 3600);
  });

  it('still charges a bridge that is nowhere near the lock', () => {
    const crossings = [opening({ distanceFromStart: 4000 })];
    const segments = [{ distance: 0, lockIds: [9] }, { distance: 8000 }];
    assert.strictEqual(waitSeconds(crossings, {}, segments), 3600 + 1800);
  });

  it('records the charged wait on the crossing that owns the group', () => {
    // The itinerary reads this to show where the time goes, so exactly one
    // crossing per group carries it — otherwise an expanded route double-counts.
    const bridge = opening({ distanceFromStart: 1000 });
    const span = fixed({ distanceFromStart: 1020 });
    const cs = [bridge, span];
    schedule(cs);
    assert.strictEqual((bridge as { waitSeconds?: number }).waitSeconds, 1800);
    assert.strictEqual((span as { waitSeconds?: number }).waitSeconds, undefined);
  });

  it('gives the wait to the lock, not to the bridge it absorbs', () => {
    const theLock = lock({ distanceFromStart: 1000 });
    const itsBridge = opening({ distanceFromStart: 1060 });
    schedule([theLock, itsBridge]);
    assert.strictEqual((theLock as { waitSeconds?: number }).waitSeconds, 3600);
    assert.strictEqual((itsBridge as { waitSeconds?: number }).waitSeconds, undefined);
  });

  it('adds a lock the edges knew about to the crossing list', () => {
    // Otherwise an hour appears in the total with nothing in the itinerary to
    // explain it.
    const cs: Array<Record<string, unknown>> = [];
    schedule(cs, {}, [{ distance: 500, lockIds: [4] }, { distance: 500 }]);
    assert.strictEqual(cs.length, 1, 'the lock was added');
    assert.strictEqual(cs[0].type, 'lock');
    assert.strictEqual(cs[0].waitSeconds, 3600);
  });

  it('is unbothered by nothing to wait for', () => {
    assert.strictEqual(waitSeconds([]), 0);
    // a bridge with no subtype is not known to open, so it costs nothing
    assert.strictEqual(
      waitSeconds([{ type: 'bridge', name: 'unclassified', position: pos }]),
      0,
    );
  });
});

describe('a wait moves the tide clock, not just the total', () => {
  /**
   * The point of placing waits rather than summing them: an hour in a lock puts
   * every later leg an hour further into the tide. A flow field that reverses
   * on a known schedule makes that visible — sample it too early and the legs
   * after the lock get the wrong current, and the arrival time is wrong by more
   * than the wait itself.
   */
  const annotate = (waits: Array<{ atMetres: number; seconds: number }>) => {
    const engine = Object.create(RoutingEngine.prototype) as {
      _config: unknown;
      annotateSegmentTimes: (
        coords: unknown[], segs: unknown[], env: unknown, off: number,
        w?: Array<{ atMetres: number; seconds: number }>,
      ) => number;
      toRadians: (d: number) => number;
    };
    engine._config = { ...DEFAULT_CONFIG };
    engine.toRadians = (d: number) => (d * Math.PI) / 180;

    const sampledAt: number[] = [];
    const departureMs = Date.parse('2026-08-03T00:00:00Z');
    const env = {
      departureMs,
      speedMs: 3,           // ~5.8 kn
      flow: {
        estimated: true, source: 'test', stations: [],
        sample: (_lat: number, _lon: number, atMs: number) => {
          sampledAt.push((atMs - departureMs) / 3_600_000); // ms -> hours
          return { u: 0, v: 0 };   // no push either way; we only watch the clock
        },
      },
    };
    // Three legs of 3 km each, due east.
    const coords = [[4.0, 51.0], [4.043, 51.0], [4.086, 51.0], [4.129, 51.0]];
    const segs = [{ distance: 3000 }, { distance: 3000 }, { distance: 3000 }];
    const total = engine.annotateSegmentTimes(coords, segs, env, 0, waits);
    return { total, sampledAt };
  };

  it('samples later legs after the wait has been spent', () => {
    const none = annotate([]);
    // A one-hour lock 3 km along: met after leg 1, before leg 2.
    const withLock = annotate([{ atMetres: 3000, seconds: 3600 }]);

    assert.strictEqual(none.sampledAt.length, 3);
    assert.strictEqual(withLock.sampledAt.length, 3);
    // Leg 1 is before the lock — unchanged.
    assert.ok(Math.abs(withLock.sampledAt[0] - none.sampledAt[0]) < 1e-9,
      'the leg before the lock samples at the same time');
    // Legs 2 and 3 are after it — each an hour later than before.
    for (const i of [1, 2]) {
      const shift = withLock.sampledAt[i] - none.sampledAt[i];
      assert.ok(Math.abs(shift - 1) < 1e-6,
        `leg ${i + 1} samples an hour later (shifted ${shift.toFixed(4)} h)`);
    }
    // And the wait is in the total exactly once.
    assert.ok(Math.abs((withLock.total - none.total) - 3600) < 1e-6);
  });

  it('spends a wait at the destination without sampling past it', () => {
    const end = annotate([{ atMetres: 999999, seconds: 1800 }]);
    const none = annotate([]);
    assert.deepStrictEqual(end.sampledAt, none.sampledAt,
      'a wait after the last leg shifts no sample');
    assert.ok(Math.abs((end.total - none.total) - 1800) < 1e-6);
  });
});
