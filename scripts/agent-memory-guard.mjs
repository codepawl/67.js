// The memory guard of render and review jobs: a job fails when the Node process or the live browser heap stays above its limit.

export const NODE_RSS_LIMIT_BYTES = 512 * 1024 ** 2;
export const BROWSER_HEAP_LIMIT_BYTES = 256 * 1024 ** 2;

/**
 * The browser heap in use, counting only memory the page still holds.
 * `Runtime.getHeapUsage` also counts garbage that was not collected yet, and a scene with a physics bake
 * leaves tens of MiB of it behind on its first frame. Above the limit the heap is collected and read again,
 * so only memory that survives a collection (a real leak or a scene that really needs more) trips the guard.
 */
export async function sampleBrowserHeap(session, limitBytes = BROWSER_HEAP_LIMIT_BYTES) {
  let usage = await session.send('Runtime.getHeapUsage');
  if (usage.usedSize > limitBytes) {
    await session.send('HeapProfiler.collectGarbage');
    usage = await session.send('Runtime.getHeapUsage');
  }
  return usage.usedSize;
}

export function exceedsMemoryGuard({ nodeBytes, browserHeapBytes }) {
  return nodeBytes > NODE_RSS_LIMIT_BYTES || browserHeapBytes > BROWSER_HEAP_LIMIT_BYTES;
}
