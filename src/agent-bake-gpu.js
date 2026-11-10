import { planLightmaps } from './light-bake.js';
import { BAKE_WORKER_MAXIMUM_SECONDS } from './agent-scene-capabilities.js';
import { changedPartsOf, fitSettingsToBudget } from './agent-bake.js';
import { isGpuTracerAvailable } from './path-tracer-gpu.js';
import { traceLightmapsAsync } from './light-bake-gpu.js';

// The recipe light bake on the GPU. The scene build is synchronous, so a build that meets a `lightBake` kernel defers it
// (src/kernel-offload.js) and this module answers it on the page: same inputs, same result shape as the worker's CPU
// kernel, with `report.backend` naming the tracer. Anything the GPU kernel cannot trace returns undefined, and the CPU
// worker bakes it instead.

function lightsOf(lighting) {
  return [...(lighting.pointLights ?? []), ...(lighting.spotLights ?? []), ...(lighting.areaLights ?? [])];
}

/** Whether a `lightBake` call can run on the GPU: the kernel has no light linking (`affects`). */
export function canBakeOnGpu(lighting) {
  return lightsOf(lighting).every(light => light.affects === undefined || light.affects === null);
}

/**
 * The `lightBake` answer traced on the GPU, in the shape `bakeChangedParts` returns. `texelTracer` (the native tracer
 * outside the page) makes the backend "native"; without it the page's WebGL2 kernel runs.
 */
export async function bakeChangedPartsOnGpu(snapshots, lighting, settings, texelTracer) {
  const backend = texelTracer ? 'native' : 'gpu';
  const plan = planLightmaps(snapshots, lighting, { ...settings, maxSeconds: BAKE_WORKER_MAXIMUM_SECONDS, backend });
  const { used, reduced, reduction } = fitSettingsToBudget(plan, settings);
  const { parts, report } = await traceLightmapsAsync(plan, { ...used, backend, ...(texelTracer ? { texelTracer } : {}) });
  return { changed: changedPartsOf(parts, snapshots), report, used, reduced, reduction };
}

/**
 * The native bake with the page's own kernel as its fallback: a native trace that cannot run (no package, no ray query
 * adapter, over its time) is noted in `report.backendNote`, and the WebGL2 kernel bakes instead when this page has one. With
 * no WebGL2 kernel the error stands, and the worker bakes on the CPU.
 */
async function bakeNativeOrOnGpu(snapshots, lighting, settings, texelTracer) {
  try {
    return await bakeChangedPartsOnGpu(snapshots, lighting, settings, texelTracer);
  } catch (error) {
    if (!isGpuTracerAvailable()) throw error;
    const fallback = await bakeChangedPartsOnGpu(snapshots, lighting, settings);
    return { ...fallback, report: { ...fallback.report, backendNote: `The native bake could not run (${error.message}); the gpu backend ran instead.` } };
  }
}

/**
 * Page kernels for `buildWithKernels`: the GPU bake when this page has WebGL2 float targets or the host offers the native
 * tracer (`texelTracer`, see the preview page), and nothing otherwise, so the worker keeps the CPU bake.
 */
export function gpuBakeKernels({ texelTracer } = {}) {
  if (!texelTracer && !isGpuTracerAvailable()) {
    return undefined;
  }
  return {
    lightBake: {
      accepts: ([, lighting]) => canBakeOnGpu(lighting),
      compute: ([snapshots, lighting, settings]) => (texelTracer
        ? bakeNativeOrOnGpu(snapshots, lighting, settings, texelTracer)
        : bakeChangedPartsOnGpu(snapshots, lighting, settings)),
    },
  };
}
