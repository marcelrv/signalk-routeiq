import assert from 'node:assert';
import { describe, it } from 'node:test';
import { pickVesselDimensions, validateRequestConstraints } from '../dist/api.js';

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

describe('vessel dimension validation', () => {
  it('accepts a well-formed set of dimensions', () => {
    const result = pickVesselDimensions({ draft: 2.1, beam: 4, airDraft: 18 });
    assert.ok(!('error' in result));
    assert.deepStrictEqual(result.dims, { draft: 2.1, beam: 4, airDraft: 18 });
  });

  it('rejects a string draft rather than coercing it', () => {
    const result = pickVesselDimensions({ draft: '2 meters' });
    assert.ok('error' in result);
    assert.match(result.error, /draft/);
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
    assert.strictEqual(validateRequestConstraints(request), null);
    assert.strictEqual(request.draft, 1.8);
    assert.strictEqual(request.minCoastDistance, 0.5);
  });

  it('rejects a string vessel override', () => {
    assert.match(validateRequestConstraints(req({ beam: '4' }))!, /beam/);
  });

  it('rejects an unusable minCoastDistance', () => {
    assert.match(validateRequestConstraints(req({ minCoastDistance: 'far' }))!, /minCoastDistance/);
    assert.match(validateRequestConstraints(req({ minCoastDistance: -1 }))!, /minCoastDistance/);
  });

  it('normalizes nulls to undefined so the engine falls back to defaults', () => {
    const request = req({ draft: null, minCoastDistance: null });
    assert.strictEqual(validateRequestConstraints(request), null);
    assert.strictEqual(request.draft, undefined);
    assert.strictEqual(request.minCoastDistance, undefined);
  });
});
