import test from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_HEAP_LIMIT_BYTES, NODE_RSS_LIMIT_BYTES, exceedsMemoryGuard, sampleBrowserHeap } from '../scripts/agent-memory-guard.mjs';

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
