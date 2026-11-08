// The WGSL kernels of the WebGPU path tracer (issue #625). The scene tables are the packed arrays of
// path-tracer-gpu-pack.js bound as storage buffers; the random numbers, light sampling order and shading follow the GLSL
// kernel of path-tracer-gpu-shader.js line by line, so one seed gives the same picture. Two ways to run the same maths:
//   MEGAKERNEL_SOURCE: one invocation traces one pixel's whole path (entry point `main`).
//   WAVEFRONT_SOURCE: path state lives in a storage buffer and the path is split into kernels (generate, extend, shade,
//   shadow, resolve); after extend the hits are binned by material so that neighbouring invocations of shade run the same material.
// Volume fog and the subsurface walk (path-tracer-webgpu-medium.js) are spliced into the megakernel only for a scene that uses them.
// The megakernel has a texel entry point (`bakeTexels`) that starts a path at every lightmap texel, for the light bake.

import { SUBSURFACE_FUNCTIONS, VOLUME_FUNCTIONS } from './path-tracer-webgpu-medium.js';

export const WORKGROUP_SIZE = 8;
export const WAVEFRONT_WORKGROUP_SIZE = 64;
/** vec4 slots of path state per path; the wavefront section below names each one. */
export const PATH_STATE_VECTORS = 9;

