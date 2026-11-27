import assert from 'node:assert';
import { describe, it } from 'node:test';
import { GpxExporter, escapeXmlAttribute, escapeXmlText, type ProviderInfo, type RouteResult } from '../dist/index.js';

const NASTY = `a<b>&c"d'e\u0000\u0001\u0008\u000B\u000C\u000E\u001F￾￿f\ud800g\tLF\nCR\r\u{1F6A2}end`;

const route = {
  type: 'FeatureCollection',
  features: [],
  totalDistance: 4000,
  totalCost: 1,
  totalSeconds: 1800,
  totalWaitSeconds: 0,
  calculatedAt: '2026-11-15T10:00:00.000Z',
  timingAssumptions: { averageSpeedKnots: 6, lockWaitMinutes: 60, bridgeWaitMinutes: 30 },
  waypoints: [
    { latitude: 52.0, longitude: 5.0 },
    { latitude: 52.02, longitude: 5.05 },
  ],
  warnings: [{ type: `t"<${NASTY}`, level: 'caution', code: `c&${NASTY}`, message: `m<${NASTY}>` }],
} as unknown as RouteResult;

const provider: ProviderInfo = { name: `prov"${NASTY}`, version: `1.0'<${NASTY}`, displayName: `Disp<${NASTY}` };

/** XML 1.0 `Char` production, over code points. */
function invalidXmlChar(text: string): string | undefined {
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    const ok =
      c === 0x9 || c === 0xa || c === 0xd || (c >= 0x20 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd) || (c >= 0x10000 && c <= 0x10ffff);
    if (!ok) return `U+${c.toString(16)}`;
  }
  return undefined;
}

/**
 * A small well-formedness check: balanced, properly nested elements, names
 * valid, attribute values double-quoted with no raw `<` or `&` outside an
 * entity, text with no raw `<` and no bare `&`.
 */
function assertWellFormed(xml: string): void {
  assert.strictEqual(invalidXmlChar(xml), undefined, 'a character XML 1.0 does not allow');
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  const body = xml.slice(xml.indexOf('?>') + 2);
  const entity = /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g;
  const stack: string[] = [];
  let i = 0;
  let roots = 0;
  const bareAmp = (s: string, where: string): void => assert.ok(!/&/.test(s.replace(entity, '')), `bare & in ${where}: ${s.slice(0, 60)}`);
  while (i < body.length) {
    if (body[i] !== '<') {
      const next = body.indexOf('<', i);
      const text = body.slice(i, next < 0 ? body.length : next);
      if (stack.length === 0) assert.ok(text.trim() === '', 'text outside the root');
      bareAmp(text, 'text');
      assert.ok(!text.includes(']]>'), `]]> in character data: ${text.slice(0, 60)}`);
      i = next < 0 ? body.length : next;
      continue;
    }
    const end = body.indexOf('>', i);
    assert.ok(end > i, 'unterminated tag');
    const tag = body.slice(i + 1, end);
    if (tag.startsWith('/')) {
      const name = tag.slice(1).trim();
      assert.strictEqual(stack.pop(), name, `mismatched </${name}>`);
    } else {
      const selfClosing = tag.endsWith('/');
      const inner = selfClosing ? tag.slice(0, -1) : tag;
      const m = /^([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*="[^"<&]*(?:&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);[^"<&]*)*")*)\s*$/.exec(inner);
      assert.ok(m, `bad start tag <${inner.slice(0, 80)}>`);
      if (stack.length === 0) roots++;
      if (!selfClosing) stack.push(m![1]);
    }
    i = end + 1;
  }
  assert.deepStrictEqual(stack, [], 'unclosed elements');
  assert.strictEqual(roots, 1, 'exactly one root element');
}

describe('GPX text is escaped and valid XML 1.0', () => {
  it('escapes the five markup characters and removes characters XML 1.0 forbids', () => {
    assert.strictEqual(escapeXmlText(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&apos;');
    assert.strictEqual(escapeXmlText('a\u0000b\u0001c\u0008d\u000be\u000cf\u000eg\u001fh'), 'abcdefgh');
    assert.strictEqual(escapeXmlText('tab\tlf\ncr\r'), 'tab\tlf\ncr\r');
    assert.strictEqual(escapeXmlText('x￾y￿z'), 'xyz');
    assert.strictEqual(escapeXmlText('lone\ud800 high, lone\udc00 low'), 'lone high, lone low');
    assert.strictEqual(escapeXmlText('ship \u{1F6A2}'), 'ship \u{1F6A2}', 'a surrogate pair is kept');
  });

  it('writes whitespace characters of an attribute value as references so a parser keeps them', () => {
    assert.strictEqual(escapeXmlAttribute('a\tb\nc\rd'), 'a&#9;b&#10;c&#13;d');
  });

  it('the route name, creator, description, warning texts and extension attributes survive as well-formed XML', () => {
    const gpx = GpxExporter.toGpx(route, NASTY, provider);
    assertWellFormed(gpx);
    assert.ok(gpx.includes('<name>a&lt;b&gt;&amp;c&quot;d&apos;e'), 'the name is escaped');
    assert.ok(!gpx.includes('<b>'), 'no raw markup from the name');
    // The warning's message is element text, its type and code are attributes.
    assert.match(gpx, /<ar:warning [^>]*type="t&quot;&lt;/);
  });

  it('a name containing a CDATA terminator is escaped', () => {
    const gpx = GpxExporter.toGpx(route, 'a]]>b', provider);
    assertWellFormed(gpx);
    assert.ok(gpx.includes('<name>a]]&gt;b</name>'), 'the > of ]]> is a reference');
    assert.ok(!gpx.includes(']]>'));
  });

  it('a name that is nothing but forbidden characters leaves an empty element, not broken XML', () => {
    const gpx = GpxExporter.toGpx(route, '\u0000\u0001', { name: 'p', version: '1' });
    assertWellFormed(gpx);
    assert.match(gpx, /<name><\/name>/);
  });

  it('the well-formedness check itself rejects what it should', () => {
    assert.throws(() => assertWellFormed('<?xml version="1.0" encoding="UTF-8"?><a><b></a></b>'));
    assert.throws(() => assertWellFormed('<?xml version="1.0" encoding="UTF-8"?><a>x & y</a>'));
    assert.throws(() => assertWellFormed('<?xml version="1.0" encoding="UTF-8"?><a>\u0001</a>'));
    assert.throws(() => assertWellFormed('<?xml version="1.0" encoding="UTF-8"?><a b="x<y"/>'));
    assert.throws(() => assertWellFormed('<?xml version="1.0" encoding="UTF-8"?><a>]]></a>'));
    assert.doesNotThrow(() => assertWellFormed('<?xml version="1.0" encoding="UTF-8"?><a>x > y &gt; z</a>'));
  });
});
