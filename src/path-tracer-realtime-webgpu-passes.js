import { CACHE_HISTORY_LIMIT, CACHE_SLOT_COUNT } from './path-tracer-radiance-cache.js';
import { DEFAULT_FILTER_ITERATIONS, DEFAULT_HISTORY_LIMIT } from './path-tracer-temporal-denoise.js';
import { DEPTH_TOLERANCE, NORMAL_AGREEMENT, PART_MOTION_CHANGED, PART_MOTION_FLOATS } from './path-tracer-reprojection.js';

// The compute passes of the WebGPU real-time tracer (issue #624): the radiance cache update and the temporal denoiser,
// the WGSL form of path-tracer-radiance-cache.js and path-tracer-temporal-denoise.js (read those for the reasoning). Two
// differences from the WebGL2 passes:
//   - the cache sums the records with atomic adds on fixed point numbers (WebGL2 has no atomics, so it blends points);
//   - history is also rejected where the material at the first hit differs (the fourth value of the normal plane).
// Every image is a storage buffer of vec4 in row order. The traced frame holds three planes: radiance and distance,
// albedo, normal and material. History holds three: colour and length, moments and variance, albedo.

const FIXED_POINT_SCALE = 1024;
const RECORD_LIMIT = 32;
const MINIMUM_ALBEDO = 0.02;
const SPATIAL_VARIANCE_HISTORY = 4;
const FIREFLY_DEVIATIONS = 2.5;
const SHORT_HISTORY_LENGTH = 8;
const CACHE_WORKGROUP_SIZE = 256;
const CACHE_PARAMETER_BYTES = 16;
const DENOISE_PARAMETER_BYTES = 12 * 16;

const CACHE_SOURCE = /* wgsl */ `
@group(0) @binding(0) var<storage, read> records: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> sums: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read_write> cacheTable: array<vec4<f32>>;
@group(0) @binding(3) var<uniform> recordCount: vec4<u32>;

// A record is the light the rest of a path brought (rgb) and the cell it belongs to (a, one more than the slot; 0 for none).
@compute @workgroup_size(${CACHE_WORKGROUP_SIZE})
fn scatterRecords(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let index = id.y * groups.x * ${CACHE_WORKGROUP_SIZE}u + id.x;
  if (index >= recordCount.x) { return; }
  let record = records[index];
  if (record.w < 0.5) { return; }
  let slot = u32(record.w) - 1u;
  let fixedValues = vec3<u32>(min(record.xyz, vec3<f32>(${RECORD_LIMIT}.0)) * ${FIXED_POINT_SCALE}.0);
  atomicAdd(&sums[slot * 4u], fixedValues.x);
  atomicAdd(&sums[slot * 4u + 1u], fixedValues.y);
  atomicAdd(&sums[slot * 4u + 2u], fixedValues.z);
  atomicAdd(&sums[slot * 4u + 3u], 1u);
}

// Folds the records of the frame into the running average of each cell, and empties the sums for the next frame.
@compute @workgroup_size(${CACHE_WORKGROUP_SIZE})
fn resolveCells(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let slot = id.y * groups.x * ${CACHE_WORKGROUP_SIZE}u + id.x;
  if (slot >= ${CACHE_SLOT_COUNT}u) { return; }
  let count = f32(atomicLoad(&sums[slot * 4u + 3u]));
  if (count < 0.5) { return; }
  let sum = vec3<f32>(f32(atomicLoad(&sums[slot * 4u])), f32(atomicLoad(&sums[slot * 4u + 1u])), f32(atomicLoad(&sums[slot * 4u + 2u])));
  for (var word = 0u; word < 4u; word++) { atomicStore(&sums[slot * 4u + word], 0u); }
  let previous = cacheTable[slot];
  let weight = count / (min(previous.w, ${CACHE_HISTORY_LIMIT}.0) + count);
  cacheTable[slot] = vec4<f32>(mix(previous.xyz, sum / ${FIXED_POINT_SCALE}.0 / count, weight), previous.w + count);
}
`;

