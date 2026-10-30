import assert from 'node:assert';
import { describe, it } from 'node:test';
import { buildManifest } from '../dist/plotterext.js';

// The manifest is what a host chartplotter (Freeboard-SK) reads to decide
// whether it can run the extension at all. An id it does not know in
// `requires` makes the whole extension incompatible with that host, so the
// newer capabilities RouteIQ uses (chart actions, map picks) have to stay in
// `optional` — older hosts must keep getting today's panel.
describe('plotter extension manifest', () => {
  const manifest = buildManifest('1.2.3');

  it('keeps the hard requirements unchanged', () => {
    assert.deepStrictEqual(manifest.requires, [
      'panels.iframe',
      'buttons',
      'routes',
    ]);
  });

  it('lists the newer capabilities as optional only', () => {
    for (const cap of ['actions', 'map.pick']) {
      assert.ok(
        manifest.optional.includes(cap),
        `expected ${cap} in optional, got ${JSON.stringify(manifest.optional)}`,
      );
      assert.ok(
        !(manifest.requires as string[]).includes(cap),
        `${cap} must not be required`,
      );
    }
  });

  it('declares well-formed actions that open a declared panel', () => {
    const panelIds = new Set(manifest.panels.map((p) => p.id));
    assert.ok(manifest.actions.length > 0, 'expected chart actions');
    for (const a of manifest.actions) {
      assert.ok(a.id, 'action without id');
      assert.ok(a.title, `action ${a.id} without title`);
      assert.ok(
        Array.isArray(a.targets) && a.targets.length > 0,
        `action ${a.id} without targets`,
      );
      assert.ok(a.action?.type, `action ${a.id} without action type`);
      assert.ok(
        panelIds.has(a.action.panel),
        `action ${a.id} opens unknown panel ${a.action.panel}`,
      );
    }
  });

  it('uses unique action ids', () => {
    const ids = manifest.actions.map((a) => a.id);
    assert.strictEqual(new Set(ids).size, ids.length, `duplicate in ${ids}`);
  });

  it('hides the planning-session actions until a session exists', () => {
    const byId = new Map(manifest.actions.map((a) => [a.id, a]));
    for (const id of ['add-via', 'set-dest']) {
      assert.strictEqual(byId.get(id)?.visible, false, `${id} should start hidden`);
    }
  });
});
