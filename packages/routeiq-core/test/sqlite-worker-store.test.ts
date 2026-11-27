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

      // A call that can never be answered: the request is registered as
      // pending but never delivered to the worker, which is then stopped
      // under it. Nothing but the worker's death can settle it.
      worker.postMessage = () => {};
      const waiting = store.peekMetadata(['/nonexistent/never-read.sqlite']);
      let settled = false;
      const failed = rejection(waiting).finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(settled, false, 'the call is still pending before the worker dies');
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

describe('SqliteWorkerStore handle numbering and shutdown', () => {
  it('serialises openAll behind in-flight openDb calls, so no two live handles are equal', async () => {
    const store = new SqliteWorkerStore();
    const order: string[] = [];
    const hook = store as unknown as { send: (t: string, p?: any) => Promise<unknown> };
    let issued = 0;
    hook.send = async (type: string, payload?: any) => {
      order.push(`${type}:start`);
      await new Promise((r) => setTimeout(r, type === 'openDb' ? 30 : 0));
      order.push(`${type}:end`);
      if (type === 'openDb') return { dbIndex: issued++ };
      assert.ok(payload.indexBase >= issued, 'the base covers every handle already issued');
      return { filenames: ['x'] };
    };
    const a = store.openDb('/a');
    const b = store.openDb('/b');
    const all = store.openAll(['/x']);
    await Promise.all([a, b, all]);
    assert.deepStrictEqual(order, [
      'openDb:start', 'openDb:end', 'openDb:start', 'openDb:end', 'init:start', 'init:end',
    ]);
  });

  it('close() leaves no timer behind and the worker is gone when it returns', async () => {
    const store = new SqliteWorkerStore();
    await store.getMetadata();
    const worker = workerOf(store);
    const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    const before = timers();
    await store.close();
    assert.ok(timers() <= before, 'close() left no timer running');
    assert.strictEqual(worker.threadId, -1, 'the worker thread has ended');
  });
});