const DENOISE_COMMON = /* wgsl */ `
struct DenoiseParams {
  eye: vec4<f32>,
  forward: vec4<f32>,
  right: vec4<f32>,
  above: vec4<f32>,
  previousEye: vec4<f32>,
  previousForward: vec4<f32>,
  previousRight: vec4<f32>,
  previousAbove: vec4<f32>,
  halves: vec4<f32>,
  sizes: vec4<i32>,
  settings: vec4<f32>,
  outputLayout: vec4<u32>,
}
// sizes: trace width and height, output width and height. settings: far distance, history limit, reset flag, a-trous step.
// outputLayout: words per output row, 1 when the canvas format is bgra.
@group(0) @binding(0) var<uniform> params: DenoiseParams;

const MINIMUM_ALBEDO: f32 = ${MINIMUM_ALBEDO};
const DEPTH_TOLERANCE: f32 = ${DEPTH_TOLERANCE};
const NORMAL_AGREEMENT: f32 = ${NORMAL_AGREEMENT};

fn luminanceOf(color: vec3<f32>) -> f32 {
  return dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
}

fn distanceOf(radianceAndDistance: vec4<f32>) -> f32 {
  return select(params.settings.x, radianceAndDistance.w, radianceAndDistance.w > 0.0);
}

fn pixelRayDirection(pixelPosition: vec2<f32>, size: vec2<f32>) -> vec3<f32> {
  let screenX = (pixelPosition.x / size.x * 2.0 - 1.0) * params.halves.x;
  let screenY = (1.0 - pixelPosition.y / size.y * 2.0) * params.halves.y;
  return normalize(params.forward.xyz + params.right.xyz * screenX + params.above.xyz * screenY);
}

// Where a world point was on screen in the previous frame (xy), its distance from the previous eye (z), and w = 1 when it was in front of the camera.
fn projectToPrevious(point: vec3<f32>, size: vec2<f32>) -> vec4<f32> {
  let offset = point - params.previousEye.xyz;
  let alongView = dot(offset, params.previousForward.xyz);
  if (!(alongView > 1e-6)) { return vec4<f32>(0.0); }
  let screenX = dot(offset, params.previousRight.xyz) / alongView / params.halves.z;
  let screenY = dot(offset, params.previousAbove.xyz) / alongView / params.halves.w;
  return vec4<f32>(vec2<f32>(screenX * 0.5 + 0.5, 0.5 - screenY * 0.5) * size, length(offset), 1.0);
}

fn isHistoryConsistent(expectedDistance: f32, historyDistance: f32, normal: vec3<f32>, historyNormal: vec3<f32>, material: f32, historyMaterial: f32) -> bool {
  return abs(historyDistance - expectedDistance) <= DEPTH_TOLERANCE * expectedDistance && dot(normal, historyNormal) >= NORMAL_AGREEMENT && abs(material - historyMaterial) < 0.5;
}

fn pixelIndex(texel: vec2<i32>) -> u32 {
  return u32(texel.y * params.sizes.x + texel.x);
}

fn planeSize() -> u32 {
  return u32(params.sizes.x * params.sizes.y);
}

fn insideTraceImage(texel: vec2<i32>) -> bool {
  return all(texel >= vec2<i32>(0)) && all(texel < params.sizes.xy);
}
`;

/**
 * The motion table of the parts (see partMotionTable in path-tracer-reprojection.js) at binding `binding`, and the lookup
 * of where a surface point of this frame was in the previous frame. The result's w is 0 when history cannot be reused.
 */
const partMotionSource = binding => /* wgsl */ `
@group(0) @binding(${binding}) var<storage, read> partMotion: array<vec4<f32>>;

fn previousPointOf(point: vec3<f32>, material: f32) -> vec4<f32> {
  if (material < 0.5) { return vec4<f32>(point, 1.0); }
  let base = u32(material - 1.0) * ${PART_MOTION_FLOATS / 4}u;
  let kind = partMotion[base + 3u].x;
  if (kind < 0.5) { return vec4<f32>(point, 1.0); }
  if (kind > ${PART_MOTION_CHANGED}.0 - 0.5) { return vec4<f32>(point, 0.0); }
  let rowX = partMotion[base];
  let rowY = partMotion[base + 1u];
  let rowZ = partMotion[base + 2u];
  return vec4<f32>(dot(rowX.xyz, point) + rowX.w, dot(rowY.xyz, point) + rowY.w, dot(rowZ.xyz, point) + rowZ.w, 1.0);
}
`;

