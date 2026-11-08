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

/** The `lightBake` answer traced on the GPU, in the shape `bakeChangedParts` returns. */
export async function bakeChangedPartsOnGpu(snapshots, lighting, settings) {
  const plan = planLightmaps(snapshots, lighting, { ...settings, maxSeconds: BAKE_WORKER_MAXIMUM_SECONDS, backend: 'gpu' });
  const { used, reduced, reduction } = fitSettingsToBudget(plan, settings);
  const { parts, report } = await traceLightmapsAsync(plan, { ...used, backend: 'gpu' });
  return { changed: changedPartsOf(parts, snapshots), report, used, reduced, reduction };
}

/**
 * Page kernels for `buildWithKernels`: the GPU bake when this page has WebGL2 float targets, and nothing otherwise, so
 * the worker keeps the CPU bake.
 */
export function gpuBakeKernels() {
  if (!isGpuTracerAvailable()) {
    return undefined;
  }
  return {
    lightBake: {
      accepts: ([, lighting]) => canBakeOnGpu(lighting),
      compute: ([snapshots, lighting, settings]) => bakeChangedPartsOnGpu(snapshots, lighting, settings),
    },
  };
}
