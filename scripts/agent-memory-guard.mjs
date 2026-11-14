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

// The native path tracer and the OIDN denoiser run inside the Node process, so a native job holds memory the JS limit never
// meant to cover: the traced scene tables (fixed) and the denoiser's buffers, frame planes and temporal history (per pixel).
// These are estimates, not measurements: the Linux end-to-end run in #1186 is still to be measured and the numbers adjusted.
export const NATIVE_FIXED_ALLOWANCE_BYTES = 256 * 1024 ** 2;
export const NATIVE_BYTES_PER_PIXEL = 1024;
export const NATIVE_ALLOWANCE_CAP_BYTES = 2048 * 1024 ** 2;

/** Extra Node RSS a native tracer job may hold on top of the base limit, from its frame size, never above the cap. */
export function nativeNodeAllowanceBytes({ width, height }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`nativeNodeAllowanceBytes needs a positive integer width and height, got ${width} x ${height}.`);
  }
  const allowance = NATIVE_FIXED_ALLOWANCE_BYTES + width * height * NATIVE_BYTES_PER_PIXEL;
  return Math.min(allowance, NATIVE_ALLOWANCE_CAP_BYTES);
}

/**
 * The extra Node RSS one runtime grants, shared by every job and review it runs.
 * The in-process OIDN device and the tracer tables live "for the life of the process", so the memory a native job
 * leaves behind is still in RSS when the next raster job or review starts. The allowance therefore only grows: it is
 * raised by each native frame and never dropped, not when a job falls back to another backend and not when it ends.
 * One figure for the whole process is deliberate until the Linux measurement of #1186 splits it into parts.
 */
export function createNativeMemoryAllowance() {
  let grantedBytes = 0;
  return {
    /** Called when a frame really traces natively. */
    grantForFrame({ width, height }) {
      grantedBytes = Math.max(grantedBytes, nativeNodeAllowanceBytes({ width, height }));
    },
    get bytes() {
      return grantedBytes;
    },
  };
}

/** A job that never used the native tracer passes no allowance, so its limit is the base 512 MiB. */
export function exceedsMemoryGuard({ nodeBytes, browserHeapBytes, nativeAllowanceBytes = 0 }) {
  return nodeBytes > NODE_RSS_LIMIT_BYTES + nativeAllowanceBytes || browserHeapBytes > BROWSER_HEAP_LIMIT_BYTES;
}

/** The error an agent reads when the guard trips: which limit, what was observed, and what to change. */
export function memoryGuardMessage({ subject, nodeBytes, browserHeapBytes, nativeAllowanceBytes = 0 }) {
  const mebibytes = (bytes) => Math.round(bytes / 1024 ** 2);
  const nodeLimitBytes = NODE_RSS_LIMIT_BYTES + nativeAllowanceBytes;
  if (nodeBytes > nodeLimitBytes) {
    const allowanceNote = nativeAllowanceBytes > 0 ? ` (${mebibytes(NODE_RSS_LIMIT_BYTES)} MiB base plus ${mebibytes(nativeAllowanceBytes)} MiB for the native tracer)` : '';
    return `${subject} exceeded its Node RSS guard: ${mebibytes(nodeBytes)} MiB used, ${mebibytes(nodeLimitBytes)} MiB allowed${allowanceNote}. Use a smaller frame size or a non-native backend.`;
  }
  return `${subject} exceeded its sampled browser heap guard: ${mebibytes(browserHeapBytes)} MiB used, ${mebibytes(BROWSER_HEAP_LIMIT_BYTES)} MiB allowed. Use a smaller frame size or fewer objects in the scene.`;
}
