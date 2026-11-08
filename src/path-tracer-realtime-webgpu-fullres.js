import { DEFAULT_FILTER_ITERATIONS, DEFAULT_HISTORY_LIMIT } from './path-tracer-temporal-denoise.js';
import {
  DENOISE_COMMON, DENOISE_PARAMETER_BYTES, FIREFLY_DEVIATIONS, MINIMUM_ALBEDO, SHORT_HISTORY_LENGTH, SPATIAL_VARIANCE_HISTORY,
  bind, compileModule, createPipeline, outputRowWords, partMotionSource, storage, uniform, writeDenoiseParameters,
} from './path-tracer-realtime-webgpu-passes.js';

// The temporal denoiser of the WebGPU real-time tracer with its history at the OUTPUT size (issue #624), the option
// `accumulateAtOutputSize`. The default denoiser (path-tracer-realtime-webgpu-passes.js) accumulates on the traced low
// resolution grid and upsamples the result, so a camera at rest converges to an upscaled image. Here every output pixel
// gathers the traced samples around it by their jittered positions (the kernel writes each sample's jitter next to its
// albedo), which is supersampling over frames: the history keeps sub-pixel detail, and the picture converges to the output
// resolution. The history holds four planes of the output size: light and history length, moments, variance and distance,
// albedo, and normal and material. The traced frame is read as three planes: radiance and distance, albedo and jitter,
// normal and material. The pass order is resolve (gather, reproject, blend), a-trous steps, present.

const SAMPLE_SIGMA = 0.5;
const NEIGHBOURHOOD_RADIUS = 1;
const NEIGHBOUR_COUNT = (2 * NEIGHBOURHOOD_RADIUS + 1) ** 2;
const JITTER_STEPS = 4095;
const MINIMUM_SAMPLE_WEIGHT = 1e-3;

const FULL_RESOLUTION_COMMON = DENOISE_COMMON + /* wgsl */ `
fn outputIndex(texel: vec2<i32>) -> u32 {
  return u32(texel.y * params.sizes.z + texel.x);
}

fn outputPlaneSize() -> u32 {
  return u32(params.sizes.z * params.sizes.w);
}

fn insideOutputImage(texel: vec2<i32>) -> bool {
  return all(texel >= vec2<i32>(0)) && all(texel < params.sizes.zw);
}
`;

