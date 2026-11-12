import { CACHE_SLOT_COUNT, MAXIMUM_LEVEL, NORMAL_AXIS_THRESHOLD } from './path-tracer-radiance-cache.js';

// The WGSL pieces that turn the WebGPU megakernel into the real-time kernel (issue #624), the counterpart of the cache
// strings in path-tracer-radiance-cache.js for the WebGL2 kernel. buildMegakernelSource({ realtime: true }) places them:
//   - the cache table and the record buffer (bindings 9 and 10), the cell hash (the same value as `cacheSlot`) and the lookup;
//   - light selection that draws one emitter at every hit (the denoiser averages the draws over frames), by importance;
//   - the last hit of a path ending in a cache lookup, and the hit before it remembering its cell for a record;
//   - an entry point that writes the first hit's radiance, albedo, normal and material to the frame buffer and the record.
// The cell size and the level distance travel in the tile words of the parameter block, as float bits.

const REALTIME_DECLARATIONS = /* wgsl */ `
@group(0) @binding(9) var<storage, read_write> cacheTable: array<vec4<f32>>;
@group(0) @binding(10) var<storage, read_write> cacheRecords: array<vec4<f32>>;
var<private> recordedSlot: f32 = 0.0;
var<private> recordedRadianceBefore: vec3<f32> = vec3<f32>(0.0);
var<private> recordedThroughput: vec3<f32> = vec3<f32>(1.0);
var<private> firstHitMaterial: f32 = 0.0;

fn normalAxisCode(component: f32) -> u32 {
  if (component > ${NORMAL_AXIS_THRESHOLD}) { return 2u; }
  if (component < -${NORMAL_AXIS_THRESHOLD}) { return 0u; }
  return 1u;
}

fn cacheHash(point: vec3<f32>, normal: vec3<f32>) -> u32 {
  let cellSize = bitcast<f32>(params.tileAndDepth.x);
  let levelDistance = bitcast<f32>(params.tileAndDepth.y);
  let level = clamp(floor(log2(max(length(point - params.eye.xyz) / levelDistance, 1.0))), 0.0, ${MAXIMUM_LEVEL}.0);
  let cell = vec3<i32>(floor(point / (cellSize * exp2(level))));
  let normalCode = normalAxisCode(normal.x) + 3u * normalAxisCode(normal.y) + 9u * normalAxisCode(normal.z);
  var hash = (bitcast<u32>(cell.x) * 73856093u) ^ (bitcast<u32>(cell.y) * 19349663u) ^ (bitcast<u32>(cell.z) * 83492791u);
  hash ^= (normalCode + 1u) * 0x9e3779b1u;
  hash ^= u32(level) * 0x85ebca6bu;
  hash ^= hash >> 16u;
  hash *= 0x7feb352du;
  hash ^= hash >> 15u;
  hash *= 0x846ca68bu;
  hash ^= hash >> 16u;
  return hash & ${CACHE_SLOT_COUNT - 1}u;
}

// The mean radiance that arrives at the cell of a surface point; black while the cell has no record yet.
fn cacheLookup(point: vec3<f32>, normal: vec3<f32>) -> vec3<f32> {
  let cell = cacheTable[cacheHash(point, normal)];
  return select(vec3<f32>(0.0), cell.xyz, cell.w >= 1.0);
}

// A cheap estimate of the light one local light brings to the hit point, as lightImportance in the WebGL2 kernel.
fn lightImportance(index: i32, normal: vec3<f32>) -> f32 {
  let base = index * LIGHT_TEXELS;
  let positionType = lights[base];
  let colorBit = lights[base + 1];
  let directionRadius = lights[base + 2];
  let acrossCone = lights[base + 3];
  let intensityRange = lights[base + 5];
  let delta = positionType.xyz - hitPoint;
  let distanceSquared = max(dot(delta, delta), 1e-8);
  let toLight = delta * inverseSqrt(distanceSquared);
  let cosine = 0.1 + max(dot(normal, toLight), 0.0);
  let power = luminance(colorBit.rgb) * intensityRange.x;
  let lightType = i32(positionType.w);
  if (lightType == 2) { return power * max(-dot(directionRadius.xyz, toLight), 0.0) * cosine / distanceSquared; }
  var coneFactor = 1.0;
  if (lightType == 1 && -dot(directionRadius.xyz, toLight) - acrossCone.w <= 0.0) { coneFactor = 0.0; }
  return power * coneFactor * cosine * pointLightFalloff(distanceSquared, intensityRange.y, directionRadius.w);
}

// Draws one emitter: the sun and the sky keep a uniform share, the local lights split theirs by importance mixed with a uniform part.
fn chooseEmitterByImportance(normal: vec3<f32>) -> i32 {
  let emitterCount = params.emittersFlagsSample.x;
  let lightCount = params.sizeBouncesLights.w;
  let uniformShare = 1.0 / f32(emitterCount);
  let draw = nextRandom();
  let firstLightEmitter = select(0, 1, params.emittersFlagsSample.y != 0);
  var total = 0.0;
  if (lightCount > 1) {
    for (var index = 0; index < lightCount; index++) { total += lightImportance(index, normal); }
  }
  selectionProbability = uniformShare;
  if (!(total > 0.0)) { return min(i32(floor(draw * f32(emitterCount))), emitterCount - 1); }
  let lightsShare = f32(lightCount) * uniformShare;
  var cumulative = 0.0;
  for (var emitter = 0; emitter < emitterCount; emitter++) {
    let index = emitter - firstLightEmitter;
    var share = uniformShare;
    if (index >= 0 && index < lightCount) { share = lightsShare * (0.9 * lightImportance(index, normal) / total + 0.1 / f32(lightCount)); }
    cumulative += share;
    selectionProbability = share;
    if (draw < cumulative) { return emitter; }
  }
  return emitterCount - 1;
}
`;

