// Shared chunk loop of the async gaussian splat steps (parseGaussianSplatPlyAsync, createGaussianSplatsAsync): work on a
// slice of the splats, report progress, then hand the thread back to the event loop so the page stays responsive.

export const DEFAULT_SPLAT_CHUNK_SIZE = 32768;

// A message event is a macrotask like a timer, but without the clamp of 4 ms (browsers) or 1 to 15 ms (Windows timers).
function yieldToEventLoop() {
  if (typeof MessageChannel !== 'function') return new Promise(resolve => setTimeout(resolve, 0));
  return new Promise(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

function resolveChunkOptions(options, caller) {
  const { onProgress, chunkSize = DEFAULT_SPLAT_CHUNK_SIZE, signal } = options;
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new RangeError(`${caller} chunkSize must be a positive whole number of splats, got ${chunkSize}`);
  }
  if (onProgress !== undefined && typeof onProgress !== 'function') {
    throw new TypeError(`${caller} onProgress must be a function that takes a fraction from 0 to 1`);
  }
  if (signal !== undefined && typeof signal?.aborted !== 'boolean') {
    throw new TypeError(`${caller} signal must be an AbortSignal`);
  }
  return { onProgress, chunkSize, signal };
}

function throwIfAborted(signal, caller) {
  if (!signal?.aborted) return;
  const reason = signal.reason instanceof Error ? `: ${signal.reason.message}` : '';
  const error = new Error(`${caller} was aborted${reason}`);
  error.name = 'AbortError';
  throw error;
}

/**
 * Calls `processRange(start, end)` for consecutive slices of `total` splats. Before each slice it checks the abort signal;
 * after each it calls `onProgress(end / total)` (so the last call is exactly 1) and, except after the last slice, waits
 * one macrotask. Returns after the last slice.
 */
export async function runInChunks(total, options, caller, processRange) {
  const { onProgress, chunkSize, signal } = resolveChunkOptions(options, caller);
  throwIfAborted(signal, caller);
  for (let start = 0; start < total; start += chunkSize) {
    const end = Math.min(total, start + chunkSize);
    processRange(start, end);
    onProgress?.(end / total);
    if (end < total) {
      await yieldToEventLoop();
      throwIfAborted(signal, caller);
    }
  }
}
