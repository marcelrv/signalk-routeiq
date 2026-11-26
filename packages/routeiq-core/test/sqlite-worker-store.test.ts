import assert from 'node:assert';
import { describe, it } from 'node:test';
import type { Worker } from 'node:worker_threads';
import { SqliteWorkerStore } from '../dist/index.js';

/** The store's own worker, to stop it from outside as a crash would. */
function workerOf(store: SqliteWorkerStore): Worker {
  const w = (store as unknown as { worker: Worker | null }).worker;
  assert.ok(w, 'the store has a worker');
  return w;
}

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  assert.fail('expected a rejection');
}

describe('SqliteWorkerStore when its worker dies', () => {
  it('rejects the calls that were waiting, and refuses further calls until re-initialised', async () => {
    const store = new SqliteWorkerStore();
    try {
      await store.getMetadata(); // starts the worker
      const worker = workerOf(store);
      assert.strictEqual(store.dead, false);

      // A call that will never be answered: the worker is stopped under it.
      const waiting = store.peekMetadata(['/nonexistent/never-read.sqlite']);
      const failed = rejection(waiting);
      await worker.terminate();
      const e = await failed;
      assert.ok(e instanceof Error);
      assert.strictEqual(store.dead, true);

      // Nothing hangs afterwards, and nothing restarts silently.
      const refused = await rejection(store.getMetadata());
      assert.match(refused.message, /not running/);
      const refusedLoad = await rejection(store.loadNodes());
      assert.match(refusedLoad.message, /initialised again/);

      // Re-initialising starts a fresh worker.
      // (An empty list is refused by the worker itself: that answer proves a
      // new worker is running again.)
      const reopened = await rejection(store.openAll([]));
      assert.match(reopened.message, /No valid .sqlite routing databases/);
      assert.strictEqual(store.dead, false);
      assert.deepStrictEqual(await store.getMetadata(), []);
    } finally {
      await store.close();
    }
  });

  it('a deliberate close is not a death, and the store starts afresh on its next call', async () => {
    const store = new SqliteWorkerStore();
    await store.getMetadata();
    await store.close();
    assert.strictEqual(store.dead, false);
    assert.deepStrictEqual(await store.getMetadata(), []);
    await store.close();
  });

  it('close() clears a dead store', async () => {
    const store = new SqliteWorkerStore();
    await store.getMetadata();
    await workerOf(store).terminate();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(store.dead, true);
    await store.close();
    assert.strictEqual(store.dead, false);
    assert.deepStrictEqual(await store.getMetadata(), []);
    await store.close();
  });
});

describe('SqliteWorkerStore overlapping close', () => {
  it('shares one close and can be used again afterwards', async () => {
    const store = new SqliteWorkerStore();
    try {
      await store.getMetadata();
      const first = store.close();
      const second = store.close();
      assert.strictEqual(first, second);
      await Promise.all([first, second]);
      assert.deepStrictEqual(await store.getMetadata(), []);
      const worker = workerOf(store);
      // A late close must not leave a worker behind from a new start.
      const again = store.close();
      await again;
      assert.deepStrictEqual(await store.getMetadata(), []);
      assert.ok(workerOf(store) !== worker);
    } finally {
      await store.close();
    }
  });
});