// The first hit lights from one emitter too, so a frame costs one shadow ray there.
const REALTIME_ADD_LIGHTS = /* wgsl */ `
fn addLights(depth: i32, normal: vec3<f32>) {
  let emitterCount = params.emittersFlagsSample.x;
  if (emitterCount <= 1) {
    selectionProbability = 1.0;
    for (var emitter = 0; emitter < emitterCount; emitter++) {
      sampleEmitter(depth, normal, emitter);
      flushShadowRay();
    }
    return;
  }
  sampleEmitter(depth, normal, chooseEmitterByImportance(normal));
  flushShadowRay();
}
`;

const REALTIME_FIRST_HIT = 'if (!featuresRecorded) { firstHitMaterial = f32(hitMaterialIndex) + 1.0; }';

// The last hit of a path adds the cell's radiance, times what the path carries and the surface colour (a diffuse reading).
const REALTIME_TERMINAL = /* wgsl */ `
    if (depth == bounces && !inFog && !isGlass) {
      addRadiance(depth, throughput * hitColor * cacheLookup(hitPoint, normal));
      break;
    }`;

// The hit before it, if the surface scatters diffusely, remembers its cell, the light so far and the path's weight.
const REALTIME_RECORD = /* wgsl */ `
      if (depth == max(bounces - 1, 0) && !isMirror) {
        recordedSlot = f32(cacheHash(hitPoint, normal)) + 1.0;
        recordedRadianceBefore = radiance;
        recordedThroughput = throughput;
      }`;

// One invocation per pixel. The frame buffer holds three planes of pixelCount vec4: radiance and depth, albedo, normal and material.
const REALTIME_MAIN = /* wgsl */ `
@compute @workgroup_size(8, 8, 1)
fn traceRealtime(@builtin(global_invocation_id) id: vec3<u32>) {
  let width = params.sizeBouncesLights.x;
  let height = params.sizeBouncesLights.y;
  if (i32(id.x) >= width || i32(id.y) >= height) { return; }
  let pixel = id.y * u32(width) + id.x;
  let sampleIndex = u32(params.emittersFlagsSample.w);
  let seed = params.seedAndAtlas.x;
  if (params.emittersFlagsSample.y != 0) { sunFrame = buildFrame(params.sunDirection.xyz); }
  let jitterX = hashJitter(pixel, sampleIndex, seed, 1u);
  let jitterY = hashJitter(pixel, sampleIndex, seed, 2u);
  let screenX = ((f32(id.x) + jitterX) / f32(width) * 2.0 - 1.0) * params.cameraAndClamp.x;
  let screenY = (1.0 - (f32(id.y) + jitterY) / f32(height) * 2.0) * params.cameraAndClamp.y;
  let rayDirection = normalize(params.forward.xyz + params.right.xyz * screenX + params.above.xyz * screenY);
  tracePath(params.eye.xyz, rayDirection, pixel, sampleIndex, true);
  if (!(all(radiance >= vec3<f32>(0.0)) && all(radiance < vec3<f32>(1e30)))) { radiance = vec3<f32>(0.0); }
  if (!(featureDepth >= 0.0 && featureDepth < 1e30)) { featureDepth = 0.0; }
  if (!(all(featureNormal >= vec3<f32>(-1.5)) && all(featureNormal < vec3<f32>(1.5)))) { featureNormal = vec3<f32>(0.0, 0.0, 1.0); }
  if (!(all(featureAlbedo >= vec3<f32>(0.0)) && all(featureAlbedo < vec3<f32>(1e30)))) { featureAlbedo = vec3<f32>(1.0); }
  let pixelCount = u32(width * height);
  accumulation[pixel] = vec4<f32>(radiance, featureDepth);
  accumulation[pixelCount + pixel] = vec4<f32>(featureAlbedo, 0.0);
  accumulation[2u * pixelCount + pixel] = vec4<f32>(featureNormal, firstHitMaterial);
  // The record: the light the rest of the path brought, per unit of the weight at that hit (the incoming radiance).
  let recordedTail = clamp((radiance - recordedRadianceBefore) / max(recordedThroughput, vec3<f32>(0.05)), vec3<f32>(0.0), vec3<f32>(params.cameraAndClamp.z));
  cacheRecords[pixel] = select(vec4<f32>(0.0), vec4<f32>(recordedTail, recordedSlot), recordedSlot > 0.0);
}
`;

/** The pieces as `buildMegakernelSource({ realtime })` takes them. */
export const REALTIME_KERNEL_PIECES = {
  declarations: REALTIME_DECLARATIONS, addLights: REALTIME_ADD_LIGHTS, firstHit: REALTIME_FIRST_HIT,
  terminal: REALTIME_TERMINAL, record: REALTIME_RECORD, main: REALTIME_MAIN,
};