const ACCUMULATE_SOURCE = DENOISE_COMMON + partMotionSource(6) + /* wgsl */ `
@group(0) @binding(1) var<storage, read> traced: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> tracedPrevious: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> historyPrevious: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> historyCurrent: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> filtered: array<vec4<f32>>;

fn illuminationAt(texel: vec2<i32>) -> vec3<f32> {
  let index = pixelIndex(clamp(texel, vec2<i32>(0), params.sizes.xy - vec2<i32>(1)));
  return traced[index].rgb / max(traced[planeSize() + index].rgb, vec3<f32>(MINIMUM_ALBEDO));
}

@compute @workgroup_size(8, 8, 1)
fn accumulate(@builtin(global_invocation_id) id: vec3<u32>) {
  let texel = vec2<i32>(id.xy);
  if (!insideTraceImage(texel)) { return; }
  let plane = planeSize();
  let index = pixelIndex(texel);
  let tracedValue = traced[index];
  let albedo = traced[plane + index].rgb;
  let normalAndMaterial = traced[2u * plane + index];
  let normal = normalAndMaterial.xyz;
  var illumination = tracedValue.rgb / max(albedo, vec3<f32>(MINIMUM_ALBEDO));
  let size = vec2<f32>(params.sizes.xy);
  let point = params.eye.xyz + pixelRayDirection(vec2<f32>(texel) + 0.5, size) * distanceOf(tracedValue);
  let previousPoint = previousPointOf(point, normalAndMaterial.w);

  var history = vec4<f32>(0.0);
  var historyMoments = vec4<f32>(0.0);
  var historyAlbedo = vec3<f32>(0.0);
  var totalWeight = 0.0;
  let projection = projectToPrevious(previousPoint.xyz, size);
  if (params.settings.z < 0.5 && projection.w > 0.5 && previousPoint.w > 0.5) {
    let base = floor(projection.xy - 0.5);
    let fraction = projection.xy - 0.5 - base;
    for (var tap = 0; tap < 4; tap++) {
      let offset = vec2<i32>(tap & 1, tap >> 1u);
      let historyTexel = vec2<i32>(base) + offset;
      if (!insideTraceImage(historyTexel)) { continue; }
      let weight = select(1.0 - fraction.x, fraction.x, offset.x == 1) * select(1.0 - fraction.y, fraction.y, offset.y == 1);
      let historyIndex = pixelIndex(historyTexel);
      let previousNormal = tracedPrevious[2u * plane + historyIndex];
      if (!isHistoryConsistent(projection.z, distanceOf(tracedPrevious[historyIndex]), normal, previousNormal.xyz, normalAndMaterial.w, previousNormal.w)) { continue; }
      history += weight * historyPrevious[historyIndex];
      historyMoments += weight * historyPrevious[plane + historyIndex];
      historyAlbedo += weight * historyPrevious[2u * plane + historyIndex].rgb;
      totalWeight += weight;
    }
  }

  // While the history is short, a sample far above its eight neighbours is a firefly: bring it down to their mean plus a few
  // deviations. A long history averages the spikes in instead, which keeps the energy a clamp would cut.
  var neighbourSum = 0.0;
  var neighbourSumOfSquares = 0.0;
  for (var offsetY = -1; offsetY <= 1; offsetY++) {
    for (var offsetX = -1; offsetX <= 1; offsetX++) {
      if (offsetX == 0 && offsetY == 0) { continue; }
      let neighbour = luminanceOf(illuminationAt(texel + vec2<i32>(offsetX, offsetY)));
      neighbourSum += neighbour;
      neighbourSumOfSquares += neighbour * neighbour;
    }
  }
  let neighbourMean = neighbourSum / 8.0;
  let neighbourDeviation = sqrt(max(0.0, neighbourSumOfSquares / 8.0 - neighbourMean * neighbourMean));
  let luminanceLimit = neighbourMean * 1.05 + ${FIREFLY_DEVIATIONS} * neighbourDeviation + 0.01;
  var luminance = luminanceOf(illumination);
  let shortHistory = totalWeight <= 1e-3 || history.w < ${SHORT_HISTORY_LENGTH}.0;
  if (shortHistory && luminance > luminanceLimit) {
    illumination *= luminanceLimit / luminance;
    luminance = luminanceLimit;
  }
  let currentMoments = vec2<f32>(luminance, luminance * luminance);
  var color = illumination;
  var blendedAlbedo = albedo;
  var moments = currentMoments;
  var historyLength = 1.0;
  if (totalWeight > 1e-3) {
    history /= totalWeight;
    historyMoments /= totalWeight;
    historyAlbedo /= totalWeight;
    historyLength = min(history.w + 1.0, params.settings.y);
    let blend = 1.0 / historyLength;
    color = mix(history.rgb, illumination, blend);
    blendedAlbedo = mix(historyAlbedo, albedo, blend);
    moments = mix(historyMoments.xy, currentMoments, blend);
  }
  var variance = max(0.0, moments.y - moments.x * moments.x);
  if (historyLength < ${SPATIAL_VARIANCE_HISTORY}.0) {
    let sum = neighbourSum + luminance;
    let sumOfSquares = neighbourSumOfSquares + luminance * luminance;
    variance = max(0.0, sumOfSquares / 9.0 - (sum / 9.0) * (sum / 9.0));
  }
  historyCurrent[index] = vec4<f32>(color, historyLength);
  historyCurrent[plane + index] = vec4<f32>(moments, variance, 0.0);
  historyCurrent[2u * plane + index] = vec4<f32>(blendedAlbedo, 1.0);
  filtered[index] = vec4<f32>(color, variance);
}
`;

