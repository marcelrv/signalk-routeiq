import assert from 'node:assert';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  HOST_REQUEST_TYPES,
  MAX_RETAINED_RESULTS,
  PROTOCOL_VERSION,
  sanitizeSearchQuery,
  DEFAULT_POI_LIMITS,
  type HostReply,
} from '../dist/index.js';

const hostFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'worker-host.js');

function exchange(messages: unknown[]): Promise<HostReply[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(hostFile);
    const replies: HostReply[] = [];
    const waitFor = messages.filter((m) => typeof (m as { id?: unknown }).id === 'number').length;
    worker.on('message', (m: HostReply) => {
      replies.push(m);
      if (replies.filter((r) => r.type === 'result').length === waitFor) {
        void worker.terminate().then(() => resolve(replies));
      }
    });
    worker.on('error', reject);
    for (const m of messages) worker.postMessage(m);
  });
}

describe('protocol', () => {
  it('has version 1 and exactly the listed request types', () => {
    assert.strictEqual(PROTOCOL_VERSION, 1);
    assert.deepStrictEqual([...HOST_REQUEST_TYPES], [
      'init',
      'status',
      'route',
      'departures',
      'pois',
      'search',
      'nearestPoi',
      'coverage',
      'gpx',
      'abort',
      'shutdown',
    ]);
  });

  it('has no bulk-access message: nothing that lists or dumps the graph, the POIs or the edges', () => {
    for (const type of HOST_REQUEST_TYPES) {
      assert.doesNotMatch(type, /all|list|dump|graph|edges|nodes|export/i, type);
    }
    assert.ok(MAX_RETAINED_RESULTS > 0 && MAX_RETAINED_RESULTS <= 64, 'the result store is bounded');
  });

  it('the host answers an unknown request type with an error, and a job before init as not initialised', async () => {
    const replies = await exchange([
      { type: 'allNodes', id: 1 },
      { type: 'allPois', id: 2 },
      { type: 'status', id: 3 },
      { type: 'route', id: 4, request: {} },
      { type: 'gpx', id: 5, resultId: 1, name: 'x', provider: { name: 'p', version: '1' } },
    ]);
    const byId = new Map(replies.filter((r) => r.type === 'result').map((r) => [r.id, r]));
    for (const id of [1, 2]) {
      assert.strictEqual(byId.get(id)?.ok, false);
      assert.strictEqual(byId.get(id)?.error?.code, 'UNKNOWN_REQUEST');
    }
    for (const id of [3, 4, 5]) {
      assert.strictEqual(byId.get(id)?.ok, false);
      assert.strictEqual(byId.get(id)?.error?.code, 'NOT_INITIALISED');
    }
  });

  it('refuses a mismatching version at init and stays uninitialised', async () => {
    const replies = await exchange([
      { type: 'init', id: 1, protocolVersion: PROTOCOL_VERSION + 1, engine: {}, database: { files: [] } },
      { type: 'status', id: 2 },
    ]);
    const byId = new Map(replies.filter((r) => r.type === 'result').map((r) => [r.id, r]));
    assert.strictEqual(byId.get(1)?.error?.code, 'PROTOCOL_MISMATCH');
    assert.strictEqual(byId.get(2)?.error?.code, 'NOT_INITIALISED');
  });
});

describe('search input is bounded', () => {
  it('strips control characters and cuts to the maximum length', () => {
    assert.strictEqual(sanitizeSearchQuery('Zee\u0000l\u001fand\u007f\u0085 ', 100), 'Zeeland');
    assert.strictEqual(sanitizeSearchQuery('abcdefghij', 4), 'abcd');
    assert.strictEqual(sanitizeSearchQuery('a\u0000bcdefghij', 4), 'abcd', 'control characters do not count toward the length');
    assert.strictEqual(DEFAULT_POI_LIMITS.maxBBoxResults, 500);
    assert.strictEqual(DEFAULT_POI_LIMITS.maxSearchResults, Infinity);
    assert.strictEqual(DEFAULT_POI_LIMITS.maxNearestRadiusM, Infinity);
  });
});
