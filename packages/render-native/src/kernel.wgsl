enable wgpu_ray_query;

const PI: f32 = 3.14159265358979;
const TWO_PI: f32 = 6.28318530717959;
const TRIANGLE_TEXELS: i32 = 9;
const MATERIAL_TEXELS: i32 = 10;
const LIGHT_TEXELS: i32 = 6;
const RUSSIAN_ROULETTE_START: i32 = 3;
const MINIMUM_ALPHA: f32 = 1e-3;
const MIRROR_ALPHA: f32 = 2e-3;
const DIELECTRIC_COAT_REFLECTANCE: f32 = 0.04;
const ADAPTIVE_MINIMUM_SAMPLES: u32 = 16u;
const ADAPTIVE_BATCH_SAMPLES: u32 = 8u;
const CONVERGENCE_LUMINANCE_FLOOR: f32 = 0.05;
// The host sets these two before it compiles the kernel, so a scene without fog or subsurface scattering carries neither.
const HAS_VOLUME: bool = false;
const HAS_SUBSURFACE: bool = false;

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
  // Fog box minimum and density, box maximum and anisotropy, albedo and the longest distance.
  volumeMinimumDensity: vec4<f32>,
  volumeMaximumAnisotropy: vec4<f32>,
  volumeAlbedoDistance: vec4<f32>,
  // x is the vector index where the subsurface table starts in the materials buffer.
  extras: vec4<u32>,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var sceneStructure: acceleration_structure;
@group(0) @binding(2) var<storage, read> triangles: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> materials: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> lights: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read> atlas: array<u32>;
@group(0) @binding(6) var<storage, read> environmentColors: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read> environmentTables: array<f32>;
// Four planes of pixelCount vec4 each: radiance and depth, albedo, normal, then the luminance sum, its square sum, the first-ray escape count and the samples drawn.
@group(0) @binding(8) var<storage, read_write> accumulation: array<vec4<f32>>;
@group(0) @binding(9) var<storage, read> primitiveSlots: array<u32>;

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

// The hardware ray query replaces the software BVH walk. The acceleration structure holds the triangles of the packed table as
// up to two geometries: the opaque triangles (committed by the hardware as they are found) and, after them, the alpha cutout
// triangles, which arrive as candidates. A candidate is confirmed only when the alpha of its colour map reaches the material's
// cutoff, so the hardware itself finds the nearest solid hit and no ray ever steps through a stack of leaves. `primitiveSlots`
// maps a hardware primitive back to its slot in the packed table (the opaque ones first, then the cutouts, which start at
// params.seedAndAtlas.w), and the barycentrics are the weights of the second and third corner, as nearestU and nearestV were.
const RAY_FLAG_TERMINATE_ON_FIRST_HIT: u32 = 4u;

fn primitiveSlot(geometryIndex: u32, primitiveIndex: u32) -> i32 {
  let cutoutStart = params.seedAndAtlas.w;
  return i32(primitiveSlots[primitiveIndex + select(0u, cutoutStart, geometryIndex > 0u)]);
}