const buildCommonSource = ({ hasVolume = false } = {}) => /* wgsl */ `
const PI: f32 = 3.14159265358979;
const TWO_PI: f32 = 6.28318530717959;
const TRIANGLE_TEXELS: i32 = 9;
const MATERIAL_TEXELS: i32 = 10;
const LIGHT_TEXELS: i32 = 6;
const STACK_SIZE: i32 = 128;
const ALPHA_STEP_LIMIT: i32 = 8;
const RUSSIAN_ROULETTE_START: i32 = 3;
const MINIMUM_ALPHA: f32 = 1e-3;
const MIRROR_ALPHA: f32 = 2e-3;
const DIELECTRIC_COAT_REFLECTANCE: f32 = 0.04;

struct Params {
  eye: vec4<f32>,
  forward: vec4<f32>,
  right: vec4<f32>,
  above: vec4<f32>,
  sunDirection: vec4<f32>,
  sunColorAndCosine: vec4<f32>,
  environmentShape: vec4<f32>,
  environmentRotationAndRays: vec4<f32>,
  cameraAndClamp: vec4<f32>,
  sizeBouncesLights: vec4<i32>,
  emittersFlagsSample: vec4<i32>,
  seedAndAtlas: vec4<u32>,
  tileAndDepth: vec4<u32>,
  shadowSlots: vec4<u32>,
  volumeMinimumDensity: vec4<f32>,
  volumeMaximumAnisotropy: vec4<f32>,
  volumeAlbedoDistance: vec4<f32>,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> nodes: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> triangles: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> materials: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> lights: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read> atlas: array<u32>;
@group(0) @binding(6) var<storage, read> environmentColors: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read> environmentTables: array<f32>;
// Four planes of pixelCount vec4 each: radiance and depth, albedo, normal, luminance statistics.
@group(0) @binding(8) var<storage, read_write> accumulation: array<vec4<f32>>;

var<private> rngState: u32 = 1u;

fn resetRandom(pixel: u32, sampleIndex: u32, seed: u32) {
  var mixed = ((pixel + 0x9e3779b9u) * 0x85ebca6bu) ^ ((sampleIndex + 0x7f4a7c15u) * 0xc2b2ae35u) ^ ((seed + 0x165667b1u) * 0x27d4eb2fu);
  mixed = (mixed ^ (mixed >> 15u)) * 0x2c1b3c6du;
  mixed = (mixed ^ (mixed >> 12u)) * 0x297a2d39u;
  mixed ^= mixed >> 15u;
  rngState = select(mixed, 1u, mixed == 0u);
}

fn nextRandom() -> f32 {
  rngState = rngState * 747796405u + 2891336453u;
  var word = ((rngState >> ((rngState >> 28u) + 4u)) ^ rngState) * 277803737u;
  word = (word >> 22u) ^ word;
  return f32(word >> 8u) / 16777216.0;
}

fn hashJitter(pixel: u32, sampleIndex: u32, seed: u32, dimension: u32) -> f32 {
  var mixed = ((pixel ^ 0x51ed270bu) * 0x9e3779b1u) ^ ((sampleIndex + dimension * 0x632be5abu) * 0x85ebca6bu) ^ ((seed + 0x1b873593u) * 0xc2b2ae35u);
  mixed = (mixed ^ (mixed >> 16u)) * 0x7feb352du;
  mixed = (mixed ^ (mixed >> 15u)) * 0x846ca68bu;
  mixed ^= mixed >> 16u;
  return f32(mixed >> 8u) / 16777216.0;
}

fn luminance(color: vec3<f32>) -> f32 {
  return dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
}

// ---- Ray queries ----

var<private> nearestDistance: f32;
var<private> nearestSlot: i32;
var<private> nearestU: f32;
var<private> nearestV: f32;
var<private> nodeStack: array<i32, 128>;
var<private> entryStack: array<f32, 128>;

fn safeInverseComponent(component: f32) -> f32 {
  if (abs(component) > 1e-20) { return 1.0 / component; }
  return select(1e20, -1e20, component < 0.0);
}

fn safeInverse(direction: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(safeInverseComponent(direction.x), safeInverseComponent(direction.y), safeInverseComponent(direction.z));
}

fn boxEntry(node: i32, origin: vec3<f32>, inverse: vec3<f32>) -> f32 {
  let low = nodes[node * 2];
  let high = nodes[node * 2 + 1];
  let first = (low.xyz - origin) * inverse;
  let second = (high.xyz - origin) * inverse;
  let nearest = min(first, second);
  let farthest = max(first, second);
  let entry = max(max(max(nearest.x, nearest.y), nearest.z), 0.0);
  let exitDistance = min(min(farthest.x, farthest.y), farthest.z);
  return select(1e30, entry, entry <= exitDistance * (1.0 + 1e-6) + 1e-6);
}

fn visitLeaf(node: i32, origin: vec3<f32>, direction: vec3<f32>, anyHit: bool) -> bool {
  let range = nodes[node * 2 + 1];
  let header = nodes[node * 2];
  let start = i32(range.w);
  let end = start + i32(-header.w);
  for (var slot = start; slot < end; slot++) {
    let base = slot * TRIANGLE_TEXELS;
    let corner = triangles[base].xyz;
    let edgeFirst = triangles[base + 1].xyz;
    let edgeSecond = triangles[base + 2].xyz;
    let pivot = cross(direction, edgeSecond);
    let determinant = dot(edgeFirst, pivot);
    if (determinant == 0.0) { continue; }
    let offset = origin - corner;
    let firstWeight = dot(offset, pivot) / determinant;
    if (firstWeight < 0.0 || firstWeight > 1.0) { continue; }
    let query = cross(offset, edgeFirst);
    let secondWeight = dot(direction, query) / determinant;
    if (secondWeight < 0.0 || firstWeight + secondWeight > 1.0) { continue; }
    let distance = dot(edgeSecond, query) / determinant;
    if (distance < 0.0 || distance >= nearestDistance) { continue; }
    nearestDistance = distance;
    nearestSlot = slot;
    nearestU = firstWeight;
    nearestV = secondWeight;
    if (anyHit) { return true; }
  }
  return false;
}

fn traceRay(origin: vec3<f32>, direction: vec3<f32>, limit: f32, anyHit: bool) {
  nearestDistance = limit;
  nearestSlot = -1;
  let inverse = safeInverse(direction);
  var stackSize = 1;
  nodeStack[0] = 0;
  entryStack[0] = 0.0;
  while (stackSize > 0) {
    stackSize--;
    let node = nodeStack[stackSize];
    if (!(entryStack[stackSize] < nearestDistance)) { continue; }
    let header = nodes[node * 2];
    if (header.w < 0.0) {
      if (visitLeaf(node, origin, direction, anyHit)) { return; }
      continue;
    }
    let left = node + 1;
    let right = i32(header.w);
    let leftEntry = boxEntry(left, origin, inverse);
    let rightEntry = boxEntry(right, origin, inverse);
    let nearFirst = leftEntry <= rightEntry;
    nodeStack[stackSize] = select(left, right, nearFirst);
    entryStack[stackSize] = select(leftEntry, rightEntry, nearFirst);
    nodeStack[stackSize + 1] = select(right, left, nearFirst);
    entryStack[stackSize + 1] = select(rightEntry, leftEntry, nearFirst);
    stackSize += 2;
  }
}

// ---- Hits ----

var<private> hitDistance: f32;
var<private> hitPoint: vec3<f32>;
var<private> hitNormal: vec3<f32>;
var<private> hitColor: vec3<f32>;
var<private> hitEmission: vec3<f32>;
var<private> hitMetallic: f32;
var<private> hitRoughness: f32;
var<private> hitClearcoat: f32;
var<private> hitClearcoatRoughness: f32;
var<private> hitTransmission: f32;
var<private> hitIor: f32;
var<private> hitCutoff: f32;
var<private> hitMask: u32;
var<private> hitMaterialIndex: i32;

fn srgbToLinear(encoded: vec3<f32>) -> vec3<f32> {
  return select(pow((encoded + 0.055) / 1.055, vec3<f32>(2.4)), encoded / 12.92, encoded <= vec3<f32>(0.04045));
}

fn atlasTexel(x: i32, y: i32) -> vec4<f32> {
  return unpack4x8unorm(atlas[u32(y) * params.seedAndAtlas.y + u32(x)]);
}

fn sampleAtlas(rectangle: vec4<f32>, flags: f32, uv: vec2<f32>) -> vec4<f32> {
  if (rectangle.z <= 0.0) { return vec4<f32>(1.0); }
  let width = i32(rectangle.z);
  let height = i32(rectangle.w);
  let repeat = (flags % 2.0) >= 1.0;
  let encoded = flags >= 2.0;
  let x = uv.x * rectangle.z - 0.5;
  let y = uv.y * rectangle.w - 0.5;
  let left = floor(x);
  let top = floor(y);
  let shareX = x - left;
  let shareY = y - top;
  var total = vec4<f32>(0.0);
  for (var corner = 0; corner < 4; corner++) {
    var column = i32(left) + (corner & 1);
    var row = i32(top) + (corner >> 1u);
    if (repeat) {
      column = ((column % width) + width) % width;
      row = ((row % height) + height) % height;
    } else {
      column = clamp(column, 0, width - 1);
      row = clamp(row, 0, height - 1);
    }
    let weight = select(1.0 - shareX, shareX, (corner & 1) == 1) * select(1.0 - shareY, shareY, (corner >> 1u) == 1);
    let texel = atlasTexel(i32(rectangle.x) + column, i32(rectangle.y) + row);
    let color = select(texel.rgb, srgbToLinear(texel.rgb), encoded);
    total += weight * vec4<f32>(color, texel.a);
  }
  return total;
}

fn applyNormalMap(rectangle: vec4<f32>, flags: f32, scale: vec2<f32>, edgeOne: vec3<f32>, edgeTwo: vec3<f32>, uvOne: vec2<f32>, uvTwo: vec2<f32>, uv: vec2<f32>) {
  let determinant = uvOne.x * uvTwo.y - uvTwo.x * uvOne.y;
  if (abs(determinant) < 1e-12) { return; }
  let normal = hitNormal;
  var tangent = (edgeOne * uvTwo.y - edgeTwo * uvOne.y) / determinant;
  let bitangent = (edgeTwo * uvOne.x - edgeOne * uvTwo.x) / determinant;
  tangent -= normal * dot(tangent, normal);
  let tangentLength = length(tangent);
  if (tangentLength == 0.0) { return; }
  tangent /= tangentLength;
  var across = cross(normal, tangent);
  var acrossLength = length(across);
  if (acrossLength == 0.0) { acrossLength = 1.0; }
  let handedness = select(1.0, -1.0, dot(across, bitangent) < 0.0);
  across *= handedness / acrossLength;
  let texel = sampleAtlas(rectangle, flags, uv).rgb;
  let sideways = (texel.x * 2.0 - 1.0) * scale.x;
  let forwards = (texel.y * 2.0 - 1.0) * scale.y;
  let outwards = texel.z * 2.0 - 1.0;
  let mapped = tangent * sideways + across * forwards + normal * outwards;
  let mappedLength = length(mapped);
  if (!(mappedLength > 1e-6)) { return; }
  hitNormal = mapped / mappedLength;
}

// Fills the hit globals from the triangle in nearestSlot; returns the alpha of the colour map.
fn fillHit(origin: vec3<f32>, direction: vec3<f32>, distance: f32) -> f32 {
  let base = nearestSlot * TRIANGLE_TEXELS;
  let cornerData = triangles[base];
  let edgeOne = triangles[base + 1].xyz;
  let edgeTwo = triangles[base + 2].xyz;
  let normalOneData = triangles[base + 3];
  let normalTwoData = triangles[base + 4];
  let normalThreeData = triangles[base + 5];
  let colorOneData = triangles[base + 6];
  let colorTwoData = triangles[base + 7];
  let colorThreeData = triangles[base + 8];
  let secondWeight = nearestU;
  let thirdWeight = nearestV;
  let firstWeight = 1.0 - secondWeight - thirdWeight;
  hitDistance = distance;
  hitPoint = origin + direction * distance;
  let normal = firstWeight * normalOneData.xyz + secondWeight * normalTwoData.xyz + thirdWeight * normalThreeData.xyz;
  let normalLength = length(normal);
  hitNormal = normal / select(normalLength, 1.0, normalLength == 0.0);
  let vertexColor = firstWeight * colorOneData.xyz + secondWeight * colorTwoData.xyz + thirdWeight * colorThreeData.xyz;
  let uv = firstWeight * vec2<f32>(normalOneData.w, colorOneData.w) + secondWeight * vec2<f32>(normalTwoData.w, colorTwoData.w) + thirdWeight * vec2<f32>(normalThreeData.w, colorThreeData.w);
  hitMaterialIndex = i32(cornerData.w);
  let material = hitMaterialIndex * MATERIAL_TEXELS;
  let colorMetallic = materials[material];
  let emissionRoughness = materials[material + 1];
  let coating = materials[material + 2];
  let shape = materials[material + 3];
  let flagsOne = materials[material + 4];
  let flagsTwo = materials[material + 5];
  hitColor = colorMetallic.rgb * vertexColor;
  hitEmission = emissionRoughness.rgb;
  hitMetallic = colorMetallic.w;
  hitRoughness = emissionRoughness.w;
  hitClearcoat = coating.x;
  hitClearcoatRoughness = coating.y;
  hitTransmission = coating.z;
  hitIor = coating.w;
  hitCutoff = shape.z;
  hitMask = u32(shape.w) | (u32(flagsOne.x) << 16u);
  var alpha = 1.0;
  let mapRectangle = materials[material + 6];
  if (mapRectangle.z > 0.0) {
    let texel = sampleAtlas(mapRectangle, flagsOne.y, uv);
    hitColor *= texel.rgb;
    alpha = texel.a;
  }
  let emissiveRectangle = materials[material + 9];
  if (emissiveRectangle.z > 0.0) { hitEmission *= sampleAtlas(emissiveRectangle, flagsTwo.x, uv).rgb; }
  let surfaceRectangle = materials[material + 8];
  if (surfaceRectangle.z > 0.0) {
    let texel = sampleAtlas(surfaceRectangle, flagsOne.w, uv);
    hitRoughness *= texel.g;
    hitMetallic *= texel.b;
  }
  let normalRectangle = materials[material + 7];
  if (normalRectangle.z > 0.0) {
    let uvOne = vec2<f32>(normalTwoData.w - normalOneData.w, colorTwoData.w - colorOneData.w);
    let uvTwo = vec2<f32>(normalThreeData.w - normalOneData.w, colorThreeData.w - colorOneData.w);
    applyNormalMap(normalRectangle, flagsOne.z, shape.xy, edgeOne, edgeTwo, uvOne, uvTwo, uv);
  }
  return alpha;
}

// The nearest solid hit, stepping through the transparent texels of cutout materials.
fn intersectScene(origin: vec3<f32>, direction: vec3<f32>) -> bool {
  var start = origin;
  var travelled = 0.0;
  let farDistance = params.environmentRotationAndRays.w;
  let surfaceOffset = params.environmentRotationAndRays.z;
  for (var attempt = 0; attempt < ALPHA_STEP_LIMIT; attempt++) {
    traceRay(start, direction, farDistance, false);
    if (nearestSlot < 0) { return false; }
    let foundDistance = nearestDistance;
    let alpha = fillHit(start, direction, foundDistance);
    if (hitCutoff == 0.0 || alpha >= hitCutoff) {
      hitDistance += travelled;
      return true;
    }
    let advance = foundDistance + surfaceOffset;
    travelled += advance;
    start += direction * advance;
  }
  return false;
}

// The alpha of the colour map at the nearest hit, without touching the hit globals a shadow ray must not disturb.
fn alphaAtNearestHit() -> f32 {
  let base = nearestSlot * TRIANGLE_TEXELS;
  let secondWeight = nearestU;
  let thirdWeight = nearestV;
  let firstWeight = 1.0 - secondWeight - thirdWeight;
  let first = triangles[base + 3];
  let second = triangles[base + 4];
  let third = triangles[base + 5];
  let uv = firstWeight * vec2<f32>(first.w, triangles[base + 6].w) + secondWeight * vec2<f32>(second.w, triangles[base + 7].w) + thirdWeight * vec2<f32>(third.w, triangles[base + 8].w);
  let material = i32(triangles[base].w) * MATERIAL_TEXELS;
  let mapRectangle = materials[material + 6];
  if (mapRectangle.z <= 0.0) { return 1.0; }
  return sampleAtlas(mapRectangle, materials[material + 4].y, uv).a;
}

fn occluded(origin: vec3<f32>, direction: vec3<f32>, limit: f32) -> bool {
  var start = origin;
  var remaining = limit;
  let surfaceOffset = params.environmentRotationAndRays.z;
  // A solid any-hit shadows the point wherever it lies; a transparent one hides what sits before it, so retrace for nearest hits.
  var anyHit = true;
  for (var attempt = 0; attempt < ALPHA_STEP_LIMIT; attempt++) {
    traceRay(start, direction, remaining, anyHit);
    if (nearestSlot < 0) { return false; }
    let material = i32(triangles[nearestSlot * TRIANGLE_TEXELS].w) * MATERIAL_TEXELS;
    let cutoff = materials[material + 3].z;
    if (cutoff == 0.0) { return true; }
    if (alphaAtNearestHit() >= cutoff) { return true; }
    if (anyHit) {
      anyHit = false;
      continue;
    }
    let advance = nearestDistance + surfaceOffset;
    remaining -= advance;
    if (remaining <= 0.0) { return false; }
    start += direction * advance;
  }
  return true;
}

// ---- Frames ----

fn buildFrame(normal: vec3<f32>) -> mat3x3<f32> {
  let helperIsX = abs(normal.x) < 0.9;
  let helperX = select(0.0, 1.0, helperIsX);
  let helperY = select(1.0, 0.0, helperIsX);
  let tangent = normalize(vec3<f32>(-normal.z * helperY, normal.z * helperX, normal.x * helperY - normal.y * helperX));
  return mat3x3<f32>(tangent, cross(normal, tangent), normal);
}

fn localToWorld(frame: mat3x3<f32>, local: vec3<f32>) -> vec3<f32> {
  return frame * local;
}

fn worldToLocal(frame: mat3x3<f32>, world: vec3<f32>) -> vec3<f32> {
  return transpose(frame) * world;
}

// ---- Environment map ----

fn environmentRadiance(direction: vec3<f32>) -> vec3<f32> {
  let width = params.environmentShape.x;
  let height = params.environmentShape.y;
  let cosine = params.environmentRotationAndRays.x;
  let sine = params.environmentRotationAndRays.y;
  let mapX = cosine * direction.x - sine * direction.z;
  let mapZ = sine * direction.x + cosine * direction.z;
  let column = (atan2(mapX, -mapZ) / TWO_PI + 0.5) * width - 0.5;
  let row = acos(clamp(direction.y, -1.0, 1.0)) / PI * height - 0.5;
  let left = floor(column);
  let top = floor(row);
  let shareX = column - left;
  let shareY = row - top;
  let columns = i32(width);
  let rows = i32(height);
  var total = vec3<f32>(0.0);
  for (var corner = 0; corner < 4; corner++) {
    let cornerColumn = ((i32(left) + (corner & 1)) % columns + columns) % columns;
    let cornerRow = clamp(i32(top) + (corner >> 1u), 0, rows - 1);
    let weight = select(1.0 - shareX, shareX, (corner & 1) == 1) * select(1.0 - shareY, shareY, (corner >> 1u) == 1);
    total += weight * environmentColors[cornerRow * columns + cornerColumn].rgb * params.environmentShape.z;
  }
  return total;
}

fn environmentPdf(direction: vec3<f32>) -> f32 {
  let width = params.environmentShape.x;
  let height = params.environmentShape.y;
  let cosine = params.environmentRotationAndRays.x;
  let sine = params.environmentRotationAndRays.y;
  let mapX = cosine * direction.x - sine * direction.z;
  let mapZ = sine * direction.x + cosine * direction.z;
  let column = min(i32(width) - 1, i32(floor((atan2(mapX, -mapZ) / TWO_PI + 0.5) * width)));
  let polar = acos(clamp(direction.y, -1.0, 1.0));
  let row = min(i32(height) - 1, i32(floor(polar / PI * height)));
  let sinePolar = max(sin(polar), 1e-6);
  let rowWeight = sin(PI * (f32(row) + 0.5) / height);
  let texel = environmentColors[row * i32(width) + column].rgb;
  let weight = (luminance(texel) + 1e-6) * rowWeight;
  return weight / params.environmentShape.w * width * height / (TWO_PI * PI * sinePolar);
}

// The cumulative row table sits first in environmentTables, the per-pixel tables follow it.
fn firstIndexAbove(tableOffset: i32, start: i32, end: i32, threshold: f32) -> i32 {
  var low = start;
  var high = end - 1;
  for (var step = 0; step < 24; step++) {
    if (low >= high) { break; }
    let middle = (low + high) >> 1u;
    if (environmentTables[tableOffset + middle] < threshold) { low = middle + 1; } else { high = middle; }
  }
  return low;
}

var<private> sampledDirection: vec3<f32>;

// Draws a direction in proportion to the map's light into sampledDirection; returns its pdf.
fn sampleEnvironment(rowUnit: f32, columnUnit: f32, columnJitter: f32, rowJitter: f32) -> f32 {
  let width = i32(params.environmentShape.x);
  let height = i32(params.environmentShape.y);
  let row = firstIndexAbove(0, 0, height, rowUnit);
  let rowBase = row * width;
  let column = firstIndexAbove(height, rowBase, rowBase + width, columnUnit) - rowBase;
  let polar = PI * (f32(row) + rowJitter) / f32(height);
  let azimuth = ((f32(column) + columnJitter) / f32(width) - 0.5) * TWO_PI;
  let sinePolar = sin(polar);
  let mapX = sinePolar * sin(azimuth);
  let mapZ = -sinePolar * cos(azimuth);
  let cosine = params.environmentRotationAndRays.x;
  let sine = params.environmentRotationAndRays.y;
  sampledDirection = vec3<f32>(cosine * mapX + sine * mapZ, cos(polar), -sine * mapX + cosine * mapZ);
  return environmentPdf(sampledDirection);
}

// ---- Microfacet pieces ----

fn ggxDistribution(alpha: f32, cosineHalf: f32) -> f32 {
  let alphaSquared = alpha * alpha;
  let denominator = cosineHalf * cosineHalf * (alphaSquared - 1.0) + 1.0;
  return alphaSquared / (PI * denominator * denominator);
}

fn smithMasking(alpha: f32, cosine: f32) -> f32 {
  let alphaSquared = alpha * alpha;
  return 2.0 * cosine / (cosine + sqrt(alphaSquared + (1.0 - alphaSquared) * cosine * cosine));
}

fn schlick(reflectanceAtNormal: f32, cosine: f32) -> f32 {
  let weight = pow(1.0 - clamp(cosine, 0.0, 1.0), 5.0);
  return reflectanceAtNormal + (1.0 - reflectanceAtNormal) * weight;
}

fn schlickColor(reflectanceAtNormal: vec3<f32>, cosine: f32) -> vec3<f32> {
  let weight = pow(1.0 - clamp(cosine, 0.0, 1.0), 5.0);
  return reflectanceAtNormal + (1.0 - reflectanceAtNormal) * weight;
}

fn sampleVisibleNormal(view: vec3<f32>, alpha: f32, firstUnit: f32, secondUnit: f32) -> vec3<f32> {
  var stretched = vec3<f32>(alpha * view.x, alpha * view.y, view.z);
  let stretchedLength = length(stretched);
  stretched /= stretchedLength;
  let heightAxis = stretched.z;
  let planeLength = length(stretched.xy);
  let planeDirection = select(vec2<f32>(0.0), stretched.xy / planeLength, planeLength > 0.0);
  let tangent = select(vec2<f32>(1.0, 0.0), vec2<f32>(-stretched.y, stretched.x) / planeLength, planeLength > 0.0);
  let bitangentXY = -heightAxis * planeDirection;
  let bitangentZ = planeLength;
  let radius = sqrt(firstUnit);
  let angle = TWO_PI * secondUnit;
  let diskX = radius * cos(angle);
  var diskY = radius * sin(angle);
  let blend = 0.5 * (1.0 + heightAxis);
  diskY = (1.0 - blend) * sqrt(1.0 - diskX * diskX) + blend * diskY;
  let lift = sqrt(max(0.0, 1.0 - diskX * diskX - diskY * diskY));
  let normalXY = diskX * tangent + diskY * bitangentXY + lift * stretched.xy;
  let normalZ = diskY * bitangentZ + lift * heightAxis;
  let unstretched = vec3<f32>(alpha * normalXY.x, alpha * normalXY.y, max(0.0, normalZ));
  return unstretched / length(unstretched);
}

fn roughnessToAlpha(roughness: f32) -> f32 {
  return max(roughness * roughness, MINIMUM_ALPHA);
}

// ---- The layered surface ----

var<private> surfaceFrame: mat3x3<f32>;
var<private> surfaceView: vec3<f32>;
var<private> surfaceViewCosine: f32;
var<private> surfaceDiffuse: vec3<f32>;
var<private> surfaceSpecularNormal: vec3<f32>;
var<private> surfaceSpecularWeight: f32;
var<private> surfaceSpecularAlpha: f32;
var<private> surfaceCoatWeight: f32;
var<private> surfaceCoatChance: f32;
var<private> surfaceSampledCoat: bool;
var<private> surfaceCoatAlpha: f32;
var<private> surfaceDiffuseChance: f32;
var<private> surfaceDiffuseShare: f32;
var<private> surfaceSpecularChance: f32;
var<private> surfaceValue: vec3<f32>;
var<private> surfacePdf: f32;

fn dielectricSpecularAlbedo(normalReflectance: f32, roughness: f32, viewCosine: f32) -> f32 {
  let smoothness = 1.0 - roughness;
  let slope = min(smoothness * smoothness, exp2(-9.28 * viewCosine)) * smoothness + (0.0425 - 0.0275 * roughness);
  let scale = 1.04 - 0.572 * roughness - 1.04 * slope;
  let offset = 1.04 * slope + 0.022 * roughness - 0.04;
  return clamp(normalReflectance * scale + offset, 0.0, 1.0);
}

fn prepareSurface(normal: vec3<f32>, view: vec3<f32>) {
  surfaceFrame = buildFrame(normal);
  surfaceView = view;
  let viewCosine = max(dot(normal, view), 1e-4);
  surfaceViewCosine = viewCosine;
  let ratio = (hitIor - 1.0) / (hitIor + 1.0);
  let dielectricNormalReflectance = ratio * ratio;
  let dielectricFresnel = dielectricSpecularAlbedo(dielectricNormalReflectance, hitRoughness, viewCosine);
  surfaceCoatWeight = select(0.0, hitClearcoat * schlick(DIELECTRIC_COAT_REFLECTANCE, viewCosine), hitClearcoat > 0.0);
  let underCoat = 1.0 - surfaceCoatWeight;
  let diffuseShare = (1.0 - hitMetallic) * (1.0 - dielectricFresnel) * underCoat;
  surfaceDiffuse = hitColor * diffuseShare;
  surfaceDiffuseShare = diffuseShare;
  surfaceSpecularNormal = vec3<f32>(dielectricNormalReflectance * (1.0 - hitMetallic)) + hitColor * hitMetallic;
  let specularLuminance = luminance(surfaceSpecularNormal);
  surfaceSpecularWeight = underCoat;
  surfaceSpecularAlpha = roughnessToAlpha(hitRoughness);
  surfaceCoatAlpha = roughnessToAlpha(hitClearcoatRoughness);
  let diffuseLuminance = luminance(surfaceDiffuse);
  let specularChance = schlick(specularLuminance, viewCosine) * underCoat;
  let coatChance = surfaceCoatWeight;
  let sum = diffuseLuminance + specularChance + coatChance;
  surfaceDiffuseChance = select(1.0, diffuseLuminance / sum, sum > 0.0);
  surfaceSpecularChance = select(0.0, specularChance / sum, sum > 0.0);
  surfaceCoatChance = select(0.0, coatChance / sum, sum > 0.0);
}

fn microfacetTerm(alpha: f32, viewCosine: f32, lightCosine: f32, halfCosine: f32) -> f32 {
  return ggxDistribution(alpha, halfCosine) * smithMasking(alpha, viewCosine) * smithMasking(alpha, lightCosine) / (4.0 * viewCosine * lightCosine);
}

fn evaluateSurface(lightDirection: vec3<f32>) {
  surfaceValue = vec3<f32>(0.0);
  surfacePdf = 0.0;
  let normal = surfaceFrame[2];
  let lightCosine = dot(normal, lightDirection);
  if (lightCosine <= 0.0) { return; }
  var halfVector = surfaceView + lightDirection;
  let halfLength = length(halfVector);
  halfVector /= select(halfLength, 1.0, halfLength == 0.0);
  let halfCosine = dot(normal, halfVector);
  let viewHalfCosine = max(dot(surfaceView, halfVector), 0.0);
  let viewCosine = surfaceViewCosine;
  surfacePdf += surfaceDiffuseChance * lightCosine / PI;
  surfaceValue += surfaceDiffuse / PI;
  if (surfaceSpecularChance > 0.0 && surfaceSpecularAlpha > MIRROR_ALPHA) {
    let alpha = surfaceSpecularAlpha;
    let term = microfacetTerm(alpha, viewCosine, lightCosine, halfCosine) * surfaceSpecularWeight;
    surfaceValue += schlickColor(surfaceSpecularNormal, viewHalfCosine) * term;
    surfacePdf += surfaceSpecularChance * smithMasking(alpha, viewCosine) * ggxDistribution(alpha, halfCosine) / (4.0 * viewCosine);
  }
  if (surfaceCoatChance > 0.0 && surfaceCoatAlpha > MIRROR_ALPHA) {
    let alpha = surfaceCoatAlpha;
    let reflectance = schlick(DIELECTRIC_COAT_REFLECTANCE, viewHalfCosine) * microfacetTerm(alpha, viewCosine, lightCosine, halfCosine) * (surfaceCoatWeight / max(schlick(DIELECTRIC_COAT_REFLECTANCE, viewCosine), 1e-6));
    surfaceValue += vec3<f32>(reflectance);
    surfacePdf += surfaceCoatChance * smithMasking(alpha, viewCosine) * ggxDistribution(alpha, halfCosine) / (4.0 * viewCosine);
  }
}

// The next direction of a path goes into sampledDirection; returns true for a mirror lobe, which is followed exactly.
fn sampleSurface(lobeUnit: f32, firstUnit: f32, secondUnit: f32) -> bool {
  if (lobeUnit < surfaceDiffuseChance) {
    let radius = sqrt(firstUnit);
    let angle = TWO_PI * secondUnit;
    sampledDirection = localToWorld(surfaceFrame, vec3<f32>(radius * cos(angle), radius * sin(angle), sqrt(max(0.0, 1.0 - firstUnit))));
    return false;
  }
  let isCoat = lobeUnit >= surfaceDiffuseChance + surfaceSpecularChance;
  surfaceSampledCoat = isCoat;
  let alpha = select(surfaceSpecularAlpha, surfaceCoatAlpha, isCoat);
  let localView = worldToLocal(surfaceFrame, surfaceView);
  if (alpha <= MIRROR_ALPHA) {
    sampledDirection = 2.0 * surfaceViewCosine * surfaceFrame[2] - surfaceView;
    return true;
  }
  let localHalf = sampleVisibleNormal(localView, alpha, firstUnit, secondUnit);
  let localLight = 2.0 * dot(localView, localHalf) * localHalf - localView;
  sampledDirection = localToWorld(surfaceFrame, localLight);
  return false;
}

fn mirrorWeight() -> vec3<f32> {
  if (surfaceSampledCoat) { return vec3<f32>(surfaceCoatWeight / surfaceCoatChance); }
  return schlickColor(surfaceSpecularNormal, surfaceViewCosine) * surfaceSpecularWeight / surfaceSpecularChance;
}

fn dielectricFresnelTerm(cosineIncident: f32, relativeIndex: f32) -> f32 {
  let sineSquared = relativeIndex * relativeIndex * (1.0 - cosineIncident * cosineIncident);
  if (sineSquared >= 1.0) { return 1.0; }
  let cosineTransmitted = sqrt(1.0 - sineSquared);
  let parallel = (relativeIndex * cosineIncident - cosineTransmitted) / (relativeIndex * cosineIncident + cosineTransmitted);
  let perpendicular = (cosineIncident - relativeIndex * cosineTransmitted) / (cosineIncident + relativeIndex * cosineTransmitted);
  return 0.5 * (parallel * parallel + perpendicular * perpendicular);
}

// The glass direction goes into sampledDirection; returns false when the path must end.
fn sampleGlass(normal: vec3<f32>, view: vec3<f32>, entering: bool, ior: f32, alpha: f32, selectionUnit: f32, firstUnit: f32, secondUnit: f32) -> bool {
  let frame = buildFrame(normal);
  var halfVector = normal;
  if (alpha > MIRROR_ALPHA) {
    let localView = worldToLocal(frame, view);
    halfVector = localToWorld(frame, sampleVisibleNormal(localView, alpha, firstUnit, secondUnit));
  }
  let relativeIndex = select(ior, 1.0 / ior, entering);
  let cosineIncident = max(dot(view, halfVector), 1e-6);
  let reflectChance = dielectricFresnelTerm(cosineIncident, relativeIndex);
  if (selectionUnit < reflectChance) {
    sampledDirection = 2.0 * dot(view, halfVector) * halfVector - view;
    return dot(sampledDirection, normal) > 0.0;
  }
  let cosineTransmitted = sqrt(max(0.0, 1.0 - relativeIndex * relativeIndex * (1.0 - cosineIncident * cosineIncident)));
  let bend = relativeIndex * cosineIncident - cosineTransmitted;
  sampledDirection = bend * halfVector - relativeIndex * view;
  return dot(sampledDirection, normal) < 0.0;
}

// ---- One path ----

var<private> throughput: vec3<f32>;
var<private> radiance: vec3<f32>;
var<private> direction: vec3<f32>;
var<private> lightDirection: vec3<f32>;
var<private> lightRadiance: vec3<f32>;
var<private> selectionProbability: f32 = 1.0;
var<private> environmentSampledPdf: f32 = 0.0;
var<private> sunFrame: mat3x3<f32>;
var<private> featureAlbedo: vec3<f32>;
var<private> featureNormal: vec3<f32>;
var<private> featureDepth: f32;
var<private> firstLegEscaped: f32 = 0.0;
var<private> inMedium: bool = false;

fn addRadiance(depth: i32, amountIn: vec3<f32>) {
  var amount = amountIn;
  if (depth > 0) {
    let peak = max(amount.x, max(amount.y, amount.z));
    if (peak > params.cameraAndClamp.z) { amount *= params.cameraAndClamp.z / peak; }
  }
  radiance += amount;
}

fn environmentWeight(candidatePdf: f32) -> f32 {
  let lightPdf = environmentSampledPdf * selectionProbability;
  let total = lightPdf * lightPdf + candidatePdf * candidatePdf;
  return lightPdf * lightPdf / total / lightPdf;
}

fn directWeight(mode: i32, candidatePdf: f32) -> f32 {
  if (mode == 1) { return environmentWeight(candidatePdf); }
  return 1.0 / selectionProbability;
}

// Same shape as the GLSL: addDirect records one shadow ray and flushShadowRay traces it, so the shader holds one copy of the
// shadow-ray traversal.
var<private> shadowOrigin: vec3<f32>;
var<private> shadowDirection: vec3<f32>;
var<private> shadowLimit: f32;
var<private> shadowAmount: vec3<f32>;
var<private> shadowDepth: i32;
var<private> shadowPending: bool = false;

fn addDirect(depth: i32, normal: vec3<f32>, distance: f32, weightMode: i32) {
  ${hasVolume ? `if (inMedium) {
    let phase = henyeyGreensteinPhase(params.volumeMaximumAnisotropy.w, dot(lightDirection, direction));
    let scale = phase * fogTransmittance(hitPoint, distance) * directWeight(weightMode, phase);
    shadowOrigin = hitPoint;
    shadowAmount = throughput * lightRadiance * scale;
    shadowDepth = depth + 1;
  } else {` : '{'}
    let cosine = dot(normal, lightDirection);
    if (cosine <= 0.0) { return; }
    evaluateSurface(lightDirection);
    let value = surfaceValue;
    if (value.x + value.y + value.z <= 0.0) { return; }
    shadowOrigin = hitPoint + normal * params.environmentRotationAndRays.z;
    ${hasVolume ? `let transmittance = fogTransmittance(shadowOrigin, distance);` : `let transmittance = 1.0;`}
    let scale = cosine * directWeight(weightMode, surfacePdf) * transmittance;
    shadowAmount = throughput * value * lightRadiance * scale;
    shadowDepth = depth;
  }
  shadowDirection = lightDirection;
  shadowLimit = distance;
  shadowPending = true;
}

${hasVolume ? VOLUME_FUNCTIONS : ''}
fn flushShadowRay() {
  if (!shadowPending) { return; }
  shadowPending = false;
  if (!occluded(shadowOrigin, shadowDirection, shadowLimit)) { addRadiance(shadowDepth, shadowAmount); }
}

fn reaches(bit: i32) -> bool {
  return inMedium || ((hitMask >> u32(bit)) & 1u) == 1u;
}

// Aims lightDirection at the target and returns the distance; distanceSquared goes into aimedDistanceSquared.
var<private> aimedDistanceSquared: f32;

fn aimAt(aimPoint: vec3<f32>) -> f32 {
  let delta = aimPoint - hitPoint;
  aimedDistanceSquared = dot(delta, delta);
  let distance = sqrt(aimedDistanceSquared);
  lightDirection = delta / distance;
  return distance;
}

fn randomOnSphere(radius: f32) -> vec3<f32> {
  let height = 2.0 * nextRandom() - 1.0;
  let angle = TWO_PI * nextRandom();
  let ring = sqrt(1.0 - height * height);
  return vec3<f32>(radius * ring * cos(angle), radius * height, radius * ring * sin(angle));
}

fn pointLightFalloff(distanceSquared: f32, range: f32, radius: f32) -> f32 {
  var cutoff = 1.0;
  if (range > 0.0) {
    let ratio = distanceSquared / (range * range);
    let fade = max(1.0 - ratio * ratio, 0.0);
    cutoff = fade * fade;
  }
  return cutoff / max(distanceSquared, radius * radius);
}

// Draws one emitter's contribution into the pending shadow ray: emitter 0 is the sun when there is one, then the lights, then the sky.
fn sampleEmitter(depth: i32, normal: vec3<f32>, emitter: i32) {
  var distance = 0.0;
  var weightMode = 0;
  let hasSun = params.emittersFlagsSample.y != 0;
  let lightCount = params.sizeBouncesLights.w;
  if (hasSun && emitter == 0) {
    if (!reaches(0)) { return; }
    let cosineTheta = 1.0 - nextRandom() * (1.0 - params.sunColorAndCosine.w);
    let sineTheta = sqrt(max(0.0, 1.0 - cosineTheta * cosineTheta));
    let phi = TWO_PI * nextRandom();
    lightDirection = sunFrame[0] * (sineTheta * cos(phi)) + sunFrame[1] * (sineTheta * sin(phi)) + sunFrame[2] * cosineTheta;
    lightRadiance = params.sunColorAndCosine.rgb;
    distance = params.environmentRotationAndRays.w;
  } else {
    let index = emitter - select(0, 1, hasSun);
    if (index < lightCount) {
      let base = index * LIGHT_TEXELS;
      let positionType = lights[base];
      let colorBit = lights[base + 1];
      let directionRadius = lights[base + 2];
      let acrossCone = lights[base + 3];
      let alongBlend = lights[base + 4];
      let intensityRange = lights[base + 5];
      let lightType = i32(positionType.w);
      if (!reaches(i32(colorBit.w))) { return; }
      if (lightType == 2) {
        let across = (nextRandom() - 0.5) * directionRadius.w;
        let along = (nextRandom() - 0.5) * acrossCone.w;
        let point = positionType.xyz + acrossCone.xyz * across + alongBlend.xyz * along;
        distance = aimAt(point);
        let emitCosine = -dot(directionRadius.xyz, lightDirection);
        if (distance < 1e-6 || emitCosine <= 0.0) { return; }
        lightRadiance = colorBit.rgb * (intensityRange.x * emitCosine / aimedDistanceSquared);
      } else {
        let jitter = randomOnSphere(directionRadius.w);
        distance = aimAt(positionType.xyz + jitter);
        if (distance < 1e-6) { return; }
        var mask = 1.0;
        if (lightType == 1) {
          let inside = -dot(directionRadius.xyz, lightDirection) - acrossCone.w;
          if (inside <= 0.0) { return; }
          if (alongBlend.w > 0.0 && inside < alongBlend.w) {
            let unit = inside / alongBlend.w;
            mask = unit * unit * (3.0 - 2.0 * unit);
          }
        }
        lightRadiance = colorBit.rgb * (intensityRange.x * pointLightFalloff(aimedDistanceSquared, intensityRange.y, directionRadius.w) * mask);
      }
      distance -= params.environmentRotationAndRays.z;
    } else {
      let rowUnit = nextRandom();
      let columnUnit = nextRandom();
      let columnJitter = nextRandom();
      let rowJitter = nextRandom();
      environmentSampledPdf = sampleEnvironment(rowUnit, columnUnit, columnJitter, rowJitter);
      lightDirection = sampledDirection;
      if (!(environmentSampledPdf > 0.0)) { return; }
      lightRadiance = environmentRadiance(lightDirection);
      distance = params.environmentRotationAndRays.w;
      weightMode = 1;
    }
  }
  addDirect(depth, normal, distance, weightMode);
}

fn addEscape(depth: i32, previousPdf: f32, afterMirror: bool) {
  if (params.emittersFlagsSample.z == 0) { return; }
  let sky = environmentRadiance(direction);
  var weight = 1.0;
  if (!afterMirror) {
    let environmentSide = environmentPdf(direction) * selectionProbability;
    weight = previousPdf * previousPdf / (previousPdf * previousPdf + environmentSide * environmentSide);
  }
  addRadiance(depth, throughput * sky * weight);
}

fn survivesRoulette(depth: i32) -> bool {
  if (depth < RUSSIAN_ROULETTE_START) { return true; }
  let survival = min(0.95, max(0.05, max(throughput.x, max(throughput.y, throughput.z))));
  if (nextRandom() >= survival) { return false; }
  throughput /= survival;
  return true;
}
`;
const COMMON_SOURCE = buildCommonSource();

// One invocation per pixel of the image.
const CAMERA_MAIN = /* wgsl */ `
@compute @workgroup_size(${WORKGROUP_SIZE}, ${WORKGROUP_SIZE}, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
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
  tracePath(params.eye.xyz, rayDirection, pixel, sampleIndex);
  if (!(all(radiance >= vec3<f32>(0.0)) && all(radiance < vec3<f32>(1e30)))) { radiance = vec3<f32>(0.0); }
  if (!(featureDepth >= 0.0 && featureDepth < 1e30)) { featureDepth = 0.0; }
  if (!(all(featureNormal >= vec3<f32>(-1.5)) && all(featureNormal < vec3<f32>(1.5)))) { featureNormal = vec3<f32>(0.0, 0.0, 1.0); }
  if (!(all(featureAlbedo >= vec3<f32>(0.0)) && all(featureAlbedo < vec3<f32>(1e30)))) { featureAlbedo = vec3<f32>(1.0); }
  let sampleLuminance = luminance(radiance);
  let pixelCount = u32(width * height);
  accumulation[pixel] += vec4<f32>(radiance, featureDepth);
  accumulation[pixelCount + pixel] += vec4<f32>(featureAlbedo, 0.0);
  accumulation[2u * pixelCount + pixel] += vec4<f32>(featureNormal, 0.0);
  accumulation[3u * pixelCount + pixel] += vec4<f32>(sampleLuminance, sampleLuminance * sampleLuminance, firstLegEscaped, 0.0);
}
`;

// Texel mode: one invocation is one lightmap texel (params.sizeBouncesLights.x is the texel count, shadowSlots.z the sample
// count). The path starts on the texel's surface with a cosine weighted direction, so the radiance it returns is the light
// that arrives at the texel; the bake multiplies by the albedo. Plane 0 of the accumulation holds the radiance sums, plane 1
// the sums of first rays that left the scene.
const TEXEL_MAIN = /* wgsl */ `
@group(0) @binding(9) var<storage, read_write> texelPoints: array<vec4<f32>>;
@group(0) @binding(10) var<storage, read_write> texelNormals: array<vec4<f32>>;

@compute @workgroup_size(${WAVEFRONT_WORKGROUP_SIZE})
fn bakeTexels(@builtin(global_invocation_id) id: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let texelCount = u32(params.sizeBouncesLights.x);
  let texelIndex = id.y * groups.x * ${WAVEFRONT_WORKGROUP_SIZE}u + id.x;
  if (texelIndex >= texelCount) { return; }
  let sampleIndex = u32(params.emittersFlagsSample.w);
  let seed = params.seedAndAtlas.x;
  if (params.emittersFlagsSample.y != 0) { sunFrame = buildFrame(params.sunDirection.xyz); }
  let normal = texelNormals[texelIndex].xyz;
  let origin = texelPoints[texelIndex].xyz + normal * params.environmentRotationAndRays.z;
  let firstUnit = (f32(sampleIndex) + hashJitter(texelIndex, sampleIndex, seed, 1u)) / f32(params.shadowSlots.z);
  let secondUnit = hashJitter(texelIndex, sampleIndex, seed, 2u);
  let coneRadius = sqrt(firstUnit);
  let angle = TWO_PI * secondUnit;
  let rayDirection = buildFrame(normal) * vec3<f32>(coneRadius * cos(angle), coneRadius * sin(angle), sqrt(max(0.0, 1.0 - firstUnit)));
  tracePath(origin, rayDirection, texelIndex, sampleIndex);
  if (!(all(radiance >= vec3<f32>(0.0)) && all(radiance < vec3<f32>(1e30)))) { radiance = vec3<f32>(0.0); }
  accumulation[texelIndex] += vec4<f32>(radiance, 0.0);
  accumulation[texelCount + texelIndex] += vec4<f32>(firstLegEscaped, 0.0, 0.0, 0.0);
}
`;

export const buildMegakernelSource = ({ hasVolume = false, hasSubsurface = false, texelBake = false } = {}) => buildCommonSource({ hasVolume }) + /* wgsl */ `
// The first hit lights from every emitter; later hits draw one, and divide by the chance of drawing it.
fn addLights(depth: i32, normal: vec3<f32>) {
  let emitterCount = params.emittersFlagsSample.x;
  if (depth == 0 || emitterCount <= 1) {
    selectionProbability = 1.0;
    for (var emitter = 0; emitter < emitterCount; emitter++) {
      sampleEmitter(depth, normal, emitter);
      flushShadowRay();
    }
    return;
  }
  selectionProbability = 1.0 / f32(emitterCount);
  sampleEmitter(depth, normal, i32(floor(nextRandom() * f32(emitterCount))));
  flushShadowRay();
}
${hasSubsurface ? SUBSURFACE_FUNCTIONS : ''}
fn tracePath(origin: vec3<f32>, startDirection: vec3<f32>, pixel: u32, sampleIndex: u32) {
  resetRandom(pixel, sampleIndex, params.seedAndAtlas.x);
  radiance = vec3<f32>(0.0);
  throughput = vec3<f32>(1.0);
  featureAlbedo = vec3<f32>(1.0);
  featureNormal = vec3<f32>(0.0, 0.0, 1.0);
  featureDepth = 0.0;
  var featuresRecorded = false;
  direction = startDirection;
  var position = origin;
  var previousPdf = 0.0;
  var afterMirror = true;
  var normal = vec3<f32>(0.0, 1.0, 0.0);
  let bounces = params.sizeBouncesLights.z;
  let surfaceOffset = params.environmentRotationAndRays.z;
  for (var depth = 0; depth <= bounces; depth++) {
    let found = intersectScene(position, direction);
    ${hasVolume ? 'let inFog = scatterInFog(position, select(params.environmentRotationAndRays.w, hitDistance, found));' : 'let inFog = false;'}
    if (!inFog && !found) {
      if (depth == 0) { firstLegEscaped = 1.0; }
      addEscape(depth, previousPdf, afterMirror);
      break;
    }
    var isGlass = false;
    var entering = true;
    var needsLights = true;
    if (inFog) {
      throughput *= params.volumeAlbedoDistance.xyz;
      inMedium = true;
    } else {
      entering = dot(hitNormal, direction) < 0.0;
      normal = select(-hitNormal, hitNormal, entering);
      isGlass = hitTransmission > 0.0 && nextRandom() < hitTransmission;
      if (!featuresRecorded) {
        featureAlbedo = select(hitColor, vec3<f32>(1.0), isGlass);
        featureNormal = normal;
        featureDepth = hitDistance;
        featuresRecorded = true;
      }
      addRadiance(depth, throughput * hitEmission);
      needsLights = !isGlass;
      if (needsLights) {
        prepareSurface(normal, -direction);
        ${hasSubsurface ? 'subsurfaceWeight = splitSubsurface();' : ''}
      }
    }
    if (needsLights) { addLights(depth, normal); }
    inMedium = false;
    ${hasVolume ? `if (inFog) {
      let phaseCosine = sampleHenyeyGreensteinCosine(params.volumeMaximumAnisotropy.w, nextRandom());
      let phaseSine = sqrt(max(0.0, 1.0 - phaseCosine * phaseCosine));
      let azimuth = TWO_PI * nextRandom();
      let frame = buildFrame(direction);
      direction = frame[0] * phaseSine * cos(azimuth) + frame[1] * phaseSine * sin(azimuth) + frame[2] * phaseCosine;
      previousPdf = henyeyGreensteinPhase(params.volumeMaximumAnisotropy.w, phaseCosine);
      afterMirror = false;
      position = hitPoint;
      if (!survivesRoulette(depth)) { break; }
      continue;
    }` : ''}
    if (isGlass) {
      let alpha = roughnessToAlpha(hitRoughness);
      let selectionUnit = nextRandom();
      let firstUnit = nextRandom();
      let secondUnit = nextRandom();
      if (!sampleGlass(normal, -direction, entering, hitIor, alpha, selectionUnit, firstUnit, secondUnit)) { break; }
      direction = sampledDirection;
      if (dot(direction, normal) < 0.0) { throughput *= hitColor; }
      afterMirror = true;
    } else {
      var lobeUnit = nextRandom();
      ${hasSubsurface ? `if (subsurfaceWeight > 0.0) {
        if (lobeUnit < surfaceSubsurfaceChance) {
          if (!enterSubsurface(depth, normal)) { break; }
          normal = subsurfaceNormal;
          lobeUnit = 0.0;
        } else {
          lobeUnit -= surfaceSubsurfaceChance;
        }
      }` : ''}
      let firstUnit = nextRandom();
      let secondUnit = nextRandom();
      let isMirror = sampleSurface(lobeUnit, firstUnit, secondUnit);
      direction = sampledDirection;
      let cosine = dot(direction, normal);
      if (cosine <= 0.0) { break; }
      if (isMirror) {
        throughput *= mirrorWeight();
        afterMirror = true;
      } else {
        evaluateSurface(direction);
        if (!(surfacePdf > 0.0)) { break; }
        throughput *= surfaceValue * cosine / surfacePdf;
        previousPdf = surfacePdf;
        afterMirror = false;
      }
    }
    position = hitPoint + direction * surfaceOffset;
    if (!survivesRoulette(depth)) { break; }
  }
}

${texelBake ? TEXEL_MAIN : CAMERA_MAIN}
`;

export const MEGAKERNEL_SOURCE = buildMegakernelSource();

export const WAVEFRONT_SOURCE = COMMON_SOURCE + /* wgsl */ `
// Path state: PATH_STATE_VECTORS vec4<u32> per path (floats are stored as their bits, so nothing is ever rounded or
// canonicalised on the way through memory), then the shadow records, three vec4 per emitter slot of a path.
//   0 origin, previous pdf   1 direction, selection probability   2 throughput   3 radiance, first leg escaped
//   4 albedo   5 normal, depth   6 start of the last ray segment, distance in it   7 u, v, distance before the segment
//   8 random state, flags, hit triangle slot, material
// Shadow record: 0 origin, limit   1 direction, unused   2 amount, 1 when the ray is pending.
@group(0) @binding(9) var<storage, read_write> pathState: array<vec4<u32>>;
// Word 0 counts the hits of this bounce; then per material the count and the write cursor; then the hits sorted by material.
@group(0) @binding(10) var<storage, read_write> binQueue: array<atomic<u32>>;

const PATH_STATE_VECTORS: u32 = ${PATH_STATE_VECTORS}u;
const FLAG_ALIVE: u32 = 1u;
const FLAG_AFTER_MIRROR: u32 = 2u;
const FLAG_HIT: u32 = 4u;
const FLAG_SHADED: u32 = 8u;

fn loadVector(index: u32) -> vec4<f32> {
  return bitcast<vec4<f32>>(pathState[index]);
}

fn storeVector(index: u32, value: vec4<f32>) {
  pathState[index] = bitcast<vec4<u32>>(value);
}

fn tilePathCount() -> u32 {
  return params.tileAndDepth.y;
}

fn currentDepth() -> i32 {
  return i32(params.tileAndDepth.z);
}

fn materialCount() -> u32 {
  return params.tileAndDepth.w;
}

// How many shadow rays a path casts at this depth: every emitter at the first hit, one afterwards.
fn emitterSlotCount(depth: i32) -> u32 {
  let emitterCount = u32(max(params.emittersFlagsSample.x, 0));
  if (depth == 0 || emitterCount <= 1u) { return emitterCount; }
  return 1u;
}

fn shadowRecordBase(path: u32, slot: u32) -> u32 {
  return tilePathCount() * PATH_STATE_VECTORS + (path * params.shadowSlots.x + slot) * 3u;
}

fn storeShadowRecord(path: u32, slot: u32) {
  let base = shadowRecordBase(path, slot);
  if (shadowPending) {
    storeVector(base, vec4<f32>(shadowOrigin, shadowLimit));
    storeVector(base + 1u, vec4<f32>(shadowDirection, 0.0));
    storeVector(base + 2u, vec4<f32>(shadowAmount, 1.0));
  } else {
    storeVector(base + 2u, vec4<f32>(0.0));
  }
}

// Paths are numbered in blocks of 8 by 8 pixels, so the 64 paths of a workgroup look at neighbouring pixels (rays that start
// close together traverse the same part of the BVH). Numbers past the edge of the image have no pixel.
fn blockedPixel(globalPath: u32) -> vec2<u32> {
  let blocksPerRow = (u32(params.sizeBouncesLights.x) + 7u) / 8u;
  let block = globalPath / 64u;
  let within = globalPath % 64u;
  return vec2<u32>((block % blocksPerRow) * 8u + within % 8u, (block / blocksPerRow) * 8u + within / 8u);
}

fn queuedPath(position: u32) -> u32 {
  return atomicLoad(&binQueue[1u + 2u * materialCount() + position]);
}

@compute @workgroup_size(${WAVEFRONT_WORKGROUP_SIZE})
fn generatePaths(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= tilePathCount()) { return; }
  let width = u32(params.sizeBouncesLights.x);
  let height = u32(params.sizeBouncesLights.y);
  let coordinates = blockedPixel(params.tileAndDepth.x + id.x);
  let pixelX = coordinates.x;
  let pixelY = coordinates.y;
  if (pixelX >= width || pixelY >= height) {
    pathState[id.x * PATH_STATE_VECTORS + 8u] = vec4<u32>(0u);
    return;
  }
  let pixel = pixelY * width + pixelX;
  let sampleIndex = u32(params.emittersFlagsSample.w);
  let seed = params.seedAndAtlas.x;
  let jitterX = hashJitter(pixel, sampleIndex, seed, 1u);
  let jitterY = hashJitter(pixel, sampleIndex, seed, 2u);
  let screenX = ((f32(pixelX) + jitterX) / f32(width) * 2.0 - 1.0) * params.cameraAndClamp.x;
  let screenY = (1.0 - (f32(pixelY) + jitterY) / f32(height) * 2.0) * params.cameraAndClamp.y;
  let rayDirection = normalize(params.forward.xyz + params.right.xyz * screenX + params.above.xyz * screenY);
  resetRandom(pixel, sampleIndex, seed);
  let base = id.x * PATH_STATE_VECTORS;
  storeVector(base, vec4<f32>(params.eye.xyz, 0.0));
  storeVector(base + 1u, vec4<f32>(rayDirection, 1.0));
  storeVector(base + 2u, vec4<f32>(1.0, 1.0, 1.0, 0.0));
  storeVector(base + 3u, vec4<f32>(0.0));
  storeVector(base + 4u, vec4<f32>(1.0, 1.0, 1.0, 0.0));
  storeVector(base + 5u, vec4<f32>(0.0, 0.0, 1.0, 0.0));
  pathState[base + 8u] = vec4<u32>(rngState, FLAG_ALIVE | FLAG_AFTER_MIRROR, 0u, 0u);
}

@compute @workgroup_size(${WAVEFRONT_WORKGROUP_SIZE})
fn resetBins(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x == 0u) { atomicStore(&binQueue[0], 0u); }
  if (id.x < materialCount()) { atomicStore(&binQueue[1u + id.x], 0u); }
}

// Finds the nearest solid hit of every live path (stepping through the transparent texels of cutout materials), adds the
// sky to paths that left the scene, and counts the hits per material.
@compute @workgroup_size(${WAVEFRONT_WORKGROUP_SIZE})
fn extendPaths(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= tilePathCount()) { return; }
  let base = id.x * PATH_STATE_VECTORS;
  var pathMeta = pathState[base + 8u];
  let flags = pathMeta.y;
  if ((flags & FLAG_ALIVE) == 0u) { return; }
  let originPrevious = loadVector(base);
  let directionSelection = loadVector(base + 1u);
  let rayDirection = directionSelection.xyz;
  let farDistance = params.environmentRotationAndRays.w;
  let surfaceOffset = params.environmentRotationAndRays.z;
  var start = originPrevious.xyz;
  var travelled = 0.0;
  var found = false;
  for (var attempt = 0; attempt < ALPHA_STEP_LIMIT; attempt++) {
    traceRay(start, rayDirection, farDistance, false);
    if (nearestSlot < 0) { break; }
    let material = i32(triangles[nearestSlot * TRIANGLE_TEXELS].w) * MATERIAL_TEXELS;
    let cutoff = materials[material + 3].z;
    if (cutoff == 0.0 || alphaAtNearestHit() >= cutoff) {
      found = true;
      break;
    }
    let advance = nearestDistance + surfaceOffset;
    travelled += advance;
    start += rayDirection * advance;
  }
  if (found) {
    let materialIndex = u32(triangles[nearestSlot * TRIANGLE_TEXELS].w);
    storeVector(base + 6u, vec4<f32>(start, nearestDistance));
    storeVector(base + 7u, vec4<f32>(nearestU, nearestV, travelled, 0.0));
    pathMeta = vec4<u32>(pathMeta.x, flags | FLAG_HIT, u32(nearestSlot), materialIndex);
    pathState[base + 8u] = pathMeta;
    if (params.shadowSlots.y == 1u) { atomicAdd(&binQueue[1u + materialIndex], 1u); }
    return;
  }
  var radianceData = loadVector(base + 3u);
  if (currentDepth() == 0) { radianceData.w = 1.0; }
  direction = rayDirection;
  throughput = loadVector(base + 2u).xyz;
  radiance = radianceData.xyz;
  selectionProbability = directionSelection.w;
  addEscape(currentDepth(), originPrevious.w, (flags & FLAG_AFTER_MIRROR) != 0u);
  storeVector(base + 3u, vec4<f32>(radiance, radianceData.w));
  pathMeta.y = flags & ~(FLAG_ALIVE | FLAG_HIT);
  pathState[base + 8u] = pathMeta;
}

@compute @workgroup_size(1)
fn scanBins() {
  let count = materialCount();
  var running = 0u;
  for (var material = 0u; material < count; material++) {
    atomicStore(&binQueue[1u + count + material], running);
    running += atomicLoad(&binQueue[1u + material]);
  }
  atomicStore(&binQueue[0], running);
}

@compute @workgroup_size(${WAVEFRONT_WORKGROUP_SIZE})
fn scatterPaths(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= tilePathCount()) { return; }
  let pathMeta = pathState[id.x * PATH_STATE_VECTORS + 8u];
  if ((pathMeta.y & FLAG_HIT) == 0u) { return; }
  let count = materialCount();
  let position = atomicAdd(&binQueue[1u + count + pathMeta.w], 1u);
  atomicStore(&binQueue[1u + 2u * count + position], id.x);
}

// Shades the hits in material order: emission, features, one shadow record per emitter, then the next direction. Draws
// random numbers in the order of the megakernel, so the picture is the same.
@compute @workgroup_size(${WAVEFRONT_WORKGROUP_SIZE})
fn shadePaths(@builtin(global_invocation_id) id: vec3<u32>) {
  var path = id.x;
  if (params.shadowSlots.y == 1u) {
    if (id.x >= atomicLoad(&binQueue[0])) { return; }
    path = queuedPath(id.x);
  } else {
    if (id.x >= tilePathCount()) { return; }
    if ((pathState[id.x * PATH_STATE_VECTORS + 8u].y & FLAG_HIT) == 0u) { return; }
  }
  let base = path * PATH_STATE_VECTORS;
  let depth = currentDepth();
  let originPrevious = loadVector(base);
  let directionSelection = loadVector(base + 1u);
  let radianceData = loadVector(base + 3u);
  let hitStart = loadVector(base + 6u);
  let hitInfo = loadVector(base + 7u);
  var pathMeta = pathState[base + 8u];
  rngState = pathMeta.x;
  direction = directionSelection.xyz;
  selectionProbability = directionSelection.w;
  throughput = loadVector(base + 2u).xyz;
  radiance = radianceData.xyz;
  nearestSlot = i32(pathMeta.z);
  nearestU = hitInfo.x;
  nearestV = hitInfo.y;
  _ = fillHit(hitStart.xyz, direction, hitStart.w);
  hitDistance += hitInfo.z;
  let entering = dot(hitNormal, direction) < 0.0;
  let normal = select(-hitNormal, hitNormal, entering);
  let isGlass = hitTransmission > 0.0 && nextRandom() < hitTransmission;
  if (depth == 0) {
    storeVector(base + 4u, vec4<f32>(select(hitColor, vec3<f32>(1.0), isGlass), 0.0));
    storeVector(base + 5u, vec4<f32>(normal, hitDistance));
  }
  addRadiance(depth, throughput * hitEmission);
  if (params.emittersFlagsSample.y != 0) { sunFrame = buildFrame(params.sunDirection.xyz); }
  if (isGlass) {
    let slotCount = emitterSlotCount(depth);
    for (var slot = 0u; slot < slotCount; slot++) {
      shadowPending = false;
      storeShadowRecord(path, slot);
    }
  } else {
    prepareSurface(normal, -direction);
    let emitterCount = params.emittersFlagsSample.x;
    if (depth == 0 || emitterCount <= 1) {
      selectionProbability = 1.0;
      for (var emitter = 0; emitter < emitterCount; emitter++) {
        shadowPending = false;
        sampleEmitter(depth, normal, emitter);
        storeShadowRecord(path, u32(emitter));
      }
    } else {
      selectionProbability = 1.0 / f32(emitterCount);
      shadowPending = false;
      sampleEmitter(depth, normal, i32(floor(nextRandom() * f32(emitterCount))));
      storeShadowRecord(path, 0u);
    }
  }
  var alive = depth < params.sizeBouncesLights.z;
  var afterMirror = (pathMeta.y & FLAG_AFTER_MIRROR) != 0u;
  var previousPdf = originPrevious.w;
  if (alive && isGlass) {
    let alpha = roughnessToAlpha(hitRoughness);
    let selectionUnit = nextRandom();
    let firstUnit = nextRandom();
    let secondUnit = nextRandom();
    if (sampleGlass(normal, -direction, entering, hitIor, alpha, selectionUnit, firstUnit, secondUnit)) {
      direction = sampledDirection;
      if (dot(direction, normal) < 0.0) { throughput *= hitColor; }
      afterMirror = true;
    } else {
      alive = false;
    }
  } else if (alive) {
    let lobeUnit = nextRandom();
    let firstUnit = nextRandom();
    let secondUnit = nextRandom();
    let isMirror = sampleSurface(lobeUnit, firstUnit, secondUnit);
    direction = sampledDirection;
    let cosine = dot(direction, normal);
    if (cosine <= 0.0) {
      alive = false;
    } else if (isMirror) {
      throughput *= mirrorWeight();
      afterMirror = true;
    } else {
      evaluateSurface(direction);
      if (surfacePdf > 0.0) {
        throughput *= surfaceValue * cosine / surfacePdf;
        previousPdf = surfacePdf;
        afterMirror = false;
      } else {
        alive = false;
      }
    }
  }
  var nextOrigin = originPrevious.xyz;
  if (alive) {
    nextOrigin = hitPoint + direction * params.environmentRotationAndRays.z;
    alive = survivesRoulette(depth);
  }
  storeVector(base, vec4<f32>(nextOrigin, previousPdf));
  storeVector(base + 1u, vec4<f32>(direction, selectionProbability));
  storeVector(base + 2u, vec4<f32>(throughput, 0.0));
  storeVector(base + 3u, vec4<f32>(radiance, radianceData.w));
  pathMeta.x = rngState;
  pathMeta.y = select(0u, FLAG_ALIVE, alive) | select(0u, FLAG_AFTER_MIRROR, afterMirror) | FLAG_SHADED;
  pathState[base + 8u] = pathMeta;
}

// Traces the shadow rays the shade kernel recorded and adds the light that gets through. It walks the paths in pixel order
// (not material order) so that neighbouring invocations cast rays from neighbouring points.
@compute @workgroup_size(${WAVEFRONT_WORKGROUP_SIZE})
fn shadowPaths(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= tilePathCount()) { return; }
  let path = id.x;
  let base = path * PATH_STATE_VECTORS;
  var pathMeta = pathState[base + 8u];
  if ((pathMeta.y & FLAG_SHADED) == 0u) { return; }
  pathMeta.y = pathMeta.y & ~FLAG_SHADED;
  pathState[base + 8u] = pathMeta;
  let depth = currentDepth();
  let radianceData = loadVector(base + 3u);
  radiance = radianceData.xyz;
  let slotCount = emitterSlotCount(depth);
  for (var slot = 0u; slot < slotCount; slot++) {
    let recordBase = shadowRecordBase(path, slot);
    let amount = loadVector(recordBase + 2u);
    if (amount.w == 0.0) { continue; }
    let origin = loadVector(recordBase);
    let rayDirection = loadVector(recordBase + 1u).xyz;
    if (!occluded(origin.xyz, rayDirection, origin.w)) { addRadiance(depth, amount.xyz); }
  }
  storeVector(base + 3u, vec4<f32>(radiance, radianceData.w));
}

// Adds the finished sample of every path of the tile to the accumulation planes, dropping non-finite values as the megakernel does.
@compute @workgroup_size(${WAVEFRONT_WORKGROUP_SIZE})
fn resolvePaths(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= tilePathCount()) { return; }
  let coordinates = blockedPixel(params.tileAndDepth.x + id.x);
  if (coordinates.x >= u32(params.sizeBouncesLights.x) || coordinates.y >= u32(params.sizeBouncesLights.y)) { return; }
  let base = id.x * PATH_STATE_VECTORS;
  let radianceData = loadVector(base + 3u);
  let normalDepth = loadVector(base + 5u);
  var sampleRadiance = radianceData.xyz;
  var sampleAlbedo = loadVector(base + 4u).xyz;
  var sampleNormal = normalDepth.xyz;
  var sampleDepth = normalDepth.w;
  if (!(all(sampleRadiance >= vec3<f32>(0.0)) && all(sampleRadiance < vec3<f32>(1e30)))) { sampleRadiance = vec3<f32>(0.0); }
  if (!(sampleDepth >= 0.0 && sampleDepth < 1e30)) { sampleDepth = 0.0; }
  if (!(all(sampleNormal >= vec3<f32>(-1.5)) && all(sampleNormal < vec3<f32>(1.5)))) { sampleNormal = vec3<f32>(0.0, 0.0, 1.0); }
  if (!(all(sampleAlbedo >= vec3<f32>(0.0)) && all(sampleAlbedo < vec3<f32>(1e30)))) { sampleAlbedo = vec3<f32>(1.0); }
  let sampleLuminance = luminance(sampleRadiance);
  let pixel = coordinates.y * u32(params.sizeBouncesLights.x) + coordinates.x;
  let pixelCount = u32(params.sizeBouncesLights.x * params.sizeBouncesLights.y);
  accumulation[pixel] += vec4<f32>(sampleRadiance, sampleDepth);
  accumulation[pixelCount + pixel] += vec4<f32>(sampleAlbedo, 0.0);
  accumulation[2u * pixelCount + pixel] += vec4<f32>(sampleNormal, 0.0);
  accumulation[3u * pixelCount + pixel] += vec4<f32>(sampleLuminance, sampleLuminance * sampleLuminance, radianceData.w, 0.0);
}
`;
