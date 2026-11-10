import { buildMegakernelSource, PATH_STATE_VECTORS, WAVEFRONT_SOURCE, WAVEFRONT_WORKGROUP_SIZE, WORKGROUP_SIZE } from './path-tracer-webgpu-kernel.js';
import { resolveLightSelection } from './path-tracer-light-tree.js';
import { packAtlas, packEnvironment, packLightTree, packLights, packMaterials, packNodes, packSubsurface, packTriangles, sceneUsesSubsurface } from './path-tracer-gpu-pack.js';

// The WebGPU backend of the path tracer (issue #625): the same scene tables, camera, options and random numbers as the
// WebGL2 backend (path-tracer-gpu.js) go in, the same buffers come out. The tracer is WGSL compute, so a page needs
// navigator.gpu; without it traceOnWebGpu throws and the caller falls back to the "gpu" or "cpu" backend. Volume fog and
// subsurface scattering compile into the megakernel only for a scene that uses them, and traceTexelsOnWebGpu is the texel
// entry of the light bake (light-bake-gpu.js). The wavefront kernel traces neither fog nor subsurface.

/** `megakernel`: one invocation per path (the default, faster on the demo room). `wavefront`: generate, extend, shade, shadow kernels with the path state in a buffer. */
export const WEBGPU_KERNELS = ['megakernel', 'wavefront'];
export const DEFAULT_WEBGPU_KERNEL = 'megakernel';
/** Whether the wavefront bins the hits by material before shading them (decided by the measurement in docs/webgpu-decision.md). */
export const DEFAULT_SORT_BY_MATERIAL = false;

const PARAMETER_BYTES = 17 * 16;
// Dynamic uniform offsets must be a multiple of minUniformBufferOffsetAlignment, which is 256 on every adapter; a slot holds the parameter block.
const PARAMETER_SLOT_BYTES = 512;
const STORAGE_BUFFER_COUNT = 10;
const MAXIMUM_TILE_PATHS = 1 << 19;
// The path state of one tile stays under the default maxStorageBufferBindingSize.
const MAXIMUM_STATE_BYTES = 1 << 27;
const MAXIMUM_BUFFER_BYTES = 1 << 30;
const WAVEFRONT_ENTRY_POINTS = ['generatePaths', 'resetBins', 'extendPaths', 'scanBins', 'scatterPaths', 'shadePaths', 'shadowPaths', 'resolvePaths'];

/** True when this page has WebGPU. Whether an adapter exists is only known after requesting one. */
export function isWebGpuTracerAvailable() {
  return typeof navigator !== 'undefined' && Boolean(navigator.gpu);
}

let session = null;
let kernelCompileCount = 0;

/** How many path tracing kernels this page has compiled so far: a job of many frames compiles each kernel once. */
export function webGpuKernelCompileCount() {
  return kernelCompileCount;
}

async function createSession() {
  if (!isWebGpuTracerAvailable()) {
    throw new Error('The WebGPU path tracer needs navigator.gpu, which this page does not have. Use backend "gpu" (WebGL2) or "cpu".');
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('The WebGPU path tracer found no WebGPU adapter. Use backend "gpu" (WebGL2) or "cpu".');
  if (adapter.limits.maxStorageBuffersPerShaderStage < STORAGE_BUFFER_COUNT) {
    throw new Error(`The WebGPU path tracer needs ${STORAGE_BUFFER_COUNT} storage buffers per shader stage and this adapter allows ${adapter.limits.maxStorageBuffersPerShaderStage}. Use backend "gpu".`);
  }
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBuffersPerShaderStage: STORAGE_BUFFER_COUNT,
      maxStorageBufferBindingSize: Math.min(adapter.limits.maxStorageBufferBindingSize, MAXIMUM_BUFFER_BYTES),
      maxBufferSize: Math.min(adapter.limits.maxBufferSize, MAXIMUM_BUFFER_BYTES),
    },
  });
  const entries = [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: PARAMETER_BYTES } }];
  for (let binding = 1; binding < STORAGE_BUFFER_COUNT + 1; binding++) {
    entries.push({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: binding <= 7 ? 'read-only-storage' : 'storage' } });
  }
  const bindGroupLayout = device.createBindGroupLayout({ entries });
  const info = adapter.info ?? {};
  return {
    device, bindGroupLayout, pipelineLayout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    gpu: `${info.vendor ?? 'webgpu'} ${info.architecture ?? ''}`.trim(), kernels: new Map(),
  };
}