// The alpha of the colour map of the triangle in `slot` at barycentric weights (secondWeight, thirdWeight), without touching
// the hit globals.
fn alphaAtSlot(slot: i32, secondWeight: f32, thirdWeight: f32) -> f32 {
  let base = slot * TRIANGLE_TEXELS;
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

fn traceRay(origin: vec3<f32>, direction: vec3<f32>, limit: f32, anyHit: bool) {
  nearestDistance = limit;
  nearestSlot = -1;
  var query: ray_query;
  let flags = select(0u, RAY_FLAG_TERMINATE_ON_FIRST_HIT, anyHit);
  rayQueryInitialize(&query, sceneStructure, RayDesc(flags, 0xFFu, 0.0, limit, origin, direction));
  while (rayQueryProceed(&query)) {
    let candidate = rayQueryGetCandidateIntersection(&query);
    let slot = primitiveSlot(candidate.geometry_index, candidate.primitive_index);
    let material = i32(triangles[slot * TRIANGLE_TEXELS].w) * MATERIAL_TEXELS;
    let cutoff = materials[material + 3].z;
    if (alphaAtSlot(slot, candidate.barycentrics.x, candidate.barycentrics.y) >= cutoff) {
      rayQueryConfirmIntersection(&query);
    }
  }
  let hit = rayQueryGetCommittedIntersection(&query);
  if (hit.kind == RAY_QUERY_INTERSECTION_NONE) { return; }
  nearestDistance = hit.t;
  nearestSlot = primitiveSlot(hit.geometry_index, hit.primitive_index);
  nearestU = hit.barycentrics.x;
  nearestV = hit.barycentrics.y;
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

// The nearest solid hit; transparent texels of cutout materials never reach here (see `traceRay`).
fn intersectScene(origin: vec3<f32>, direction: vec3<f32>) -> bool {
  traceRay(origin, direction, params.environmentRotationAndRays.w, false);
  if (nearestSlot < 0) { return false; }
  fillHit(origin, direction, nearestDistance);
  return true;
}

fn occluded(origin: vec3<f32>, direction: vec3<f32>, limit: f32) -> bool {
  traceRay(origin, direction, limit, true);
  return nearestSlot >= 0;
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
var<private> surfaceMultipleScattering: vec3<f32>;
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

// The directional albedo of the specular lobe is normalReflectance * x + y.
fn specularAlbedoTerms(roughness: f32, viewCosine: f32) -> vec2<f32> {
  let smoothness = 1.0 - roughness;
  let slope = min(smoothness * smoothness, exp2(-9.28 * viewCosine)) * smoothness + (0.0425 - 0.0275 * roughness);
  let scale = 1.04 - 0.572 * roughness - 1.04 * slope;
  let offset = 1.04 * slope + 0.022 * roughness - 0.04;
  return vec2<f32>(scale, offset);
}

fn dielectricSpecularAlbedo(normalReflectance: f32, roughness: f32, viewCosine: f32) -> f32 {
  let terms = specularAlbedoTerms(roughness, viewCosine);
  return clamp(normalReflectance * terms.x + terms.y, 0.0, 1.0);
}

// The share of the light a rough conductor lit by a white sky keeps with single scattering GGX and this kernel's Smith masking, by roughness
// (rows, 0 to 1 in eighths) and square root of the view cosine (columns, 0 to 1 in eighths). Integrated numerically over the hemisphere.
var<private> specularWhiteAlbedo: array<f32, 81> = array<f32, 81>(
  1.0000, 1.0000, 1.0000, 1.0000, 1.0000, 1.0000, 1.0000, 1.0000, 1.0000,
  0.7065, 0.6828, 0.9606, 0.9926, 0.9977, 0.9990, 0.9995, 0.9997, 0.9998,
  0.9306, 0.9098, 0.8781, 0.9169, 0.9613, 0.9820, 0.9904, 0.9940, 0.9957,
  0.9224, 0.9118, 0.8819, 0.8643, 0.8847, 0.9209, 0.9492, 0.9662, 0.9756,
  0.8981, 0.8909, 0.8690, 0.8420, 0.8285, 0.8389, 0.8649, 0.8931, 0.9158,
  0.8543, 0.8478, 0.8281, 0.8004, 0.7733, 0.7574, 0.7581, 0.7730, 0.7956,
  0.7896, 0.7826, 0.7616, 0.7310, 0.6964, 0.6643, 0.6404, 0.6278, 0.6269,
  0.7070, 0.6990, 0.6752, 0.6400, 0.5985, 0.5557, 0.5154, 0.4803, 0.4521,
  0.6131, 0.6043, 0.5776, 0.5380, 0.4910, 0.4413, 0.3928, 0.3476, 0.3069,
);

fn lookupSpecularWhiteAlbedo(roughness: f32, viewCosine: f32) -> f32 {
  let rowPosition = clamp(roughness, 0.0, 1.0) * 8.0;
  let columnPosition = sqrt(clamp(viewCosine, 0.0, 1.0)) * 8.0;
  let row = min(u32(rowPosition), 7u);
  let column = min(u32(columnPosition), 7u);
  let rowBlend = rowPosition - f32(row);
  let columnBlend = columnPosition - f32(column);
  let first = mix(specularWhiteAlbedo[row * 9u + column], specularWhiteAlbedo[row * 9u + column + 1u], columnBlend);
  let second = mix(specularWhiteAlbedo[(row + 1u) * 9u + column], specularWhiteAlbedo[(row + 1u) * 9u + column + 1u], columnBlend);
  return mix(first, second, rowBlend);
}

// Single scattering GGX loses the light that bounces between microfacets, a tenth of a rough metal and more at the grazing angles. This is the
// factor that gives it back, from the albedo of the lobe with a white Fresnel term and the average Fresnel over the hemisphere (Fdez-Aguera 2019).
fn multipleScatteringFactor(normalReflectance: vec3<f32>, roughness: f32, viewCosine: f32) -> vec3<f32> {
  let missing = 1.0 - lookupSpecularWhiteAlbedo(roughness, viewCosine);
  let averageFresnel = normalReflectance + (vec3<f32>(1.0) - normalReflectance) / 21.0;
  return vec3<f32>(1.0) + averageFresnel * missing / (vec3<f32>(1.0) - missing * averageFresnel);
}

// Cycles' glossy filter (filter_glossy 1): after a bounce that spread the light, glossy lobes are widened so that a diffuse-glossy-light path
// does not become a rare, very bright caustic. The smallest sampling density met on the path sets the widest this lobe gets to be.
var<private> pathMinimumPdf: f32 = 1e30;

fn glossyBlurAlpha() -> f32 {
  if (pathMinimumPdf >= 1.0) { return 0.0; }
  return 0.5 * sqrt(1.0 - pathMinimumPdf);
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
  let blurAlpha = glossyBlurAlpha();
  surfaceSpecularAlpha = max(roughnessToAlpha(hitRoughness), blurAlpha);
  surfaceCoatAlpha = max(roughnessToAlpha(hitClearcoatRoughness), blurAlpha);
  surfaceMultipleScattering = multipleScatteringFactor(surfaceSpecularNormal, hitRoughness, viewCosine);
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
    surfaceValue += schlickColor(surfaceSpecularNormal, viewHalfCosine) * surfaceMultipleScattering * term;
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
  if (HAS_VOLUME && inMedium) {
    let phase = henyeyGreensteinPhase(params.volumeMaximumAnisotropy.w, dot(lightDirection, direction));
    let scale = phase * fogTransmittance(hitPoint, distance) * directWeight(weightMode, phase);
    shadowOrigin = hitPoint;
    shadowAmount = throughput * lightRadiance * scale;
    shadowDepth = depth + 1;
  } else {
    let cosine = dot(normal, lightDirection);
    if (cosine <= 0.0) { return; }
    evaluateSurface(lightDirection);
    let value = surfaceValue;
    if (value.x + value.y + value.z <= 0.0) { return; }
    shadowOrigin = hitPoint + normal * params.environmentRotationAndRays.z;
    var transmittance = 1.0;
    if (HAS_VOLUME) { transmittance = fogTransmittance(shadowOrigin, distance); }
    let scale = cosine * directWeight(weightMode, surfacePdf) * transmittance;
    shadowAmount = throughput * value * lightRadiance * scale;
    shadowDepth = depth;
  }
  shadowDirection = lightDirection;
  shadowLimit = distance;
  shadowPending = true;
}


var<private> volumeSpan: vec2<f32>;

fn clipAxis(origin: f32, axisDirection: f32, minimum: f32, maximum: f32, span: ptr<function, vec2<f32>>) -> bool {
  if (axisDirection == 0.0) { return origin >= minimum && origin <= maximum; }
  let first = (minimum - origin) / axisDirection;
  let second = (maximum - origin) / axisDirection;
  (*span).x = max((*span).x, min(first, second));
  (*span).y = min((*span).y, max(first, second));
  return true;
}

fn volumeInterval(origin: vec3<f32>, rayDirection: vec3<f32>, limit: f32) -> bool {
  var span = vec2<f32>(0.0, min(limit, params.volumeAlbedoDistance.w));
  let minimum = params.volumeMinimumDensity.xyz;
  let maximum = params.volumeMaximumAnisotropy.xyz;
  if (!clipAxis(origin.x, rayDirection.x, minimum.x, maximum.x, &span)) { return false; }
  if (!clipAxis(origin.y, rayDirection.y, minimum.y, maximum.y, &span)) { return false; }
  if (!clipAxis(origin.z, rayDirection.z, minimum.z, maximum.z, &span)) { return false; }
  if (!(span.x < span.y)) { return false; }
  volumeSpan = span;
  return true;
}

fn henyeyGreensteinPhase(anisotropy: f32, cosine: f32) -> f32 {
  let squared = anisotropy * anisotropy;
  return (1.0 - squared) / (4.0 * PI * pow(1.0 + squared - 2.0 * anisotropy * cosine, 1.5));
}

fn sampleHenyeyGreensteinCosine(anisotropy: f32, unit: f32) -> f32 {
  if (abs(anisotropy) < 1e-3) { return 1.0 - 2.0 * unit; }
  let squared = anisotropy * anisotropy;
  let ratio = (1.0 - squared) / (1.0 - anisotropy + 2.0 * anisotropy * unit);
  return clamp((1.0 + squared - ratio * ratio) / (2.0 * anisotropy), -1.0, 1.0);
}

fn fogTransmittance(origin: vec3<f32>, distance: f32) -> f32 {
  if (!volumeInterval(origin, lightDirection, distance)) { return 1.0; }
  return exp(-params.volumeMinimumDensity.w * (volumeSpan.y - volumeSpan.x));
}

// Draws the next scattering event along the segment; when there is one it becomes hitPoint.
fn scatterInFog(origin: vec3<f32>, segmentLength: f32) -> bool {
  if (!volumeInterval(origin, direction, segmentLength)) { return false; }
  let eventDistance = volumeSpan.x - log(1.0 - nextRandom()) / params.volumeMinimumDensity.w;
  if (eventDistance >= volumeSpan.y) { return false; }
  hitPoint = origin + direction * eventDistance;
  return true;
}
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


const WALK_STEPS: i32 = 32;
const WALK_EXIT: i32 = 0;
const WALK_THIN: i32 = 1;
const WALK_LOST: i32 = 2;
const SUBSURFACE_TEXELS: i32 = 2;

var<private> subsurfaceWeight: f32 = 0.0;
var<private> surfaceSubsurfaceChance: f32 = 0.0;
var<private> walkWeight: vec3<f32>;
var<private> walkDirection: vec3<f32>;
var<private> subsurfaceNormal: vec3<f32>;

fn subsurfaceVector(material: i32, offset: i32) -> vec4<f32> {
  return materials[i32(params.extras.x) + material * SUBSURFACE_TEXELS + offset];
}

// Moves the subsurface share of the diffuse lobe to the walk; returns the material's weight.
fn splitSubsurface() -> f32 {
  let weight = subsurfaceVector(hitMaterialIndex, 0).x;
  surfaceSubsurfaceChance = surfaceDiffuseChance * weight;
  surfaceDiffuseChance -= surfaceSubsurfaceChance;
  surfaceDiffuse *= 1.0 - weight;
  return weight;
}

fn singleScatterAlbedo(multipleScatterAlbedo: f32) -> f32 {
  let albedo = clamp(multipleScatterAlbedo, 0.0, 1.0);
  let root = sqrt(9.59217 + 41.6808 * albedo + 17.7126 * albedo * albedo);
  let offset = 4.09712 + 4.20863 * albedo - root;
  return clamp(1.0 - offset * offset, 0.0, 1.0);
}

// Walks inward from the entry point until the walk meets the part's own surface; leaves its throughput in walkWeight.
fn randomWalk(point: vec3<f32>, normal: vec3<f32>, meanFreePath: vec3<f32>, color: vec3<f32>, material: i32) -> i32 {
  let extinction = 1.0 / meanFreePath;
  let albedo = vec3<f32>(singleScatterAlbedo(color.r), singleScatterAlbedo(color.g), singleScatterAlbedo(color.b));
  var position = point - normal * params.environmentRotationAndRays.z;
  let frame = buildFrame(normal);
  let radius = sqrt(nextRandom());
  let angle = TWO_PI * nextRandom();
  let height = sqrt(max(0.0, 1.0 - radius * radius));
  walkDirection = frame[0] * (radius * cos(angle)) + frame[1] * (radius * sin(angle)) - normal * height;
  for (var scatters = 0; scatters <= WALK_STEPS; scatters++) {
    let found = intersectScene(position, walkDirection);
    if (!found || hitMaterialIndex != material) { return select(WALK_LOST, WALK_THIN, scatters == 0); }
    // One channel draws the distance; weighting by the mean density over the three channels keeps every channel unbiased.
    let hero = min(2, i32(floor(nextRandom() * 3.0)));
    let distance = -log(1.0 - nextRandom()) / extinction[hero];
    if (distance >= hitDistance) {
      let attenuation = exp(-extinction * hitDistance);
      let survival = (attenuation.x + attenuation.y + attenuation.z) / 3.0;
      if (!(survival > 0.0)) { return WALK_LOST; }
      walkWeight *= attenuation / survival;
      return WALK_EXIT;
    }
    if (scatters == WALK_STEPS) { return WALK_LOST; }
    let falloff = exp(-extinction * distance);
    let scatterDensity = extinction * falloff;
    let density = (scatterDensity.x + scatterDensity.y + scatterDensity.z) / 3.0;
    if (!(density > 0.0)) { return WALK_LOST; }
    walkWeight *= albedo * scatterDensity / density;
    position += walkDirection * distance;
    let up = 2.0 * nextRandom() - 1.0;
    let azimuth = TWO_PI * nextRandom();
    let ring = sqrt(max(0.0, 1.0 - up * up));
    walkDirection = vec3<f32>(ring * cos(azimuth), up, ring * sin(azimuth));
  }
  return WALK_LOST;
}

// Sends the diffuse light of the hit through its walk. On success the path stands where the walk left, subsurfaceNormal
// faces out of that point, the surface is white diffuse there with its lights added, and the throughput carries the walk.
// False when the walk ended inside the part.
fn enterSubsurface(depth: i32, entryNormal: vec3<f32>) -> bool {
  let block = subsurfaceVector(hitMaterialIndex, 0);
  let colorBlock = subsurfaceVector(hitMaterialIndex, 1);
  let color = select(colorBlock.rgb, hitColor, colorBlock.x < 0.0);
  let material = hitMaterialIndex;
  let entryPoint = hitPoint;
  let entryMask = hitMask;
  let entryScale = surfaceDiffuseShare * block.x / surfaceSubsurfaceChance;
  walkWeight = vec3<f32>(1.0);
  subsurfaceNormal = entryNormal;
  let outcome = randomWalk(entryPoint, entryNormal, block.yzw, color, material);
  if (outcome == WALK_LOST) { return false; }
  if (outcome == WALK_EXIT) {
    subsurfaceNormal = hitNormal * select(1.0, -1.0, dot(hitNormal, walkDirection) < 0.0);
    throughput *= walkWeight * entryScale;
  } else {
    // A card: half of the colour is reflected on the side the ray came from and half is transmitted diffusely through it.
    hitPoint = entryPoint;
    hitMask = entryMask;
    if (nextRandom() < 0.5) { subsurfaceNormal = -entryNormal; }
    throughput *= color * entryScale;
  }
  surfaceFrame = buildFrame(subsurfaceNormal);
  surfaceDiffuse = vec3<f32>(1.0);
  surfaceDiffuseChance = 1.0;
  surfaceSubsurfaceChance = 0.0;
  surfaceSpecularChance = 0.0;
  surfaceCoatChance = 0.0;
  surfaceCoatWeight = 0.0;
  addLights(depth, subsurfaceNormal);
  return true;
}
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
  pathMinimumPdf = 1e30;
  var afterMirror = true;
  var normal = vec3<f32>(0.0, 1.0, 0.0);
  let bounces = params.sizeBouncesLights.z;
  let surfaceOffset = params.environmentRotationAndRays.z;
  for (var depth = 0; depth <= bounces; depth++) {
    let found = intersectScene(position, direction);
    var inFog = false;
    if (HAS_VOLUME) { inFog = scatterInFog(position, select(params.environmentRotationAndRays.w, hitDistance, found)); }
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
        if (HAS_SUBSURFACE) { subsurfaceWeight = splitSubsurface(); }
      }
    }
    if (needsLights) { addLights(depth, normal); }
    inMedium = false;
    if (inFog) {
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
    }
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
      if (HAS_SUBSURFACE && subsurfaceWeight > 0.0) {
        if (lobeUnit < surfaceSubsurfaceChance) {
          if (!enterSubsurface(depth, normal)) { break; }
          normal = subsurfaceNormal;
          lobeUnit = 0.0;
        } else {
          lobeUnit -= surfaceSubsurfaceChance;
        }
      }
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
        pathMinimumPdf = min(pathMinimumPdf, surfacePdf);
        afterMirror = false;
      }
    }
    position = hitPoint + direction * surfaceOffset;
    if (!survivesRoulette(depth)) { break; }
  }
}