const ATROUS_SOURCE = DENOISE_COMMON + /* wgsl */ `
@group(0) @binding(1) var<storage, read> traced: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> filterIn: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> filterOut: array<vec4<f32>>;

const PLANE_SIGMA: f32 = 0.02;
const LUMINANCE_SIGMA: f32 = 4.0;
const NORMAL_POWER: f32 = 64.0;

fn kernelWeight(offset: i32) -> f32 {
  if (offset == 0) { return 0.375; }
  if (offset == 1) { return 0.25; }
  return 0.0625;
}

@compute @workgroup_size(8, 8, 1)
fn atrous(@builtin(global_invocation_id) id: vec3<u32>) {
  let texel = vec2<i32>(id.xy);
  if (!insideTraceImage(texel)) { return; }
  let plane = planeSize();
  let size = vec2<f32>(params.sizes.xy);
  let stride = i32(params.settings.w);
  let index = pixelIndex(texel);
  let center = filterIn[index];
  let centerNormal = traced[2u * plane + index].xyz;
  let centerDistance = distanceOf(traced[index]);
  let centerPoint = pixelRayDirection(vec2<f32>(texel) + 0.5, size) * centerDistance;
  let centerLuminance = luminanceOf(center.rgb);
  var smoothedVariance = 0.0;
  for (var offsetY = -1; offsetY <= 1; offsetY++) {
    for (var offsetX = -1; offsetX <= 1; offsetX++) {
      let neighbour = clamp(texel + vec2<i32>(offsetX, offsetY), vec2<i32>(0), params.sizes.xy - vec2<i32>(1));
      smoothedVariance += filterIn[pixelIndex(neighbour)].w * select(0.25, 0.5, offsetX == 0) * select(0.25, 0.5, offsetY == 0);
    }
  }
  let luminanceScale = LUMINANCE_SIGMA * sqrt(max(smoothedVariance, 0.0)) + 1e-4;

  var sumColor = vec3<f32>(0.0);
  var sumVariance = 0.0;
  var sumWeight = 0.0;
  for (var offsetY = -2; offsetY <= 2; offsetY++) {
    for (var offsetX = -2; offsetX <= 2; offsetX++) {
      let neighbour = texel + vec2<i32>(offsetX, offsetY) * stride;
      if (!insideTraceImage(neighbour)) { continue; }
      let neighbourIndex = pixelIndex(neighbour);
      let value = filterIn[neighbourIndex];
      let neighbourDistance = distanceOf(traced[neighbourIndex]);
      let neighbourPoint = pixelRayDirection(vec2<f32>(neighbour) + 0.5, size) * neighbourDistance;
      let planeDistance = abs(dot(centerNormal, neighbourPoint - centerPoint));
      let planeWeight = exp(-planeDistance / (PLANE_SIGMA * centerDistance));
      let normalWeight = pow(max(dot(centerNormal, traced[2u * plane + neighbourIndex].xyz), 0.0), NORMAL_POWER);
      let luminanceWeight = exp(-abs(luminanceOf(value.rgb) - centerLuminance) / luminanceScale);
      let weight = kernelWeight(abs(offsetX)) * kernelWeight(abs(offsetY)) * planeWeight * normalWeight * luminanceWeight;
      sumColor += weight * value.rgb;
      sumVariance += weight * weight * value.w;
      sumWeight += weight;
    }
  }
  filterOut[index] = select(center, vec4<f32>(sumColor / sumWeight, sumVariance / (sumWeight * sumWeight)), sumWeight > 1e-6);
}
`;

