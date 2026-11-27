import assert from 'node:assert';
import { describe, it } from 'node:test';
import { RequestControl, StopRequested } from '../dist/index.js';

const DAY = 86_400_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function stopOf(p: Promise<unknown>): Promise<StopRequested> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof StopRequested, `expected a StopRequested, got ${String(e)}`);
    return e;
  }
  assert.fail('expected a rejection');
}

describe('RequestControl.race', () => {
  it('a 30-day wall budget does not fire early (timer delay stays within the Node limit)', async () => {
    const control = new RequestControl({ maxIterations: Infinity, maxWallMs: 30 * DAY });
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    (globalThis as any).setTimeout = (fn: () => void, ms?: number, ...rest: unknown[]) => {
      delays.push(ms ?? 0);
      return (realSetTimeout as any)(fn, ms, ...rest);
    };
    try {
      const v = await control.race(sleep(60).then(() => 'done'));
      assert.strictEqual(v, 'done');
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    assert.ok(delays.every((d) => d <= 2 ** 31 - 1));
  });

  it('an abort ends the wait on a 30-day budget', async () => {
    const ac = new AbortController();
    const control = new RequestControl({ maxIterations: Infinity, maxWallMs: 30 * DAY }, ac.signal);
    const waiting = stopOf(control.race(new Promise(() => undefined)));
    ac.abort();
    assert.strictEqual((await waiting).stop.code, 'ABORTED');
  });

  it('work that settles after the request was aborted reports ABORTED, not its result or error', async () => {
    for (const fails of [false, true]) {
      // A signal that never dispatches: only the settlement can notice the abort.
      const signal = { aborted: false, addEventListener() {}, removeEventListener() {} };
      const control = new RequestControl(
        { maxIterations: Infinity, maxWallMs: Infinity },
        signal as unknown as AbortSignal,
      );
      let settle!: () => void;
      const work = new Promise<string>((resolve, reject) => {
        settle = () => (fails ? reject(new Error('late')) : resolve('late'));
      });
      const raced = control.race(work);
      signal.aborted = true;
      settle();
      assert.strictEqual((await stopOf(raced)).stop.code, 'ABORTED');
    }
  });

  it('work that settles after the wall budget reports BUDGET_EXCEEDED', async () => {
    for (const fails of [false, true]) {
      const control = new RequestControl({ maxIterations: Infinity, maxWallMs: 20 });
      const work = fails ? Promise.reject(new Error('late')) : Promise.resolve('late');
      const raced = control.race(work);
      // Block the event loop past the budget so the settlement is seen before the timer.
      const start = Date.now();
      while (Date.now() - start < 40);
      assert.strictEqual((await stopOf(raced)).stop.code, 'BUDGET_EXCEEDED');
    }
  });
});
