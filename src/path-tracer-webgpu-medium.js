import { SUBSURFACE_TEXELS } from './path-tracer-gpu-subsurface.js';
import { SUBSURFACE_WALK_STEPS } from './path-tracer-subsurface.js';

// The two optional parts of the WGSL path tracer (issue #625): homogeneous volume fog and the subsurface random walk.
// They are the WGSL form of the GLSL pieces in path-tracer-gpu-shader.js (fog) and path-tracer-gpu-subsurface.js, with the
// same random numbers drawn in the same order, and the kernel splices them in only for a scene that uses them.
// The fog box and medium sit in the last three vectors of the parameter block: minimum and density, maximum and anisotropy,
// albedo and the longest distance. The subsurface table (two vectors per material) follows the material table in the
// materials buffer; params.seedAndAtlas.z is the vector index where it starts.

/** The fog functions that the shared part of the kernel calls from addDirect. */
export const VOLUME_FUNCTIONS = /* wgsl */ `
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
`;

/** The subsurface random walk; it runs right after addLights is defined, so it can light the point where the walk leaves. */
export const SUBSURFACE_FUNCTIONS = /* wgsl */ `
const WALK_STEPS: i32 = ${SUBSURFACE_WALK_STEPS};
const WALK_EXIT: i32 = 0;
const WALK_THIN: i32 = 1;
const WALK_LOST: i32 = 2;
const SUBSURFACE_TEXELS: i32 = ${SUBSURFACE_TEXELS};

var<private> subsurfaceWeight: f32 = 0.0;
var<private> surfaceSubsurfaceChance: f32 = 0.0;
var<private> walkWeight: vec3<f32>;
var<private> walkDirection: vec3<f32>;
var<private> subsurfaceNormal: vec3<f32>;

fn subsurfaceVector(material: i32, offset: i32) -> vec4<f32> {
  return materials[i32(params.seedAndAtlas.z) + material * SUBSURFACE_TEXELS + offset];
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
    let found = intersectScene(position, walkDirection, false);
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
`;