// The filtered light is upsampled to the output size with a joint bilinear filter that does not blend across edges,
// multiplied by the albedo history, tone mapped (ACES, gamma 2.2) and packed as the canvas format wants it.
const PRESENT_SOURCE = DENOISE_COMMON + /* wgsl */ `
@group(0) @binding(1) var<storage, read> traced: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> filtered: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> history: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> outputPixels: array<u32>;

fn toneMap(linearColor: vec3<f32>) -> vec3<f32> {
  let color = max(linearColor, vec3<f32>(0.0));
  let mapped = clamp((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), vec3<f32>(0.0), vec3<f32>(1.0));
  return pow(mapped, vec3<f32>(1.0 / 2.2));
}

@compute @workgroup_size(8, 8, 1)
fn present(@builtin(global_invocation_id) id: vec3<u32>) {
  let outputSize = vec2<f32>(params.sizes.zw);
  if (id.x >= u32(params.sizes.z) || id.y >= u32(params.sizes.w)) { return; }
  let traceSize = params.sizes.xy;
  let plane = planeSize();
  let position = (vec2<f32>(id.xy) + 0.5) / outputSize * vec2<f32>(traceSize);
  let nearest = clamp(vec2<i32>(floor(position)), vec2<i32>(0), traceSize - vec2<i32>(1));
  let nearestIndex = pixelIndex(nearest);
  let nearestDistance = distanceOf(traced[nearestIndex]);
  let nearestNormal = traced[2u * plane + nearestIndex].xyz;
  let base = floor(position - 0.5);
  let fraction = position - 0.5 - base;
  var illumination = vec3<f32>(0.0);
  var albedo = vec3<f32>(0.0);
  var totalWeight = 0.0;
  for (var tap = 0; tap < 4; tap++) {
    let offset = vec2<i32>(tap & 1, tap >> 1u);
    let texel = clamp(vec2<i32>(base) + offset, vec2<i32>(0), traceSize - vec2<i32>(1));
    let index = pixelIndex(texel);
    var weight = select(1.0 - fraction.x, fraction.x, offset.x == 1) * select(1.0 - fraction.y, fraction.y, offset.y == 1);
    weight *= exp(-abs(distanceOf(traced[index]) - nearestDistance) / (0.02 * nearestDistance));
    weight *= pow(max(dot(nearestNormal, traced[2u * plane + index].xyz), 0.0), 16.0);
    illumination += weight * filtered[index].rgb;
    albedo += weight * history[2u * plane + index].rgb;
    totalWeight += weight;
  }
  if (totalWeight < 1e-5) {
    illumination = filtered[nearestIndex].rgb;
    albedo = history[2u * plane + nearestIndex].rgb;
    totalWeight = 1.0;
  }
  let color = toneMap(illumination / totalWeight * max(albedo / totalWeight, vec3<f32>(MINIMUM_ALBEDO)));
  let bytes = vec3<u32>(color * 255.0 + 0.5);
  let swapped = params.outputLayout.y == 1u;
  let packedColor = select(bytes.x, bytes.z, swapped) | (bytes.y << 8u) | (select(bytes.z, bytes.x, swapped) << 16u) | (255u << 24u);
  outputPixels[id.y * params.outputLayout.x + id.x] = packedColor;
}
`;