const RESOLVE_SOURCE = FULL_RESOLUTION_COMMON + partMotionSource(5) + /* wgsl */ `
@group(0) @binding(1) var<storage, read> traced: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> historyPrevious: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> historyCurrent: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> filtered: array<vec4<f32>>;

// The jitter of a sample, packed by the kernel as two 12 bit fractions in one float.
fn jitterOf(packed: f32) -> vec2<f32> {
  let bits = u32(packed);
  return vec2<f32>(f32(bits >> 12u), f32(bits & 4095u)) / ${JITTER_STEPS}.0;
}

fn sampleIllumination(index: u32) -> vec3<f32> {
  return traced[index].rgb / max(traced[planeSize() + index].rgb, vec3<f32>(MINIMUM_ALBEDO));
}

@compute @workgroup_size(8, 8, 1)
fn resolve(@builtin(global_invocation_id) id: vec3<u32>) {
  let texel = vec2<i32>(id.xy);
  if (!insideOutputImage(texel)) { return; }
  let tracePlane = planeSize();
  let outputPlane = outputPlaneSize();
  let index = outputIndex(texel);
  let traceSize = vec2<f32>(params.sizes.xy);
  let outputSize = vec2<f32>(params.sizes.zw);
  let position = (vec2<f32>(texel) + 0.5) / outputSize * traceSize;
  let centre = vec2<i32>(floor(position));

  // First look at the traced samples around: the nearest one gives the geometry of this pixel, and the spread of their light
  // sets the firefly limit.
  var nearestIndex = pixelIndex(clamp(centre, vec2<i32>(0), params.sizes.xy - vec2<i32>(1)));
  var nearestDistanceSquared = 1e9;
  var luminanceSum = 0.0;
  var luminanceSumOfSquares = 0.0;
  var brightest = 0.0;
  var count = 0.0;
  for (var offsetY = -${NEIGHBOURHOOD_RADIUS}; offsetY <= ${NEIGHBOURHOOD_RADIUS}; offsetY++) {
    for (var offsetX = -${NEIGHBOURHOOD_RADIUS}; offsetX <= ${NEIGHBOURHOOD_RADIUS}; offsetX++) {
      let neighbour = centre + vec2<i32>(offsetX, offsetY);
      if (!insideTraceImage(neighbour)) { continue; }
      let neighbourIndex = pixelIndex(neighbour);
      let separation = vec2<f32>(neighbour) + jitterOf(traced[tracePlane + neighbourIndex].w) - position;
      let distanceSquared = dot(separation, separation);
      if (distanceSquared < nearestDistanceSquared) {
        nearestDistanceSquared = distanceSquared;
        nearestIndex = neighbourIndex;
      }
      let luminance = luminanceOf(sampleIllumination(neighbourIndex));
      luminanceSum += luminance;
      luminanceSumOfSquares += luminance * luminance;
      brightest = max(brightest, luminance);
      count += 1.0;
    }
  }
  // The limit comes from the neighbours without the brightest, so a spike does not raise its own limit.
  let others = max(count - 1.0, 1.0);
  let othersMean = (luminanceSum - brightest) / others;
  let othersDeviation = sqrt(max(0.0, (luminanceSumOfSquares - brightest * brightest) / others - othersMean * othersMean));
  let luminanceLimit = othersMean * 1.05 + ${FIREFLY_DEVIATIONS} * othersDeviation + 0.01;

  let nearestTexel = vec2<i32>(i32(nearestIndex) % params.sizes.x, i32(nearestIndex) / params.sizes.x);
  let nearestNormalAndMaterial = traced[2u * tracePlane + nearestIndex];
  let normal = nearestNormalAndMaterial.xyz;
  let nearestJitter = jitterOf(traced[tracePlane + nearestIndex].w);
  let nearestSamplePosition = vec2<f32>(nearestTexel) + nearestJitter;
  let hitDistance = distanceOf(traced[nearestIndex]);
  // The world point the nearest sample hit, and where that surface point was in the previous frame.
  let point = params.eye.xyz + pixelRayDirection(nearestSamplePosition, traceSize) * hitDistance;
  let previousPoint = previousPointOf(point, nearestNormalAndMaterial.w);

  var history = vec4<f32>(0.0);
  var historyMoments = vec4<f32>(0.0);
  var historyAlbedo = vec3<f32>(0.0);
  var totalWeight = 0.0;
  let projection = projectToPrevious(previousPoint.xyz, outputSize);
  if (params.settings.z < 0.5 && projection.w > 0.5 && previousPoint.w > 0.5) {
    let base = floor(projection.xy - 0.5);
    let fraction = projection.xy - 0.5 - base;
    for (var tap = 0; tap < 4; tap++) {
      let offset = vec2<i32>(tap & 1, tap >> 1u);
      let historyTexel = vec2<i32>(base) + offset;
      if (!insideOutputImage(historyTexel)) { continue; }
      let weight = select(1.0 - fraction.x, fraction.x, offset.x == 1) * select(1.0 - fraction.y, fraction.y, offset.y == 1);
      let historyIndex = outputIndex(historyTexel);
      let previousNormal = historyPrevious[3u * outputPlane + historyIndex];
      let previousMoments = historyPrevious[outputPlane + historyIndex];
      if (!isHistoryConsistent(projection.z, previousMoments.w, normal, previousNormal.xyz, nearestNormalAndMaterial.w, previousNormal.w)) { continue; }
      history += weight * historyPrevious[historyIndex];
      historyMoments += weight * previousMoments;
      historyAlbedo += weight * historyPrevious[2u * outputPlane + historyIndex].rgb;
      totalWeight += weight;
    }
  }
  let shortHistory = totalWeight <= 1e-3 || history.w < ${SHORT_HISTORY_LENGTH}.0;

  // The new light: the samples around, weighted by how close their jittered position is to this pixel's centre.
  var sampleWeightSum = 0.0;
  var weightedIllumination = vec3<f32>(0.0);
  var sampleAlbedo = vec3<f32>(0.0);
  for (var offsetY = -${NEIGHBOURHOOD_RADIUS}; offsetY <= ${NEIGHBOURHOOD_RADIUS}; offsetY++) {
    for (var offsetX = -${NEIGHBOURHOOD_RADIUS}; offsetX <= ${NEIGHBOURHOOD_RADIUS}; offsetX++) {
      let neighbour = centre + vec2<i32>(offsetX, offsetY);
      if (!insideTraceImage(neighbour)) { continue; }
      let neighbourIndex = pixelIndex(neighbour);
      let albedoAndJitter = traced[tracePlane + neighbourIndex];
      let separation = vec2<f32>(neighbour) + jitterOf(albedoAndJitter.w) - position;
      let weight = exp(-dot(separation, separation) / (2.0 * ${SAMPLE_SIGMA * SAMPLE_SIGMA}));
      var illumination = sampleIllumination(neighbourIndex);
      let luminance = luminanceOf(illumination);
      if (shortHistory && luminance > luminanceLimit) { illumination *= luminanceLimit / luminance; }
      sampleWeightSum += weight;
      weightedIllumination += weight * illumination;
      sampleAlbedo += weight * albedoAndJitter.rgb;
    }
  }
  // No sample close enough: the nearest one stands in, so a pixel without history is never black.
  var newWeight = min(sampleWeightSum, 1.0);
  var newIllumination = sampleIllumination(nearestIndex);
  var newAlbedo = traced[tracePlane + nearestIndex].rgb;
  if (sampleWeightSum > ${MINIMUM_SAMPLE_WEIGHT}) {
    newIllumination = weightedIllumination / sampleWeightSum;
    newAlbedo = sampleAlbedo / sampleWeightSum;
  } else if (totalWeight <= 1e-3) {
    newWeight = 1.0;
  } else {
    newWeight = 0.0;
  }
  let newLuminance = luminanceOf(newIllumination);
  let currentMoments = vec2<f32>(newLuminance, newLuminance * newLuminance);

  var color = newIllumination;
  var blendedAlbedo = newAlbedo;
  var moments = currentMoments;
  var historyLength = newWeight;
  if (totalWeight > 1e-3) {
    history /= totalWeight;
    historyMoments /= totalWeight;
    historyAlbedo /= totalWeight;
    historyLength = min(history.w + newWeight, params.settings.y);
    let blend = newWeight / max(historyLength, 1e-3);
    color = mix(history.rgb, newIllumination, blend);
    blendedAlbedo = mix(historyAlbedo, newAlbedo, blend);
    moments = mix(historyMoments.xy, currentMoments, blend);
  }
  var variance = max(0.0, moments.y - moments.x * moments.x);
  if (historyLength < ${SPATIAL_VARIANCE_HISTORY}.0) {
    let mean = luminanceSum / max(count, 1.0);
    variance = max(0.0, luminanceSumOfSquares / max(count, 1.0) - mean * mean);
  }
  historyCurrent[index] = vec4<f32>(color, historyLength);
  historyCurrent[outputPlane + index] = vec4<f32>(moments, variance, hitDistance);
  historyCurrent[2u * outputPlane + index] = vec4<f32>(blendedAlbedo, 1.0);
  historyCurrent[3u * outputPlane + index] = nearestNormalAndMaterial;
  filtered[index] = vec4<f32>(color, variance);
}
`;