async function getSession() {
  session ??= createSession().catch((error) => {
    session = null;
    throw error;
  });
  return session;
}

/** The WGSL and entry points of a kernel variant; a variant is one of the two kernels, with the optional parts a scene needs. */
function describeVariant({ kernel, hasVolume, hasSubsurface, texelBake, realtime }) {
  if (kernel === 'wavefront') return { code: WAVEFRONT_SOURCE, entryPoints: WAVEFRONT_ENTRY_POINTS };
  if (realtime) return { code: buildMegakernelSource({ hasVolume, hasSubsurface, realtime }), entryPoints: ['traceRealtime'] };
  return { code: buildMegakernelSource({ hasVolume, hasSubsurface, texelBake }), entryPoints: [texelBake ? 'bakeTexels' : 'main'] };
}

async function compileKernel(current, variant) {
  const { device, pipelineLayout } = current;
  const started = performance.now();
  const { code, entryPoints } = describeVariant(variant);
  const module = device.createShaderModule({ label: `path tracer ${variant.kernel}`, code });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter(message => message.type === 'error');
  if (errors.length > 0) throw new Error(`The WebGPU path tracer shader did not compile: ${errors.slice(0, 8).map(message => `${message.lineNum}: ${message.message}`).join('; ')}`);
  const pipelines = await Promise.all(entryPoints.map(entryPoint => device.createComputePipelineAsync({ layout: pipelineLayout, compute: { module, entryPoint } })));
  kernelCompileCount++;
  return { pipelines: Object.fromEntries(entryPoints.map((entryPoint, index) => [entryPoint, pipelines[index]])), compileSeconds: (performance.now() - started) / 1000 };
}

async function getKernel(current, variant) {
  const key = [variant.kernel, variant.hasVolume, variant.hasSubsurface, variant.texelBake, Boolean(variant.realtime)].join(':');
  if (!current.kernels.has(key)) current.kernels.set(key, compileKernel(current, variant));
  return current.kernels.get(key);
}

/** The optional parts the scene needs, as the kernel variant flags. */
function sceneFeatures(scene) {
  return { hasVolume: Boolean(scene.volume), hasSubsurface: sceneUsesSubsurface(scene.materials), texelBake: false };
}