function createPipeline(device, module, entryPoint) {
  return device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint } });
}

async function compileModule(device, label, code) {
  const module = device.createShaderModule({ label, code });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter(message => message.type === 'error');
  if (errors.length > 0) throw new Error(`The WebGPU real-time ${label} shader did not compile: ${errors.slice(0, 8).map(message => `${message.lineNum}: ${message.message}`).join('; ')}`);
  return module;
}

const storage = (device, label, bytes, extraUsage = 0) => device.createBuffer({ label, size: Math.max(16, bytes), usage: GPUBufferUsage.STORAGE | extraUsage });
const uniform = (device, label, bytes) => device.createBuffer({ label, size: bytes, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
const bind = (device, pipeline, buffers) => device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })) });

/**
 * The cache table (CACHE_SLOT_COUNT vec4: mean radiance and the number of records behind it) and the pass that folds the
 * records of a frame in. `table` is bound by the tracer kernel; `encode(pass, records, recordCount)` adds the dispatches.
 */
export async function createWebGpuRadianceCache(device) {
  const module = await compileModule(device, 'radiance cache', CACHE_SOURCE);
  const [scatterPipeline, resolvePipeline] = await Promise.all([createPipeline(device, module, 'scatterRecords'), createPipeline(device, module, 'resolveCells')]);
  const table = storage(device, 'radiance cache', CACHE_SLOT_COUNT * 16, GPUBufferUsage.COPY_DST);
  const sums = storage(device, 'radiance cache sums', CACHE_SLOT_COUNT * 16);
  const recordCountBuffer = uniform(device, 'record count', CACHE_PARAMETER_BYTES);
  let scatterGroup = null;
  let resolveGroup = null;
  return {
    table,
    clear(encoder) {
      encoder.clearBuffer(table);
    },
    encode(pass, records, recordCount) {
      device.queue.writeBuffer(recordCountBuffer, 0, new Uint32Array([recordCount, 0, 0, 0]));
      scatterGroup ??= device.createBindGroup({ layout: scatterPipeline.getBindGroupLayout(0), entries: [[0, records], [1, sums], [3, recordCountBuffer]].map(([binding, buffer]) => ({ binding, resource: { buffer } })) });
      resolveGroup ??= device.createBindGroup({ layout: resolvePipeline.getBindGroupLayout(0), entries: [sums, table].map((buffer, index) => ({ binding: index + 1, resource: { buffer } })) });
      pass.setPipeline(scatterPipeline);
      pass.setBindGroup(0, scatterGroup);
      const recordGroups = Math.ceil(recordCount / CACHE_WORKGROUP_SIZE);
      pass.dispatchWorkgroups(Math.min(recordGroups, 4096), Math.ceil(recordGroups / 4096));
      pass.setPipeline(resolvePipeline);
      pass.setBindGroup(0, resolveGroup);
      pass.dispatchWorkgroups(4096, CACHE_SLOT_COUNT / CACHE_WORKGROUP_SIZE / 4096);
    },
    dispose() {
      for (const buffer of [table, sums, recordCountBuffer]) buffer.destroy();
    },
  };
}

/** Rows of a texture copy start at multiples of 256 bytes. */
export const outputRowWords = width => Math.ceil(width * 4 / 256) * 64;

function writeDenoiseParameters(device, buffer, inputs, sizes, step, rowWords, swapped) {
  const words = new ArrayBuffer(DENOISE_PARAMETER_BYTES);
  const floats = new Float32Array(words);
  const integers = new Int32Array(words);
  const unsigned = new Uint32Array(words);
  const { camera, previousCamera } = inputs;
  floats.set([...camera.eye, 0, ...camera.forward, 0, ...camera.right, 0, ...camera.above, 0], 0);
  floats.set([...previousCamera.eye, 0, ...previousCamera.forward, 0, ...previousCamera.right, 0, ...previousCamera.above, 0], 16);
  floats.set([camera.halfWidth, camera.halfHeight, previousCamera.halfWidth, previousCamera.halfHeight], 32);
  integers.set(sizes, 36);
  floats.set([inputs.farDistance, inputs.historyLimit, inputs.resetHistory ? 1 : 0, step], 40);
  unsigned.set([rowWords, swapped ? 1 : 0, 0, 0], 44);
  device.queue.writeBuffer(buffer, 0, words);
}