// The same stop rule as the CPU tracer: after 16 samples, and then every 8, a pixel whose standard error of the mean luminance is
// under the threshold times the mean plus a small floor draws no more samples. It reads only the pixel's own sums.
fn pixelHasConverged(statistics: vec4<f32>, threshold: f32) -> bool {
  let taken = u32(statistics.w);
  if (taken < ADAPTIVE_MINIMUM_SAMPLES || (taken - ADAPTIVE_MINIMUM_SAMPLES) % ADAPTIVE_BATCH_SAMPLES != 0u) { return false; }
  let count = f32(taken);
  let mean = statistics.x / count;
  let sampleVariance = max(0.0, statistics.y / count - mean * mean) * count / (count - 1.0);
  return sqrt(sampleVariance / count) < threshold * (mean + CONVERGENCE_LUMINANCE_FLOOR);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let width = params.sizeBouncesLights.x;
  let height = params.sizeBouncesLights.y;
  if (i32(id.x) >= width || i32(id.y) >= height) { return; }
  let pixel = id.y * u32(width) + id.x;
  let pixelCount = u32(width * height);
  let noiseThreshold = params.cameraAndClamp.w;
  if (noiseThreshold > 0.0 && pixelHasConverged(accumulation[3u * pixelCount + pixel], noiseThreshold)) { return; }
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
  accumulation[pixel] += vec4<f32>(radiance, featureDepth);
  accumulation[pixelCount + pixel] += vec4<f32>(featureAlbedo, 0.0);
  accumulation[2u * pixelCount + pixel] += vec4<f32>(featureNormal, 0.0);
  accumulation[3u * pixelCount + pixel] += vec4<f32>(sampleLuminance, sampleLuminance * sampleLuminance, firstLegEscaped, 1.0);
}
