import assert from 'node:assert';
import { describe, it } from 'node:test';
import { coerceVesselDimension, pickVesselDimensions, validateRequestConstraints } from '../dist/api.js';

// Vessel dimensions reach the engine from two directions — PUT /vessel (the
// server-wide defaults) and per-request overrides on POST /route — and both
// used to be applied verbatim from req.body.
//
// The failure that motivates these tests is silent, not loud: getEdgePenalty
// tests `edge.min_depth < draft + safetyMarginDraft`. With a *string* draft
// that sum is a string, every comparison against it is NaN-false, and no edge
// is ever "too shallow" — the depth constraint disappears without an error,
// a log line, or a route warning. A negative draft does the same by putting
// the threshold below every real depth. Numbers that are merely absent are
// fine: the engine falls back to its own defaults via `dims.draft || 2.0`.
//
// So an unusable dimension must never survive into the engine — but on a
// routing request it must not sink the request either (see the last describe):
// it is dropped, and reported as a route warning instead.

describe('vessel dimension coercion', () => {
  it('takes a number as meters', () => {
    assert.strictEqual(coerceVesselDimension(2), 2);
    assert.strictEqual(coerceVesselDimension(0), 0);
  });

  it('parses a dimension that was stored as text', () => {
    assert.strictEqual(coerceVesselDimension('2'), 2);
    assert.strictEqual(coerceVesselDimension(' 2.4 '), 2.4);
  });

  it('unwraps the Signal K design.draft shapes', () => {
    // design.draft's *value* is an object, not a scalar — a client reading
    // vessels/self directly gets {maximum, minimum, current}, and a delta
    // wraps that again in {value: ...}.
    assert.strictEqual(coerceVesselDimension({ maximum: 2 }), 2);
    assert.strictEqual(coerceVesselDimension({ value: { maximum: 2 } }), 2);
    assert.strictEqual(coerceVesselDimension({ value: 2 }), 2);
    assert.strictEqual(coerceVesselDimension({ current: 1.9 }), 1.9);
    assert.strictEqual(coerceVesselDimension({ value: { maximum: '2' } }), 2);
  });

  it('refuses anything it cannot read as a number', () => {
    for (const bad of ['', '  ', '2 meters', {}, { minimum: 1 }, [], true, NaN, Infinity]) {
      assert.strictEqual(
        coerceVesselDimension(bad), undefined,
        `expected ${JSON.stringify(bad)} to be unusable`,
      );
    }
  });
});

describe('vessel dimension validation', () => {
  it('accepts a well-formed set of dimensions', () => {
    const result = pickVesselDimensions({ draft: 2.1, beam: 4, airDraft: 18 });
    assert.ok(!('error' in result));
    assert.deepStrictEqual(result.dims, { draft: 2.1, beam: 4, airDraft: 18 });
  });

  it('accepts a numeric string but not a unit-suffixed one', () => {
    const ok = pickVesselDimensions({ draft: '2' });
    assert.ok(!('error' in ok));
    assert.deepStrictEqual(ok.dims, { draft: 2 });

    const bad = pickVesselDimensions({ draft: '2 meters' });
    assert.ok('error' in bad);
    assert.match(bad.error, /draft/);
  });

  it('rejects NaN, Infinity and negative dimensions', () => {
    for (const bad of [NaN, Infinity, -Infinity, -10]) {
      const result = pickVesselDimensions({ airDraft: bad });
      assert.ok('error' in result, `expected ${bad} to be rejected`);
    }
  });

  it('rejects implausibly large dimensions', () => {
    const result = pickVesselDimensions({ draft: 5000 });
    assert.ok('error' in result);
  });

  it('treats null and undefined as "not supplied" instead of clobbering', () => {
    // setVesselDimensions spreads the result over the current dimensions, and
    // a spread copies explicitly-present undefined keys — so an omitted
    // dimension must be absent from the object, not present-and-undefined.
    const result = pickVesselDimensions({ draft: 2.5, beam: null, airDraft: undefined });
    assert.ok(!('error' in result));
    assert.deepStrictEqual(Object.keys(result.dims), ['draft']);
  });

  it('rejects non-object bodies without throwing', () => {
    for (const body of [undefined, null, 'draft=2'] as unknown[]) {
      const result = pickVesselDimensions(body as Record<string, unknown>);
      assert.ok(!('error' in result));
      assert.deepStrictEqual(result.dims, {});
    }
  });
});

describe('routing request constraint validation', () => {
  const req = (extra: Record<string, unknown>) => ({
    start: { latitude: 52, longitude: 4 },
    end: { latitude: 52.1, longitude: 4.1 },
    ...extra,
  }) as any;

  it('passes a clean request through untouched', () => {
    const request = req({ draft: 1.8, minCoastDistance: 0.5 });
    const result = validateRequestConstraints(request);
    assert.strictEqual(result.error, null);
    assert.deepStrictEqual(result.warnings, []);
    assert.strictEqual(request.draft, 1.8);
    assert.strictEqual(request.minCoastDistance, 0.5);
  });

  it('reads the vessel-override shapes a client may send', () => {
    const request = req({ draft: '2', beam: { value: { maximum: 4 } }, airDraft: 18 });
    const result = validateRequestConstraints(request);
    assert.strictEqual(result.error, null);
    assert.deepStrictEqual(result.warnings, []);
    assert.strictEqual(request.draft, 2);
    assert.strictEqual(request.beam, 4);
    assert.strictEqual(request.airDraft, 18);
  });

  it('warns and routes on rather than failing when a dimension is unusable', () => {
    // The whole point: a bad draft used to 400 the request, so the boat got no
    // route at all. It must now be dropped — dropped, not zeroed, so the
    // engine's own conservative default still guards depth — and reported.
    for (const [key, bad] of [['draft', '2 meters'], ['beam', {}], ['airDraft', 999]] as const) {
      const request = req({ [key]: bad });
      const result = validateRequestConstraints(request);
      assert.strictEqual(result.error, null);
      assert.strictEqual(request[key], undefined);
      assert.strictEqual(result.warnings.length, 1);
      assert.strictEqual(result.warnings[0].type, 'vessel_dimension_ignored');
      assert.match(result.warnings[0].message, key === 'airDraft' ? /air draft/ : new RegExp(key));
    }
  });

  it('reports every unusable dimension, not just the first', () => {
    const result = validateRequestConstraints(req({ draft: 'deep', beam: 'wide', airDraft: -1 }));
    assert.strictEqual(result.error, null);
    assert.strictEqual(result.warnings.length, 3);
  });

  it('rejects an unusable minCoastDistance', () => {
    assert.match(validateRequestConstraints(req({ minCoastDistance: 'far' })).error!, /minCoastDistance/);
    assert.match(validateRequestConstraints(req({ minCoastDistance: -1 })).error!, /minCoastDistance/);
  });

  it('normalizes nulls to undefined so the engine falls back to defaults', () => {
    const request = req({ draft: null, minCoastDistance: null });
    const result = validateRequestConstraints(request);
    assert.strictEqual(result.error, null);
    assert.deepStrictEqual(result.warnings, []);
    assert.strictEqual(request.draft, undefined);
    assert.strictEqual(request.minCoastDistance, undefined);
  });
});