const ATROUS_SOURCE = FULL_RESOLUTION_COMMON + /* wgsl */ `
@group(0) @binding(1) var<storage, read> geometry: array<vec4<f32>>;
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

// The geometry planes of the history: moments, variance and distance (the distance is the fourth value), and normal and material.
fn distanceAt(index: u32) -> f32 {
  return geometry[outputPlaneSize() + index].w;
}

fn normalAt(index: u32) -> vec3<f32> {
  return geometry[3u * outputPlaneSize() + index].xyz;
}

@compute @workgroup_size(8, 8, 1)
fn atrous(@builtin(global_invocation_id) id: vec3<u32>) {
  let texel = vec2<i32>(id.xy);
  if (!insideOutputImage(texel)) { return; }
  let size = vec2<f32>(params.sizes.zw);
  let stride = i32(params.settings.w);
  let index = outputIndex(texel);
  let center = filterIn[index];
  let centerNormal = normalAt(index);
  let centerDistance = distanceAt(index);
  let centerPoint = pixelRayDirection(vec2<f32>(texel) + 0.5, size) * centerDistance;
  let centerLuminance = luminanceOf(center.rgb);
  var smoothedVariance = 0.0;
  for (var offsetY = -1; offsetY <= 1; offsetY++) {
    for (var offsetX = -1; offsetX <= 1; offsetX++) {
      let neighbour = clamp(texel + vec2<i32>(offsetX, offsetY), vec2<i32>(0), params.sizes.zw - vec2<i32>(1));
      smoothedVariance += filterIn[outputIndex(neighbour)].w * select(0.25, 0.5, offsetX == 0) * select(0.25, 0.5, offsetY == 0);
    }
  }
  let luminanceScale = LUMINANCE_SIGMA * sqrt(max(smoothedVariance, 0.0)) + 1e-4;

  var sumColor = vec3<f32>(0.0);
  var sumVariance = 0.0;
  var sumWeight = 0.0;
  for (var offsetY = -2; offsetY <= 2; offsetY++) {
    for (var offsetX = -2; offsetX <= 2; offsetX++) {
      let neighbour = texel + vec2<i32>(offsetX, offsetY) * stride;
      if (!insideOutputImage(neighbour)) { continue; }
      let neighbourIndex = outputIndex(neighbour);
      let value = filterIn[neighbourIndex];
      let neighbourPoint = pixelRayDirection(vec2<f32>(neighbour) + 0.5, size) * distanceAt(neighbourIndex);
      let planeDistance = abs(dot(centerNormal, neighbourPoint - centerPoint));
      let planeWeight = exp(-planeDistance / (PLANE_SIGMA * centerDistance));
      let normalWeight = pow(max(dot(centerNormal, normalAt(neighbourIndex)), 0.0), NORMAL_POWER);
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

// The filtered light times the albedo history, tone mapped (ACES, gamma 2.2) and packed as the canvas format wants it.
const PRESENT_SOURCE = FULL_RESOLUTION_COMMON + /* wgsl */ `
@group(0) @binding(1) var<storage, read> filtered: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> history: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> outputPixels: array<u32>;