function createStorageBuffer(device, data, label) {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const buffer = device.createBuffer({ label, size: Math.max(16, Math.ceil(bytes.byteLength / 4) * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(buffer, 0, bytes);
  return buffer;
}

function atlasWords(atlas) {
  return new Uint32Array(atlas.data.buffer, atlas.data.byteOffset, Math.floor(atlas.data.byteLength / 4));
}

function uploadScene(device, scene, requestedLightSelection = 'uniform') {
  const atlas = packAtlas(scene.materials);
  const lights = packLights(scene.lights);
  // With the light tree the node table follows the light table in the same buffer; treeBase is the vector index of its first node.
  const useLightTree = resolveLightSelection(requestedLightSelection, scene.lights) === 'tree' && lights.count > 1;
  const lightTableData = lights.table.data;
  const lightTreeBase = useLightTree ? lightTableData.length / 4 : 0;
  const lightTreeData = useLightTree ? packLightTree(scene.lights).data : new Float32Array(0);
  const lightsWithTree = new Float32Array(lightTableData.length + lightTreeData.length);
  lightsWithTree.set(lightTableData);
  lightsWithTree.set(lightTreeData, lightTableData.length);
  const environment = packEnvironment(scene.environment);
  const environmentTables = new Float32Array(environment ? environment.height + environment.width * environment.height : 4);
  if (environment) {
    environmentTables.set(environment.rows.data.subarray(0, environment.height), 0);
    environmentTables.set(environment.pixels.data.subarray(0, environment.width * environment.height), environment.height);
  }
  // The subsurface table (two vectors per material) follows the material table in the same buffer.
  const materialData = packMaterials(scene.materials, atlas).data;
  const subsurfaceOffset = materialData.length / 4;
  const subsurfaceData = sceneUsesSubsurface(scene.materials) ? packSubsurface(scene.materials).data : new Float32Array(0);
  const materialsWithSubsurface = new Float32Array(materialData.length + subsurfaceData.length);
  materialsWithSubsurface.set(materialData);
  materialsWithSubsurface.set(subsurfaceData, materialData.length);
  const buffers = [
    createStorageBuffer(device, packNodes(scene.bvh).data, 'bvh nodes'),
    createStorageBuffer(device, packTriangles(scene).data, 'triangles'),
    createStorageBuffer(device, materialsWithSubsurface, 'materials'),
    createStorageBuffer(device, lightsWithTree, 'lights'),
    createStorageBuffer(device, atlasWords(atlas), 'texture atlas'),
    createStorageBuffer(device, environment?.colors ?? new Float32Array(4), 'environment colors'),
    createStorageBuffer(device, environmentTables, 'environment tables'),
  ];
  return { buffers, lightCount: lights.count, lightTreeBase, atlasWidth: atlas.width, subsurfaceOffset };
}

/** The words of one uniform block: the 12 vectors of the megakernel parameters, then the tile and shadow slot words. */
function createParameterTemplate(scene, camera, options, uploaded, emitterCount) {
  const words = new ArrayBuffer(PARAMETER_BYTES);
  const floats = new Float32Array(words);
  const integers = new Int32Array(words);
  const unsigned = new Uint32Array(words);
  const { sun } = scene.lights;
  const { environment } = scene;
  floats.set([...camera.eye, 0], 0);
  floats.set([...camera.forward, 0], 4);
  floats.set([...camera.right, 0], 8);
  floats.set([...camera.above, 0], 12);
  floats.set([...(sun?.direction ?? [0, 1, 0]), 0], 16);
  floats.set([...(sun?.color ?? [0, 0, 0]), Math.cos(Math.PI / 360)], 20);
  floats.set([environment?.width ?? 1, environment?.height ?? 1, environment?.intensity ?? 1, environment?.total ?? 1], 24);
  floats.set([environment?.cosine ?? 1, environment?.sine ?? 0, scene.surfaceOffset, scene.farDistance], 28);
  floats.set([camera.halfWidth, camera.halfHeight, options.fireflyClamp, uploaded.lightTreeBase], 32);
  integers.set([options.width, options.height, options.bounces, uploaded.lightCount], 36);
  integers.set([emitterCount, sun ? 1 : 0, environment ? 1 : 0, 0], 40);
  unsigned.set([options.seed >>> 0, uploaded.atlasWidth, uploaded.subsurfaceOffset, 0], 44);
  const { volume } = scene;
  floats.set([...(volume?.minimum ?? [0, 0, 0]), volume?.density ?? 0], 56);
  floats.set([...(volume?.maximum ?? [0, 0, 0]), volume?.anisotropy ?? 0], 60);
  floats.set([...(volume?.albedo ?? [1, 1, 1]), volume?.maxDistance ?? 0], 64);
  return { unsigned, integers };
}

const SAMPLE_INDEX_WORD = 43;
const TILE_WORD = 48;
const SHADOW_SLOT_WORD = 52;
const SORT_FLAG_WORD = 53;
// The texel kernel keeps the sample count in a shadow slot word the megakernel leaves unused.
const SAMPLE_COUNT_WORD = 54;

/** Fills one 256 byte slot per (tile, depth) of a sample; the kernels find their tile and depth in the slot they are bound to. */
function writeParameterSlots(template, sampleIndex, tiles, depthCount, materialCount, shadowSlots, sortByMaterial) {
  const bytes = new Uint8Array(tiles.length * depthCount * PARAMETER_SLOT_BYTES);
  tiles.forEach((tile, tileIndex) => {
    for (let depth = 0; depth < depthCount; depth++) {
      const slot = new Uint32Array(bytes.buffer, (tileIndex * depthCount + depth) * PARAMETER_SLOT_BYTES, PARAMETER_BYTES / 4);
      slot.set(template.unsigned);
      slot[SAMPLE_INDEX_WORD] = sampleIndex;
      slot.set([tile.start, tile.count, depth, materialCount], TILE_WORD);
      slot[SHADOW_SLOT_WORD] = shadowSlots;
      slot[SORT_FLAG_WORD] = sortByMaterial ? 1 : 0;
    }
  });
  return bytes;
}

// Path numbers run over whole 8 by 8 blocks of pixels, so there can be a few more paths than pixels; a tile is a whole number of blocks.
function planTiles(width, height, shadowSlots) {
  const pathCount = Math.ceil(width / 8) * Math.ceil(height / 8) * 64;
  const pathBytes = (PATH_STATE_VECTORS + 3 * shadowSlots) * 16;
  const tilePaths = Math.min(pathCount, Math.floor(Math.min(MAXIMUM_TILE_PATHS, MAXIMUM_STATE_BYTES / pathBytes) / 64) * 64);
  const tiles = [];
  for (let start = 0; start < pathCount; start += tilePaths) tiles.push({ start, count: Math.min(tilePaths, pathCount - start) });
  return { tiles, tilePaths, stateBytes: tilePaths * pathBytes };
}

function averageBuffers(planes, pixelCount, samples) {
  const buffers = {
    color: new Float32Array(pixelCount * 3), albedo: new Float32Array(pixelCount * 3), normal: new Float32Array(pixelCount * 3),
    depth: new Float32Array(pixelCount), variance: new Float32Array(pixelCount), samplesTaken: new Uint16Array(pixelCount).fill(samples),
  };
  const albedoPlane = pixelCount * 4;
  const normalPlane = pixelCount * 8;
  const statisticsPlane = pixelCount * 12;
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    for (let channel = 0; channel < 3; channel++) {
      buffers.color[pixel * 3 + channel] = planes[pixel * 4 + channel] / samples;
      buffers.albedo[pixel * 3 + channel] = planes[albedoPlane + pixel * 4 + channel] / samples;
      buffers.normal[pixel * 3 + channel] = planes[normalPlane + pixel * 4 + channel] / samples;
    }
    buffers.depth[pixel] = planes[pixel * 4 + 3] / samples;
    const mean = planes[statisticsPlane + pixel * 4] / samples;
    buffers.variance[pixel] = Math.max(0, planes[statisticsPlane + pixel * 4 + 1] / samples - mean * mean) / Math.max(samples - 1, 1);
  }
  return buffers;
}

function encodeWavefrontSample(pass, pipelines, bindGroup, tiles, depthCount, materialCount, sortByMaterial) {
  const groupsFor = count => Math.ceil(count / WAVEFRONT_WORKGROUP_SIZE);
  const run = (entryPoint, groups) => {
    pass.setPipeline(pipelines[entryPoint]);
    pass.dispatchWorkgroups(groups);
  };
  tiles.forEach((tile, tileIndex) => {
    const bind = depth => pass.setBindGroup(0, bindGroup, [(tileIndex * depthCount + depth) * PARAMETER_SLOT_BYTES]);
    bind(0);
    run('generatePaths', groupsFor(tile.count));
    for (let depth = 0; depth < depthCount; depth++) {
      bind(depth);
      if (sortByMaterial) run('resetBins', groupsFor(Math.max(materialCount, 1)));
      run('extendPaths', groupsFor(tile.count));
      if (sortByMaterial) {
        run('scanBins', 1);
        run('scatterPaths', groupsFor(tile.count));
      }
      run('shadePaths', groupsFor(tile.count));
      run('shadowPaths', groupsFor(tile.count));
    }
    bind(0);
    run('resolvePaths', groupsFor(tile.count));
  });
}

/**
 * Traces `options.samples` paths for every pixel and resolves with the same buffers as the WebGL2 tracer (color, albedo,
 * normal, depth, variance, samplesTaken) plus a `gpu` note and the `compileSeconds` of the kernel. `options.kernel` picks
 * `wavefront` or `megakernel` (the default is DEFAULT_WEBGPU_KERNEL). `noiseThreshold` is not used: every pixel draws all its
 * samples. `shouldStop` throws when the time limit passes; it runs between samples.
 */
export async function traceOnWebGpu(scene, camera, options, shouldStop) {
  const kernel = options.kernel ?? DEFAULT_WEBGPU_KERNEL;
  if (!WEBGPU_KERNELS.includes(kernel)) throw new RangeError(`The WebGPU path tracer kernel must be one of ${WEBGPU_KERNELS.join(', ')}.`);
  const features = sceneFeatures(scene);
  if (kernel === 'wavefront' && (features.hasVolume || features.hasSubsurface)) {
    throw new RangeError('The WebGPU wavefront kernel does not trace volume fog or subsurface scattering. Use the megakernel, the default.');
  }
  const current = await getSession();
  const { device } = current;
  const { pipelines, compileSeconds } = await getKernel(current, { kernel, ...features });
  const { width, height, samples } = options;
  const pixelCount = width * height;
  const planeBytes = pixelCount * 16;
  if (planeBytes * 4 > device.limits.maxStorageBufferBindingSize) {
    throw new RangeError(`A ${width} by ${height} image is too large for this WebGPU adapter. Lower the size or use backend "gpu".`);
  }
  const uploaded = uploadScene(device, scene, options.lightSelection);
  const emitterCount = (scene.lights.sun ? 1 : 0) + uploaded.lightCount + (scene.environment ? 1 : 0);
  const shadowSlots = Math.max(emitterCount, 1);
  const materialCount = scene.materials.length;
  const depthCount = options.bounces + 1;
  const isWavefront = kernel === 'wavefront';
  const sortByMaterial = options.sortByMaterial ?? DEFAULT_SORT_BY_MATERIAL;
  const { tiles, tilePaths, stateBytes } = planTiles(width, height, shadowSlots);
  const slotCount = isWavefront ? tiles.length * depthCount : 1;
  const accumulation = device.createBuffer({ label: 'accumulation', size: planeBytes * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const parameters = device.createBuffer({ label: 'parameters', size: slotCount * PARAMETER_SLOT_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const stateBuffer = device.createBuffer({ label: 'path state', size: isWavefront ? stateBytes : 16, usage: GPUBufferUsage.STORAGE });
  const queueWords = 1 + 2 * materialCount + tilePaths;
  const binQueue = device.createBuffer({ label: 'material bins', size: isWavefront ? queueWords * 4 : 16, usage: GPUBufferUsage.STORAGE });
  const bindGroup = device.createBindGroup({
    layout: current.bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: parameters, size: PARAMETER_BYTES } },
      ...[...uploaded.buffers, accumulation, stateBuffer, binQueue].map((buffer, index) => ({ binding: index + 1, resource: { buffer } })),
    ],
  });
  const template = createParameterTemplate(scene, camera, options, uploaded, emitterCount);
  for (let sample = 0; sample < samples; sample++) {
    const slots = writeParameterSlots(template, sample, isWavefront ? tiles : [{ start: 0, count: pixelCount }], isWavefront ? depthCount : 1, materialCount, shadowSlots, sortByMaterial);
    device.queue.writeBuffer(parameters, 0, slots);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    if (isWavefront) {
      encodeWavefrontSample(pass, pipelines, bindGroup, tiles, depthCount, materialCount, sortByMaterial);
    } else {
      pass.setPipeline(pipelines.main);
      pass.setBindGroup(0, bindGroup, [0]);
      pass.dispatchWorkgroups(Math.ceil(width / WORKGROUP_SIZE), Math.ceil(height / WORKGROUP_SIZE));
    }
    pass.end();
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    shouldStop();
  }
  const readback = device.createBuffer({ size: planeBytes * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(accumulation, 0, readback, 0, planeBytes * 4);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const buffers = averageBuffers(new Float32Array(readback.getMappedRange()), pixelCount, samples);
  readback.destroy();
  for (const buffer of [...uploaded.buffers, accumulation, parameters, stateBuffer, binQueue]) buffer.destroy();
  return Object.assign(buffers, { gpu: current.gpu, compileSeconds });
}

/**
 * The pieces the real-time tracer (path-tracer-realtime-webgpu.js) builds its frame from, given its kernel's WGSL `realtimePieces`: the device, the real-time kernel's
 * pipeline and bind group layout for `scene`, the uploaded scene tables, and `parameterWords(camera)`, the words of the
 * parameter block for a camera (the caller sets the sample index and the cache words).
 */
export async function prepareRealtimeKernel(scene, options, realtimePieces) {
  const current = await getSession();
  const { device } = current;
  const { pipelines, compileSeconds } = await getKernel(current, { kernel: 'megakernel', ...sceneFeatures(scene), realtime: realtimePieces });
  const uploaded = uploadScene(device, scene);
  const emitterCount = (scene.lights.sun ? 1 : 0) + uploaded.lightCount + (scene.environment ? 1 : 0);
  return {
    device, gpu: current.gpu, compileSeconds, uploaded,
    bindGroupLayout: current.bindGroupLayout,
    pipeline: pipelines.traceRealtime,
    parameterBytes: PARAMETER_BYTES,
    parameterWords: camera => createParameterTemplate(scene, camera, options, uploaded, emitterCount).unsigned,
  };
}

const TEXEL_GROUPS_PER_ROW = 4096;
const TEXEL_SAMPLES_PER_WAIT = 16;

function padVectors(vectors, count) {
  const padded = new Float32Array(Math.max(count, 1) * 4);
  for (let index = 0; index < count; index++) padded.set(vectors.subarray(index * 3, index * 3 + 3), index * 4);
  return padded;
}

/**
 * The texel entry of the light bake, the WebGPU form of `traceTexelsOnGpu` in path-tracer-gpu.js: traces `options.samples`
 * cosine weighted paths from every texel in `texels` (`count`, `points` and `normals`, three floats each) and resolves with
 * the mean `radiance` that arrives (three floats per texel), the share of first rays that `escaped`, the `gpu` name and the
 * `compileSeconds` of the kernel. `options.bounces` counts hits, as in the CPU bake.
 */
export async function traceTexelsOnWebGpu(scene, texels, options, shouldStop) {
  const current = await getSession();
  const { device } = current;
  const { count, points, normals } = texels;
  const { samples, seed } = options;
  const features = { ...sceneFeatures(scene), texelBake: true };
  const { pipelines, compileSeconds } = await getKernel(current, { kernel: 'megakernel', ...features });
  const accumulationBytes = Math.max(count, 1) * 16 * 2;
  if (accumulationBytes > device.limits.maxStorageBufferBindingSize) {
    throw new RangeError(`${count} lightmap texels are too many for this WebGPU adapter. Lower the lightmap resolution or use backend "gpu".`);
  }
  const uploaded = uploadScene(device, scene);
  const emitterCount = (scene.lights.sun ? 1 : 0) + uploaded.lightCount + (scene.environment ? 1 : 0);
  const camera = { eye: [0, 0, 0], forward: [0, 0, 1], right: [1, 0, 0], above: [0, 1, 0], halfWidth: 1, halfHeight: 1 };
  const template = createParameterTemplate(scene, camera, { width: count, height: 1, seed, bounces: options.bounces - 1, fireflyClamp: options.fireflyClamp }, uploaded, emitterCount);
  template.unsigned[SAMPLE_COUNT_WORD] = samples;
  const accumulation = device.createBuffer({ label: 'accumulation', size: accumulationBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const parameters = device.createBuffer({ label: 'parameters', size: PARAMETER_SLOT_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const texelBuffers = [padVectors(points, count), padVectors(normals, count)].map((vectors, index) => createStorageBuffer(device, vectors, index === 0 ? 'texel points' : 'texel normals'));
  const bindGroup = device.createBindGroup({
    layout: current.bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: parameters, size: PARAMETER_BYTES } },
      ...[...uploaded.buffers, accumulation, ...texelBuffers].map((buffer, index) => ({ binding: index + 1, resource: { buffer } })),
    ],
  });
  const groups = Math.max(1, Math.ceil(count / WAVEFRONT_WORKGROUP_SIZE));
  const groupsAcross = Math.min(groups, TEXEL_GROUPS_PER_ROW);
  for (let sample = 0; sample < samples; sample++) {
    device.queue.writeBuffer(parameters, 0, writeParameterSlots(template, sample, [{ start: 0, count }], 1, 0, 1, false));
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipelines.bakeTexels);
    pass.setBindGroup(0, bindGroup, [0]);
    pass.dispatchWorkgroups(groupsAcross, Math.ceil(groups / groupsAcross));
    pass.end();
    device.queue.submit([encoder.finish()]);
    // A texel pass is short, so the queue is awaited every few samples: one round trip per sample would dominate the bake.
    if ((sample + 1) % TEXEL_SAMPLES_PER_WAIT === 0 || sample === samples - 1) {
      await device.queue.onSubmittedWorkDone();
      shouldStop();
    }
  }
  const readback = device.createBuffer({ size: accumulationBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(accumulation, 0, readback, 0, accumulationBytes);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const sums = new Float32Array(readback.getMappedRange());
  const radiance = new Float32Array(count * 3);
  const escaped = new Float32Array(count);
  for (let texel = 0; texel < count; texel++) {
    for (let channel = 0; channel < 3; channel++) radiance[texel * 3 + channel] = sums[texel * 4 + channel] / samples;
    escaped[texel] = sums[(count + texel) * 4] / samples;
  }
  readback.destroy();
  for (const buffer of [...uploaded.buffers, accumulation, parameters, ...texelBuffers]) buffer.destroy();
  return { radiance, escaped, gpu: current.gpu, compileSeconds };
}

// The names path-tracer.js looks for in a backend module, the same as path-tracer-gpu.js.
export { traceOnWebGpu as traceOnGpu, webGpuKernelCompileCount as gpuKernelCompileCount };
