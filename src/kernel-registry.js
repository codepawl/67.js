import { bakeChangedParts, traceGridKernel } from './agent-bake.js';
import { bakeClothWithFields } from './cloth-fields.js';
import { bakeMaterialPattern } from './material-patterns.js';
import { traceProbes } from './probe-trace.js';
import { unwrapUv } from './mesh-uv.js';

// The kernels a worker can run, by the name the call sites give `runKernel`. Each is the same function the call site
// computes inline with, so the worker and the inline path return identical data.
const KERNELS = {
  lightBake: bakeChangedParts,
  probeTrace: traceProbes,
  gridTrace: traceGridKernel,
  cloth: bakeClothWithFields,
  pattern: bakeMaterialPattern,
  uvUnwrap: unwrapUv,
};

function collectBuffers(value, buffers) {
  if (ArrayBuffer.isView(value)) {
    buffers.add(value.buffer);
    return;
  }
  if (value && typeof value === 'object') {
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      collectBuffers(child, buffers);
    }
  }
}

/**
 * Answers one worker request: `{ response, transfer }`. A kernel that throws answers with the error's class name and
 * message, so the page raises the same error the inline path would.
 */
export function answerKernelRequest({ name, args }) {
  try {
    const value = KERNELS[name](...args);
    const buffers = new Set();
    collectBuffers(value, buffers);
    return { response: { value }, transfer: [...buffers] };
  } catch (error) {
    return { response: { error: { name: error?.constructor?.name ?? 'Error', message: String(error?.message ?? error) } }, transfer: [] };
  }
}
