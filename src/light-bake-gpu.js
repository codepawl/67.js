import { buildTraceScene } from './path-tracer-scene.js';
import { checkBudget, checkedBakeSize, finishLightmaps, planLightmaps, rasterizeEntries, traceLightmaps } from './light-bake.js';

// The GPU side of the light bake: the texels of every part go to the path tracer's kernel in one batch, which starts a
// cosine weighted path at each texel and returns the light that arrives. The CPU gatherer in light-bake.js stays the
// reference. This module holds the asynchronous bake API, so the CPU bake and every bundle that uses it carry none of this.

const BAKE_SEED = 1;
// The bake keeps every bright sample (the CPU gatherer has no clamp), so the kernel's firefly clamp is set out of reach.
const NO_FIREFLY_CLAMP = 1e6;

/** The plan's lights in the shapes the path tracer reads. A light limited by `affects` cannot be traced: the kernel has no light linking. */
function traceEnvironment({ lights }) {
  const linked = [...lights.pointLights, ...lights.spotLights, ...lights.areaLights, ...(lights.sun ? [lights.sun] : [])].some(light => light.affects !== null);
  if (linked) throw new RangeError('A light bake on the GPU backend does not support light linking (`affects`). Use the CPU backend.');
  return {
    pointLights: lights.pointLights,
    spotLights: lights.spotLights.map(light => ({ ...light, angle: Math.acos(light.cosineHalfAngle), penumbra: light.blend / (1 - light.cosineHalfAngle) })),
    areaLights: lights.areaLights.map(light => ({ ...light, direction: light.normal, up: light.along })),
    keyColor: lights.sun?.color ?? [0, 0, 0],
    lightDirection: lights.sun?.direction ?? [0, 1, 0],
  };
}

/** The covered texels of all parts as one list of world points and normals, and where each part's slice starts. */
function packCoveredTexels(rasterized) {
  let count = 0;
  for (const { covered } of rasterized) for (const flag of covered) count += flag;
  const points = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const slices = [];
  let next = 0;
  for (const { positions, normals: texelNormals, covered } of rasterized) {
    const texelIndices = [];
    for (let texel = 0; texel < covered.length; texel++) {
      if (!covered[texel]) continue;
      points.set(positions.subarray(texel * 3, texel * 3 + 3), next * 3);
      normals.set(texelNormals.subarray(texel * 3, texel * 3 + 3), next * 3);
      texelIndices.push(texel);
      next++;
    }
    slices.push(texelIndices);
  }
  return { count, points, normals, slices };
}

/**
 * Traces every covered texel on the GPU and resolves with `entries` (per rasterized part, `light` and `escaped` in the
 * layout the CPU gatherer returns), the `gpu` name and the kernel's `compileSeconds`.
 */
/** The texel tracer of the backend; each is loaded only when a bake asks for it. */
async function loadTexelTracer(backend) {
  if (backend === 'webgpu') return (await import('./path-tracer-webgpu.js')).traceTexelsOnWebGpu;
  return (await import('./path-tracer-gpu.js')).traceTexelsOnGpu;
}

async function gatherOnGpu(plan, settings, rasterized, shouldStop) {
  const environment = traceEnvironment(plan);
  const texels = packCoveredTexels(rasterized);
  const scene = buildTraceScene(plan.parts, environment);
  const traceTexels = await loadTexelTracer(settings.backend);
  const traced = await traceTexels(scene, texels, { samples: settings.samples, bounces: settings.bounces, seed: BAKE_SEED, fireflyClamp: NO_FIREFLY_CLAMP }, shouldStop);
  let next = 0;
  const entries = rasterized.map(({ resolution }, entryNumber) => {
    const light = new Float32Array(resolution * resolution * 3);
    const escaped = new Float32Array(resolution * resolution);
    for (const texel of texels.slices[entryNumber]) {
      light.set(traced.radiance.subarray(next * 3, next * 3 + 3), texel * 3);
      escaped[texel] = traced.escaped[next];
      next++;
    }
    return { light, escaped };
  });
  return { entries, gpu: traced.gpu, compileSeconds: traced.compileSeconds };
}

/** `traceLightmaps` for either backend: the CPU trace as it is, or the same steps with the texels gathered by the kernel. */
export async function traceLightmapsAsync(plan, tracedSettings) {
  const settings = { ...plan.settings, ...tracedSettings };
  if (settings.backend === 'cpu') return traceLightmaps(plan, settings);
  if (settings.skyOnly) throw new RangeError('A sky visibility bake runs on the CPU backend only.');
  const sizes = checkedBakeSize(plan, settings);
  const rasterized = rasterizeEntries(plan, settings);
  const gathered = await gatherOnGpu(plan, settings, rasterized, () => checkBudget(plan, settings));
  const result = finishLightmaps(plan, settings, rasterized, gathered.entries, sizes);
  return { parts: result.parts, report: { ...result.report, gpu: gathered.gpu, gpuCompileSeconds: gathered.compileSeconds } };
}

/**
 * `bakeLightmaps` with a choice of tracer: `options.backend` is "cpu" (the default, the reference) or "gpu", which traces the
 * texels with the GPU path tracer's kernel and needs a page with WebGL2, or "webgpu", which runs the WGSL kernel and needs `navigator.gpu`. Resolves with the same `{ parts, report }`;
 * `report.backend` names the tracer, and a GPU or WebGPU bake adds `gpu` and `gpuCompileSeconds`.
 */
export async function bakeLightmapsAsync(parts, lighting, options = {}) {
  const plan = planLightmaps(parts, lighting, options);
  return traceLightmapsAsync(plan, { ...plan.settings, skyOnly: options.skyOnly === true });
}