fn toneMap(linearColor: vec3<f32>) -> vec3<f32> {
  let color = max(linearColor, vec3<f32>(0.0));
  let mapped = clamp((color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14), vec3<f32>(0.0), vec3<f32>(1.0));
  return pow(mapped, vec3<f32>(1.0 / 2.2));
}

@compute @workgroup_size(8, 8, 1)
fn present(@builtin(global_invocation_id) id: vec3<u32>) {
  let texel = vec2<i32>(id.xy);
  if (!insideOutputImage(texel)) { return; }
  let index = outputIndex(texel);
  let albedo = history[2u * outputPlaneSize() + index].rgb;
  let color = toneMap(filtered[index].rgb * max(albedo, vec3<f32>(MINIMUM_ALBEDO)));
  let bytes = vec3<u32>(color * 255.0 + 0.5);
  let swapped = params.outputLayout.y == 1u;
  let packedColor = select(bytes.x, bytes.z, swapped) | (bytes.y << 8u) | (select(bytes.z, bytes.x, swapped) << 16u) | (255u << 24u);
  outputPixels[id.y * params.outputLayout.x + id.x] = packedColor;
}
`;

/**
 * The same interface as `createWebGpuDenoiser`, with the history at the output size (see the header). `tracedBuffers`
 * hold the traced frames; the frame before the one in `tracedBuffers[set]` is not read, because the history carries
 * its own geometry.
 */
export async function createWebGpuFullResolutionDenoiser(device, { traceWidth, traceHeight, outputWidth, outputHeight, tracedBuffers, motionBuffer, historyLimit = DEFAULT_HISTORY_LIMIT, filterIterations = DEFAULT_FILTER_ITERATIONS, swapped = false }) {
  const [resolveModule, atrousModule, presentModule] = await Promise.all([
    compileModule(device, 'full resolution resolve', RESOLVE_SOURCE), compileModule(device, 'full resolution a-trous', ATROUS_SOURCE), compileModule(device, 'full resolution present', PRESENT_SOURCE),
  ]);
  const [resolvePipeline, atrousPipeline, presentPipeline] = await Promise.all([
    createPipeline(device, resolveModule, 'resolve'), createPipeline(device, atrousModule, 'atrous'), createPipeline(device, presentModule, 'present'),
  ]);
  const plane = outputWidth * outputHeight * 16;
  const rowWords = outputRowWords(outputWidth);
  const sizes = [traceWidth, traceHeight, outputWidth, outputHeight];
  const histories = [0, 1].map(index => storage(device, `output history ${index}`, plane * 4));
  const filters = [0, 1].map(index => storage(device, `output filter ${index}`, plane));
  const outputBuffer = storage(device, 'output pixels', rowWords * 4 * outputHeight, GPUBufferUsage.COPY_SRC);
  const resolveParameters = uniform(device, 'resolve parameters', DENOISE_PARAMETER_BYTES);
  const atrousParameters = Array.from({ length: filterIterations }, () => uniform(device, 'a-trous parameters', DENOISE_PARAMETER_BYTES));
  const presentParameters = uniform(device, 'present parameters', DENOISE_PARAMETER_BYTES);
  const finalFilter = filters[filterIterations % 2];
  const groups = [Math.ceil(outputWidth / 8), Math.ceil(outputHeight / 8)];
  const sets = [0, 1].map(set => ({
    resolve: bind(device, resolvePipeline, [resolveParameters, tracedBuffers[set], histories[1 - set], histories[set], filters[0], motionBuffer]),
    atrous: atrousParameters.map((parameters, iteration) => bind(device, atrousPipeline, [parameters, histories[set], filters[iteration % 2], filters[1 - iteration % 2]])),
    present: bind(device, presentPipeline, [presentParameters, finalFilter, histories[set], outputBuffer]),
  }));

  return {
    outputBuffer,
    rowWords,
    encode(pass, set, inputs) {
      const settings = { ...inputs, historyLimit };
      writeDenoiseParameters(device, resolveParameters, settings, sizes, 1, rowWords, swapped);
      atrousParameters.forEach((buffer, iteration) => writeDenoiseParameters(device, buffer, settings, sizes, 1 << iteration, rowWords, swapped));
      writeDenoiseParameters(device, presentParameters, settings, sizes, 1, rowWords, swapped);
      pass.setPipeline(resolvePipeline);
      pass.setBindGroup(0, sets[set].resolve);
      pass.dispatchWorkgroups(...groups);
      pass.setPipeline(atrousPipeline);
      for (const group of sets[set].atrous) {
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(...groups);
      }
      pass.setPipeline(presentPipeline);
      pass.setBindGroup(0, sets[set].present);
      pass.dispatchWorkgroups(...groups);
    },
    dispose() {
      for (const buffer of [...histories, ...filters, outputBuffer, resolveParameters, presentParameters, ...atrousParameters]) buffer.destroy();
    },
  };
}