/**
 * The temporal denoiser as compute passes. `encode(pass, set, inputs)` adds accumulate, the a-trous steps and the present
 * pass for the traced frame in `tracedBuffers[set]` (the frame before it is in the other set). The result is packed
 * pixels in `outputBuffer`, `outputRowWords(outputWidth)` words per row, red first, or blue first when `swapped`.
 */
export async function createWebGpuDenoiser(device, { traceWidth, traceHeight, outputWidth, outputHeight, tracedBuffers, motionBuffer, historyLimit = DEFAULT_HISTORY_LIMIT, filterIterations = DEFAULT_FILTER_ITERATIONS, swapped = false }) {
  const [accumulateModule, atrousModule, presentModule] = await Promise.all([
    compileModule(device, 'accumulate', ACCUMULATE_SOURCE), compileModule(device, 'a-trous', ATROUS_SOURCE), compileModule(device, 'present', PRESENT_SOURCE),
  ]);
  const [accumulatePipeline, atrousPipeline, presentPipeline] = await Promise.all([
    createPipeline(device, accumulateModule, 'accumulate'), createPipeline(device, atrousModule, 'atrous'), createPipeline(device, presentModule, 'present'),
  ]);
  const plane = traceWidth * traceHeight * 16;
  const rowWords = outputRowWords(outputWidth);
  const sizes = [traceWidth, traceHeight, outputWidth, outputHeight];
  const histories = [0, 1].map(index => storage(device, `history ${index}`, plane * 3));
  const filters = [0, 1].map(index => storage(device, `filter ${index}`, plane));
  const outputBuffer = storage(device, 'output pixels', rowWords * 4 * outputHeight, GPUBufferUsage.COPY_SRC);
  const accumulateParameters = uniform(device, 'accumulate parameters', DENOISE_PARAMETER_BYTES);
  const atrousParameters = Array.from({ length: filterIterations }, () => uniform(device, 'a-trous parameters', DENOISE_PARAMETER_BYTES));
  const presentParameters = uniform(device, 'present parameters', DENOISE_PARAMETER_BYTES);
  const finalFilter = filters[filterIterations % 2];
  const groupsFor = (width, height) => [Math.ceil(width / 8), Math.ceil(height / 8)];
  const sets = [0, 1].map(set => ({
    accumulate: bind(device, accumulatePipeline, [accumulateParameters, tracedBuffers[set], tracedBuffers[1 - set], histories[1 - set], histories[set], filters[0], motionBuffer]),
    atrous: atrousParameters.map((parameters, iteration) => bind(device, atrousPipeline, [parameters, tracedBuffers[set], filters[iteration % 2], filters[1 - iteration % 2]])),
    present: bind(device, presentPipeline, [presentParameters, tracedBuffers[set], finalFilter, histories[set], outputBuffer]),
  }));

  return {
    outputBuffer,
    rowWords,
    encode(pass, set, inputs) {
      const settings = { ...inputs, historyLimit };
      writeDenoiseParameters(device, accumulateParameters, settings, sizes, 1, rowWords, swapped);
      atrousParameters.forEach((buffer, iteration) => writeDenoiseParameters(device, buffer, settings, sizes, 1 << iteration, rowWords, swapped));
      writeDenoiseParameters(device, presentParameters, settings, sizes, 1, rowWords, swapped);
      pass.setPipeline(accumulatePipeline);
      pass.setBindGroup(0, sets[set].accumulate);
      pass.dispatchWorkgroups(...groupsFor(traceWidth, traceHeight));
      pass.setPipeline(atrousPipeline);
      for (const group of sets[set].atrous) {
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(...groupsFor(traceWidth, traceHeight));
      }
      pass.setPipeline(presentPipeline);
      pass.setBindGroup(0, sets[set].present);
      pass.dispatchWorkgroups(...groupsFor(outputWidth, outputHeight));
    },
    dispose() {
      for (const buffer of [...histories, ...filters, outputBuffer, accumulateParameters, presentParameters, ...atrousParameters]) buffer.destroy();
    },
  };
}
