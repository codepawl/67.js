import test from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_HEAP_LIMIT_BYTES, NODE_RSS_LIMIT_BYTES, exceedsMemoryGuard, nativeNodeAllowanceBytes, sampleBrowserHeap } from '../scripts/agent-memory-guard.mjs';

const MEBIBYTE = 1024 ** 2;

/** A browser heap whose uncollected garbage disappears on `HeapProfiler.collectGarbage`, as a page after a physics bake does. */
function fakeSession({ garbageBytes, liveBytes }) {
  const calls = [];
  let collected = false;
  return {
    calls,
    async send(method) {
      calls.push(method);
      if (method === 'HeapProfiler.collectGarbage') {
        collected = true;
        return {};
      }
      return { usedSize: collected ? liveBytes : liveBytes + garbageBytes };
    },
  };
}

test('uncollected garbage from the first fractured-wall frame does not trip the heap guard', async () => {
  // Measured on a 28-cell fractured wall render: 311 MiB sampled on frame 0, 11 MiB once collected.
  const session = fakeSession({ garbageBytes: 300 * MEBIBYTE, liveBytes: 11 * MEBIBYTE });
  const heapBytes = await sampleBrowserHeap(session);
  assert.equal(heapBytes, 11 * MEBIBYTE);
  assert.deepEqual(session.calls, ['Runtime.getHeapUsage', 'HeapProfiler.collectGarbage', 'Runtime.getHeapUsage']);
  assert.equal(exceedsMemoryGuard({ nodeBytes: 200 * MEBIBYTE, browserHeapBytes: heapBytes }), false);
});

test('a heap under the limit is read once and never collected', async () => {
  const session = fakeSession({ garbageBytes: 0, liveBytes: 90 * MEBIBYTE });
  assert.equal(await sampleBrowserHeap(session), 90 * MEBIBYTE);
  assert.deepEqual(session.calls, ['Runtime.getHeapUsage']);
});

test('memory that survives a collection still trips the guard', async () => {
  const session = fakeSession({ garbageBytes: 50 * MEBIBYTE, liveBytes: BROWSER_HEAP_LIMIT_BYTES + MEBIBYTE });
  const heapBytes = await sampleBrowserHeap(session);
  assert.equal(heapBytes, BROWSER_HEAP_LIMIT_BYTES + MEBIBYTE);
  assert.equal(exceedsMemoryGuard({ nodeBytes: 0, browserHeapBytes: heapBytes }), true);
});

test('the Node limit is unchanged and still enforced', () => {
  assert.equal(NODE_RSS_LIMIT_BYTES, 512 * MEBIBYTE);
  assert.equal(exceedsMemoryGuard({ nodeBytes: NODE_RSS_LIMIT_BYTES + 1, browserHeapBytes: 0 }), true);
  assert.equal(exceedsMemoryGuard({ nodeBytes: NODE_RSS_LIMIT_BYTES, browserHeapBytes: BROWSER_HEAP_LIMIT_BYTES }), false);
});

test('a native job gets 256 MiB plus 1 KiB a pixel on top of the Node limit, capped at 2 GiB', () => {
  assert.equal(nativeNodeAllowanceBytes({ width: 960, height: 540 }), 256 * MEBIBYTE + 960 * 540 * 1024);
  assert.equal(nativeNodeAllowanceBytes({ width: 1, height: 1 }), 256 * MEBIBYTE + 1024);
  assert.equal(nativeNodeAllowanceBytes({ width: 7680, height: 4320 }), 2048 * MEBIBYTE);
  assert.throws(() => nativeNodeAllowanceBytes({ width: 0, height: 540 }), /positive integer width and height/);
});

test('a native 960 x 540 job at 800 MiB of Node RSS passes while the same RSS stops a non-native job', () => {
  const nativeAllowanceBytes = nativeNodeAllowanceBytes({ width: 960, height: 540 });
  assert.equal(exceedsMemoryGuard({ nodeBytes: 800 * MEBIBYTE, browserHeapBytes: 0, nativeAllowanceBytes }), false);
  assert.equal(exceedsMemoryGuard({ nodeBytes: 800 * MEBIBYTE, browserHeapBytes: 0 }), true);
});

test('a runaway native job still stops, and the allowance does not loosen the browser heap limit', () => {
  const nativeAllowanceBytes = nativeNodeAllowanceBytes({ width: 960, height: 540 });
  const limit = NODE_RSS_LIMIT_BYTES + nativeAllowanceBytes;
  assert.equal(exceedsMemoryGuard({ nodeBytes: limit, browserHeapBytes: 0, nativeAllowanceBytes }), false);
  assert.equal(exceedsMemoryGuard({ nodeBytes: limit + 1, browserHeapBytes: 0, nativeAllowanceBytes }), true);
  assert.equal(exceedsMemoryGuard({ nodeBytes: 0, browserHeapBytes: BROWSER_HEAP_LIMIT_BYTES + 1, nativeAllowanceBytes }), true);
});
