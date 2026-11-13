import { cameraFieldOfView, resolveThinLens } from './camera.js';
import { fresnelSchlick } from './material-layers.js';
import { pointLightFalloff } from './ray-query.js';
import { profileGain } from './light-profile.js';
import { buildTraceScene, refuseLocalVolumes, SUN_ANGULAR_RADIUS } from './path-tracer-scene.js';
import { denoiseRadiance } from './path-tracer-denoise.js';
import { acesChannel, displayColor } from './view-transform.js';
import { VIEW_TRANSFORM_NAMES } from './view-transform-names.js';
import {
  buildFrame, createSurface, environmentPdf, environmentRadiance, evaluateSurface, luminance, mirrorWeight, prepareSurface,
  roughnessToAlpha, sampleEnvironment, sampleGlass, sampleSurface, setWhiteDiffuse, splitSubsurface,
} from './path-tracer-shading.js';
import { buildLightTree, chooseLightFromTree, LIGHT_TREE_FIRST_HIT_LIGHTS, resolveLightSelection } from './path-tracer-light-tree.js';
import { createRandomWalk, WALK_OUTCOME } from './path-tracer-subsurface.js';
import { henyeyGreensteinPhase, sampleHenyeyGreensteinCosine, volumeInterval, createLocalVolumeCrossing, meanEnvironmentRadiance } from './path-tracer-volume.js';

// Offline still renderer: unidirectional path tracing on the CPU with next-event estimation for every light, the
// environment map drawn by importance, and a wavelet denoiser. It reads the same parts, materials, lights and camera
// as the rasterizer. Same input gives the same bytes: random numbers come from a hash of pixel, sample and seed, and
// the clock only decides whether a render is allowed to finish.

export const PATH_TRACER_LIMITS = Object.freeze({
  width: Object.freeze({ minimum: 16, maximum: 4096, fallback: 960 }),
  height: Object.freeze({ minimum: 16, maximum: 4096, fallback: 540 }),
  samples: Object.freeze({ minimum: 1, maximum: 1024, fallback: 64 }),
  bounces: Object.freeze({ minimum: 1, maximum: 16, fallback: 8 }),
  maxSeconds: Object.freeze({ minimum: 1, maximum: 1800, fallback: 300 }),
  fireflyClamp: Object.freeze({ minimum: 1, maximum: 1000, fallback: 20 }),
  noiseThreshold: Object.freeze({ minimum: 0, maximum: 1, fallback: 0 }),
  seed: Object.freeze({ minimum: 0, maximum: 2 ** 31 - 1, fallback: 0 }),
  threads: Object.freeze({ minimum: 1, maximum: 8, fallback: 4 }),
});
export const MAX_TRACE_PIXELS = 2_073_600;
export const MAX_TRACE_RAY_WORK = 4_000_000_000;
const ALPHA_STEP_LIMIT = 64;
const WORKER_BAND_ROWS = 8;
// Held in a constant so the bundler leaves the URL alone: the worker is its own package entry, built beside this file.
const WORKER_FILE = './path-tracer-worker.js';
const RUSSIAN_ROULETTE_START = 3;
// A pixel is checked for convergence from this many samples on, then after every batch of samples.
const ADAPTIVE_MINIMUM_SAMPLES = 16;
const ADAPTIVE_BATCH_SAMPLES = 8;
// Mean luminance added to the standard error's reference, so very dark pixels are not held to a relative error.
const CONVERGENCE_LUMINANCE_FLOOR = 0.05;
const IGNORED_MAP_FIELDS = ['occlusionMap'];
// Shading layers of the rasterizer that the tracer's surface model has no term for.
const IGNORED_LAYERS = [
  ['anisotropy', material => material.anisotropy > 0, true],
  ['iridescence', material => material.iridescence > 0, true],
  ['sheen', material => (material.sheenColor ?? []).some(channel => channel !== 0), true],
  ['moss', material => material.moss > 0],
  ['splat layers', (material, kernelMaterials) => Boolean(material.layers || Object.keys(material.layerMaps ?? {}).some(name => !(kernelMaterials ? KERNEL_LAYER_MAPS : ['clearcoatTexture']).includes(name)))],
  ['lightMap', material => Boolean(material.lightMap)],
];
// The layer maps the native "cycles" kernel reads with its whole materials (the roughness maps of the coat and the sheen have no slot).
const KERNEL_LAYER_MAPS = ['clearcoatTexture', 'clearcoatNormalTexture', 'anisotropyTexture', 'sheenColorTexture'];

// The native kernel reads a coat's weight and roughness, and a sheen's tint and roughness, from one map each
// (packages/render-native/job-input.mjs carries the map only when it cannot change the roughness).
function hasSplitLayerMap(material) {
  const maps = material.layerMaps ?? {};
  const coatIsSplit = Boolean(maps.clearcoatTexture) && material.clearcoatRoughness > 0 && maps.clearcoatTexture.image !== maps.clearcoatRoughnessTexture?.image;
  const sheenIsSplit = Boolean(maps.sheenColorTexture) && material.sheenRoughness > 0 && maps.sheenColorTexture.image !== maps.sheenRoughnessTexture?.image;
  return coatIsSplit || sheenIsSplit;
}

function hasGraphOpacity(material) {
  return material.pattern?.type === 'graph' && Object.hasOwn(material.pattern.graph ?? {}, 'opacity');
}

function boundedInteger(options, name) {
  const limit = PATH_TRACER_LIMITS[name];
  const value = options[name] ?? limit.fallback;
  if (!Number.isInteger(value) || value < limit.minimum || value > limit.maximum) {
    throw new RangeError(`Path tracer ${name} must be an integer from ${limit.minimum} to ${limit.maximum}.`);
  }
  return value;
}

function boundedNumber(options, name) {
  const limit = PATH_TRACER_LIMITS[name];
  const value = options[name] ?? limit.fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < limit.minimum || value > limit.maximum) {
    throw new RangeError(`Path tracer ${name} must be a number from ${limit.minimum} to ${limit.maximum}.`);
  }
  return value;
}

// Kept equal to PATH_TRACER_DENOISERS in path-tracer-capabilities.js by tests/path-tracer-denoise-oidn.test.js; the
// capabilities file stays out of this bundle.
export const PATH_TRACER_DENOISERS = Object.freeze(['wavelet', 'oidn', 'none']);
export const SAMPLING_PATTERNS = Object.freeze(['random', 'blue-noise-first']);
export const LIGHT_SELECTIONS = Object.freeze(['auto', 'uniform', 'importance', 'tree']);

/**
 * `denoise` is true (the wavelet filter) or false (none), or a name: "wavelet", "oidn" or "none". "oidn" is the optional
 * native Open Image Denoise (packages/denoise-oidn): the tracer then leaves the colour as traced and returns the feature
 * images, and the caller that has the package filters them.
 */
function denoiserNamed(value) {
  if (value === true) return 'wavelet';
  if (value === false) return 'none';
  if (PATH_TRACER_DENOISERS.includes(value)) return value;
  throw new TypeError(`Path tracer denoise must be a boolean or one of ${PATH_TRACER_DENOISERS.join(', ')}.`);
}

// "webgpu" is the WGSL compute tracer (src/path-tracer-webgpu.js, loaded only for that backend).
const PATH_TRACER_BACKENDS = ['cpu', 'gpu', 'webgpu'];

export function normalizePathTracerOptions(options = {}) {
  if (options === null || typeof options !== 'object') throw new TypeError('Path tracer options must be an object.');
  const result = {
    width: boundedInteger(options, 'width'),
    height: boundedInteger(options, 'height'),
    samples: boundedInteger(options, 'samples'),
    bounces: boundedInteger(options, 'bounces'),
    seed: boundedInteger(options, 'seed'),
    threads: boundedInteger(options, 'threads'),
    maxSeconds: boundedNumber(options, 'maxSeconds'),
    fireflyClamp: boundedNumber(options, 'fireflyClamp'),
    noiseThreshold: boundedNumber(options, 'noiseThreshold'),
    denoiser: denoiserNamed(options.denoise ?? true),
    viewTransform: options.viewTransform ?? 'aces',
    look: options.look ?? null,
    backend: options.backend ?? 'cpu',
    samplingPattern: options.samplingPattern ?? 'random',
    lightSelection: options.lightSelection ?? 'auto',
  };
  result.denoise = result.denoiser !== 'none';
  if (!VIEW_TRANSFORM_NAMES.includes(result.viewTransform)) throw new RangeError(`Path tracer viewTransform must be one of ${VIEW_TRANSFORM_NAMES.join(', ')}.`);
  if (!PATH_TRACER_BACKENDS.includes(result.backend)) throw new TypeError('Path tracer backend must be "cpu", "gpu" or "webgpu".');
  if (!SAMPLING_PATTERNS.includes(result.samplingPattern)) throw new RangeError(`Path tracer samplingPattern must be one of ${SAMPLING_PATTERNS.join(', ')}.`);
  if (!LIGHT_SELECTIONS.includes(result.lightSelection)) throw new RangeError(`Path tracer lightSelection must be one of ${LIGHT_SELECTIONS.join(', ')}.`);
  if (result.backend !== 'gpu' && result.samplingPattern !== 'random') {
    throw new RangeError('Path tracer samplingPattern "blue-noise-first" needs backend "gpu"; the CPU reference and the WebGPU tracer draw random samples.');
  }
  if (result.lightSelection === 'importance' && result.backend !== 'gpu') {
    throw new RangeError('Path tracer lightSelection "importance" needs backend "gpu"; the CPU reference and the WebGPU tracer pick lights uniformly; "tree" also runs on the WebGPU tracer.');
  }
  if (result.width * result.height > MAX_TRACE_PIXELS) throw new RangeError(`A path trace takes at most ${MAX_TRACE_PIXELS} pixels.`);
  if (result.width * result.height * result.samples * (result.bounces + 1) > MAX_TRACE_RAY_WORK) throw new RangeError('This path trace would need too much ray work: lower the size, samples or bounces.');
  return result;
}

function finiteVector(value, name) {
  if (!Array.isArray(value) || value.length !== 3 || value.some(entry => typeof entry !== 'number' || !Number.isFinite(entry))) {
    throw new TypeError(`Path tracer camera ${name} must be three finite numbers.`);
  }
  return value;
}

export function createCamera(camera, width, height) {
  const eye = finiteVector(camera.eye, 'eye');
  const target = finiteVector(camera.target, 'target');
  const up = finiteVector(camera.up ?? [0, 1, 0], 'up');
  if (camera.projection === 'orthographic' || camera.shift) throw new RangeError('The path tracer draws perspective cameras without lens shift. Render those without the renderer option.');
  const fov = camera.focalLength === undefined ? camera.fov : cameraFieldOfView(camera, width / height);
  if (typeof fov !== 'number' || !(fov > 1 && fov < 170)) throw new RangeError('Path tracer camera fov must be between 1 and 170 degrees.');
  const forward = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
  const forwardLength = Math.hypot(...forward);
  if (forwardLength === 0) throw new RangeError('Path tracer camera eye and target must differ.');
  for (let axis = 0; axis < 3; axis++) forward[axis] /= forwardLength;
  const right = [forward[1] * up[2] - forward[2] * up[1], forward[2] * up[0] - forward[0] * up[2], forward[0] * up[1] - forward[1] * up[0]];
  const rightLength = Math.hypot(...right);
  if (rightLength === 0) throw new RangeError('Path tracer camera up must not be parallel to its view.');
  for (let axis = 0; axis < 3; axis++) right[axis] /= rightLength;
  const above = [right[1] * forward[2] - right[2] * forward[1], right[2] * forward[0] - right[0] * forward[2], right[0] * forward[1] - right[1] * forward[0]];
  const halfHeight = Math.tan(fov * Math.PI / 360);
  const view = { eye, forward, right, above, halfHeight, halfWidth: halfHeight * width / height };
  // A camera with an fStop adds its thin lens (apertureRadius, focalDistance, apertureBlades, apertureRotation). Only the
  // native "cycles" kernel draws it; every other tracer ignores the extra fields, and a pinhole view is unchanged.
  const thinLens = resolveThinLens(camera, { aspect: width / height, eye, target });
  return thinLens ? { ...view, ...thinLens } : view;
}

// ---- Random numbers ----

function createRandom() {
  let state = 1;
  return {
    reset(pixel, sample, seed) {
      let mixed = Math.imul(pixel + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(sample + 0x7f4a7c15, 0xc2b2ae35) ^ Math.imul(seed + 0x165667b1, 0x27d4eb2f);
      mixed = Math.imul(mixed ^ (mixed >>> 15), 0x2c1b3c6d);
      mixed = Math.imul(mixed ^ (mixed >>> 12), 0x297a2d39);
      mixed ^= mixed >>> 15;
      state = mixed === 0 ? 1 : mixed;
    },
    // PCG (RXS-M-XS): successive values are independent enough for light and lobe choices that share one path.
    next() {
      state = (Math.imul(state, 747796405) + 2891336453) >>> 0;
      const word = Math.imul((state >>> ((state >>> 28) + 4)) ^ state, 277803737);
      return (((word >>> 22) ^ word) >>> 0) / 4294967296;
    },
  };
}

// ---- Hits ----

function createHit() {
  return {
    distance: 0, material: null,
    point: new Float64Array(3), normal: new Float64Array(3), color: new Float64Array(3),
    texel: new Float64Array(4), mapTexel: new Float64Array(4), emission: new Float64Array(3),
    metallic: 0, roughness: 0, clearcoat: 0, transmission: 0,
  };
}

// Edges of the hit triangle and the matching UV differences, set by fillHit for the tangent frame of a normal map.
const TANGENT_EDGES = new Float64Array(6);
const TANGENT_UV_DIFFERENCES = new Float64Array(4);

/**
 * Tilts the interpolated normal by a tangent-space normal map, with the tangent frame of the hit triangle as in the
 * rasterizer: tangent from the UV gradient made perpendicular to the normal, bitangent following the UV handedness.
 */
function applyNormalMap(material, hit, u, v) {
  const edgeOneX = TANGENT_EDGES[0];
  const edgeOneY = TANGENT_EDGES[1];
  const edgeOneZ = TANGENT_EDGES[2];
  const edgeTwoX = TANGENT_EDGES[3];
  const edgeTwoY = TANGENT_EDGES[4];
  const edgeTwoZ = TANGENT_EDGES[5];
  const uOne = TANGENT_UV_DIFFERENCES[0];
  const vOne = TANGENT_UV_DIFFERENCES[1];
  const uTwo = TANGENT_UV_DIFFERENCES[2];
  const vTwo = TANGENT_UV_DIFFERENCES[3];
  const determinant = uOne * vTwo - uTwo * vOne;
  if (Math.abs(determinant) < 1e-12) return;
  const normalX = hit.normal[0];
  const normalY = hit.normal[1];
  const normalZ = hit.normal[2];
  let tangentX = (edgeOneX * vTwo - edgeTwoX * vOne) / determinant;
  let tangentY = (edgeOneY * vTwo - edgeTwoY * vOne) / determinant;
  let tangentZ = (edgeOneZ * vTwo - edgeTwoZ * vOne) / determinant;
  const bitangentX = (edgeTwoX * uOne - edgeOneX * uTwo) / determinant;
  const bitangentY = (edgeTwoY * uOne - edgeOneY * uTwo) / determinant;
  const bitangentZ = (edgeTwoZ * uOne - edgeOneZ * uTwo) / determinant;
  const alongNormal = tangentX * normalX + tangentY * normalY + tangentZ * normalZ;
  tangentX -= normalX * alongNormal;
  tangentY -= normalY * alongNormal;
  tangentZ -= normalZ * alongNormal;
  const tangentLength = Math.hypot(tangentX, tangentY, tangentZ);
  if (tangentLength === 0) return;
  tangentX /= tangentLength;
  tangentY /= tangentLength;
  tangentZ /= tangentLength;
  let crossX = normalY * tangentZ - normalZ * tangentY;
  let crossY = normalZ * tangentX - normalX * tangentZ;
  let crossZ = normalX * tangentY - normalY * tangentX;
  const crossLength = Math.hypot(crossX, crossY, crossZ) || 1;
  const handedness = (crossX * bitangentX + crossY * bitangentY + crossZ * bitangentZ) < 0 ? -1 : 1;
  crossX *= handedness / crossLength;
  crossY *= handedness / crossLength;
  crossZ *= handedness / crossLength;
  const { mapTexel } = hit;
  sampleTexture(material.normalTexture, u, v, mapTexel);
  const sideways = (mapTexel[0] * 2 - 1) * material.normalScale[0];
  const forwards = (mapTexel[1] * 2 - 1) * material.normalScale[1];
  const outwards = mapTexel[2] * 2 - 1;
  const mappedX = tangentX * sideways + crossX * forwards + normalX * outwards;
  const mappedY = tangentY * sideways + crossY * forwards + normalY * outwards;
  const mappedZ = tangentZ * sideways + crossZ * forwards + normalZ * outwards;
  const mappedLength = Math.hypot(mappedX, mappedY, mappedZ);
  if (!(mappedLength > 1e-6)) return;
  hit.normal[0] = mappedX / mappedLength;
  hit.normal[1] = mappedY / mappedLength;
  hit.normal[2] = mappedZ / mappedLength;
}

function sampleTexture(texture, u, v, out) {
  const { width, height, data, colorLookup, repeat } = texture;
  const x = u * width - 0.5;
  const y = v * height - 0.5;
  const left = Math.floor(x);
  const top = Math.floor(y);
  const shareX = x - left;
  const shareY = y - top;
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;
  for (let corner = 0; corner < 4; corner++) {
    let column = left + (corner & 1);
    let row = top + (corner >> 1);
    column = repeat ? ((column % width) + width) % width : Math.max(0, Math.min(width - 1, column));
    row = repeat ? ((row % height) + height) % height : Math.max(0, Math.min(height - 1, row));
    const weight = ((corner & 1) ? shareX : 1 - shareX) * ((corner >> 1) ? shareY : 1 - shareY);
    const base = (row * width + column) * 4;
    for (let channel = 0; channel < 3; channel++) out[channel] += weight * (colorLookup ? colorLookup[data[base + channel]] : data[base + channel] / 255);
    out[3] += weight * data[base + 3] / 255;
  }
}

const CORNER_VERTICES = new Uint32Array(3);
const CORNER_WEIGHTS = new Float64Array(3);

/** Interpolates the surface at a hit: position, facing-corrected normal is left to the caller, colour and alpha. */
function fillHit(scene, triangleId, originX, originY, originZ, directionX, directionY, directionZ, distance, hit) {
  const { positions, normals, uvs, colors, indices } = scene;
  const first = indices[triangleId * 3];
  const second = indices[triangleId * 3 + 1];
  const third = indices[triangleId * 3 + 2];
  hit.distance = distance;
  hit.point[0] = originX + directionX * distance;
  hit.point[1] = originY + directionY * distance;
  hit.point[2] = originZ + directionZ * distance;
  const edgeOneX = positions[second * 3] - positions[first * 3];
  const edgeOneY = positions[second * 3 + 1] - positions[first * 3 + 1];
  const edgeOneZ = positions[second * 3 + 2] - positions[first * 3 + 2];
  const edgeTwoX = positions[third * 3] - positions[first * 3];
  const edgeTwoY = positions[third * 3 + 1] - positions[first * 3 + 1];
  const edgeTwoZ = positions[third * 3 + 2] - positions[first * 3 + 2];
  const offsetX = hit.point[0] - positions[first * 3];
  const offsetY = hit.point[1] - positions[first * 3 + 1];
  const offsetZ = hit.point[2] - positions[first * 3 + 2];
  const oneOne = edgeOneX * edgeOneX + edgeOneY * edgeOneY + edgeOneZ * edgeOneZ;
  const oneTwo = edgeOneX * edgeTwoX + edgeOneY * edgeTwoY + edgeOneZ * edgeTwoZ;
  const twoTwo = edgeTwoX * edgeTwoX + edgeTwoY * edgeTwoY + edgeTwoZ * edgeTwoZ;
  const offsetOne = offsetX * edgeOneX + offsetY * edgeOneY + offsetZ * edgeOneZ;
  const offsetTwo = offsetX * edgeTwoX + offsetY * edgeTwoY + offsetZ * edgeTwoZ;
  const denominator = oneOne * twoTwo - oneTwo * oneTwo || 1;
  const secondWeight = (twoTwo * offsetOne - oneTwo * offsetTwo) / denominator;
  const thirdWeight = (oneOne * offsetTwo - oneTwo * offsetOne) / denominator;
  const firstWeight = 1 - secondWeight - thirdWeight;
  let normalX = 0;
  let normalY = 0;
  let normalZ = 0;
  let red = 0;
  let green = 0;
  let blue = 0;
  let u = 0;
  let v = 0;
  CORNER_VERTICES[0] = first;
  CORNER_VERTICES[1] = second;
  CORNER_VERTICES[2] = third;
  CORNER_WEIGHTS[0] = firstWeight;
  CORNER_WEIGHTS[1] = secondWeight;
  CORNER_WEIGHTS[2] = thirdWeight;
  for (let corner = 0; corner < 3; corner++) {
    const vertex = CORNER_VERTICES[corner];
    const weight = CORNER_WEIGHTS[corner];
    normalX += weight * normals[vertex * 3];
    normalY += weight * normals[vertex * 3 + 1];
    normalZ += weight * normals[vertex * 3 + 2];
    red += weight * colors[vertex * 3];
    green += weight * colors[vertex * 3 + 1];
    blue += weight * colors[vertex * 3 + 2];
    u += weight * uvs[vertex * 2];
    v += weight * uvs[vertex * 2 + 1];
  }
  const length = Math.hypot(normalX, normalY, normalZ) || 1;
  hit.normal[0] = normalX / length;
  hit.normal[1] = normalY / length;
  hit.normal[2] = normalZ / length;
  const material = scene.materials[scene.triangleMaterial[triangleId]];
  hit.material = material;
  let alpha = 1;
  hit.color[0] = material.color[0] * red;
  hit.color[1] = material.color[1] * green;
  hit.color[2] = material.color[2] * blue;
  if (material.texture) {
    sampleTexture(material.texture, u, v, hit.texel);
    hit.color[0] *= hit.texel[0];
    hit.color[1] *= hit.texel[1];
    hit.color[2] *= hit.texel[2];
    alpha = hit.texel[3];
  }
  hit.emission[0] = material.emission[0];
  hit.emission[1] = material.emission[1];
  hit.emission[2] = material.emission[2];
  if (material.emissiveTexture) {
    sampleTexture(material.emissiveTexture, u, v, hit.mapTexel);
    hit.emission[0] *= hit.mapTexel[0];
    hit.emission[1] *= hit.mapTexel[1];
    hit.emission[2] *= hit.mapTexel[2];
  }
  hit.metallic = material.metallic;
  hit.roughness = material.roughness;
  hit.clearcoat = material.clearcoat;
  hit.transmission = material.transmission;
  if (material.clearcoatTexture) {
    sampleTexture(material.clearcoatTexture, u, v, hit.mapTexel);
    hit.clearcoat *= hit.mapTexel[0];
  }
  if (material.transmissionTexture) {
    sampleTexture(material.transmissionTexture, u, v, hit.mapTexel);
    hit.transmission *= hit.mapTexel[0];
  }
  if (material.surfaceTexture) {
    sampleTexture(material.surfaceTexture, u, v, hit.mapTexel);
    hit.roughness *= hit.mapTexel[1];
    hit.metallic *= hit.mapTexel[2];
  }
  if (material.normalTexture) {
    TANGENT_EDGES[0] = edgeOneX;
    TANGENT_EDGES[1] = edgeOneY;
    TANGENT_EDGES[2] = edgeOneZ;
    TANGENT_EDGES[3] = edgeTwoX;
    TANGENT_EDGES[4] = edgeTwoY;
    TANGENT_EDGES[5] = edgeTwoZ;
    TANGENT_UV_DIFFERENCES[0] = uvs[second * 2] - uvs[first * 2];
    TANGENT_UV_DIFFERENCES[1] = uvs[second * 2 + 1] - uvs[first * 2 + 1];
    TANGENT_UV_DIFFERENCES[2] = uvs[third * 2] - uvs[first * 2];
    TANGENT_UV_DIFFERENCES[3] = uvs[third * 2 + 1] - uvs[first * 2 + 1];
    applyNormalMap(material, hit, u, v);
  }
  return alpha;
}

/**
 * The nearest solid hit along a ray, stepping through the transparent texels of cutout materials. A camera ray also
 * steps through a shadow-only part, which stays in the scene for shadow and bounce rays (Blender's camera visibility off).
 */
function intersect(scene, originX, originY, originZ, directionX, directionY, directionZ, hit, isCameraRay = false) {
  let startX = originX;
  let startY = originY;
  let startZ = originZ;
  let travelled = 0;
  for (let attempt = 0; attempt < ALPHA_STEP_LIMIT; attempt++) {
    const found = scene.tracer.trace(startX, startY, startZ, directionX, directionY, directionZ, scene.farDistance, false);
    if (found.nearestTriangle < 0) return false;
    const seenByCamera = !(isCameraRay && scene.shadowOnlyParts?.[scene.triangleMaterial[found.nearestTriangle]] === 1);
    const alpha = seenByCamera ? fillHit(scene, found.nearestTriangle, startX, startY, startZ, directionX, directionY, directionZ, found.nearestDistance, hit) : 0;
    if (seenByCamera && (hit.material.alphaCutoff === 0 || alpha >= hit.material.alphaCutoff)) {
      hit.distance += travelled;
      return true;
    }
    const advance = found.nearestDistance + scene.surfaceOffset;
    travelled += advance;
    startX += directionX * advance;
    startY += directionY * advance;
    startZ += directionZ * advance;
  }
  return false;
}

function occluded(scene, originX, originY, originZ, directionX, directionY, directionZ, limit, hit) {
  let startX = originX;
  let startY = originY;
  let startZ = originZ;
  let remaining = limit;
  // An any-hit trace returns the first hit traversal meets, not the nearest. A solid one shadows the point wherever it lies;
  // a transparent one says nothing about what sits before it, so the walk then retraces for nearest hits and steps through.
  let anyHit = true;
  for (let attempt = 0; attempt < ALPHA_STEP_LIMIT; attempt++) {
    const found = scene.tracer.trace(startX, startY, startZ, directionX, directionY, directionZ, remaining, anyHit);
    if (found.nearestTriangle < 0) return false;
    // Only a cutout material needs its texture read to know whether the ray passes through: skip the interpolation for the rest.
    if (scene.materials[scene.triangleMaterial[found.nearestTriangle]].alphaCutoff === 0) return true;
    const alpha = fillHit(scene, found.nearestTriangle, startX, startY, startZ, directionX, directionY, directionZ, found.nearestDistance, hit);
    if (alpha >= hit.material.alphaCutoff) return true;
    if (anyHit) {
      anyHit = false;
      continue;
    }
    const advance = found.nearestDistance + scene.surfaceOffset;
    remaining -= advance;
    if (remaining <= 0) return false;
    startX += directionX * advance;
    startY += directionY * advance;
    startZ += directionZ * advance;
  }
  return true;
}

// ---- One path ----

function smoothstep(value) {
  return value * value * (3 - 2 * value);
}

function createPathTracer(scene, options) {
  const surface = createSurface();
  const hit = createHit();
  const shadowHit = createHit();
  const throughput = new Float64Array(3);
  const radiance = new Float64Array(3);
  const direction = new Float64Array(3);
  const lightDirection = new Float64Array(3);
  const lightRadiance = new Float64Array(3);
  const sky = new Float64Array(3);
  const sunFrame = new Float64Array(9);
  const mirror = new Float64Array(3);
  const normal = new Float64Array(3);
  const features = { albedo: new Float64Array(3), normal: new Float64Array(3), depth: 0 };
  const random = createRandom();
  // The denoiser's features come from the first surface a camera ray meets, not from fog in front of it.
  let featuresRecorded = false;
  const { lights, environment } = scene;
  if (lights.sun) buildFrame(lights.sun.direction, sunFrame);
  const sunCosineMax = Math.cos(lights.sun?.angularRadius ?? SUN_ANGULAR_RADIUS);

  function addRadiance(depth, red, green, blue) {
    let clampedRed = red;
    let clampedGreen = green;
    let clampedBlue = blue;
    if (depth > 0) {
      const peak = Math.max(red, green, blue);
      if (peak > options.fireflyClamp) {
        const scale = options.fireflyClamp / peak;
        clampedRed *= scale;
        clampedGreen *= scale;
        clampedBlue *= scale;
      }
    }
    radiance[0] += clampedRed;
    radiance[1] += clampedGreen;
    radiance[2] += clampedBlue;
  }

  // True while a light is sampled from a scattering event in the fog instead of from a surface.
  let inMedium = false;
  const phaseCandidate = { pdf: 0 };
  const volumeSpan = new Float64Array(2);
  const mediumFrame = new Float64Array(9);
  const scatteredDirection = new Float64Array(3);

  /** The share of light that survives the fog along a shadow ray of the given length. */
  function fogTransmittance(originX, originY, originZ, distance) {
    const { volume } = scene;
    if (!volume) return 1;
    if (!volumeInterval(volume, originX, originY, originZ, lightDirection[0], lightDirection[1], lightDirection[2], distance, volumeSpan)) return 1;
    return Math.exp(-volume.density * (volumeSpan[1] - volumeSpan[0]));
  }

  /** Light from the sampled direction at a scattering event: phase function, shadow ray, fog on the way to the light. */
  function addMediumDirect(depth, distance, weight) {
    const { volume } = scene;
    const cosine = lightDirection[0] * direction[0] + lightDirection[1] * direction[1] + lightDirection[2] * direction[2];
    const phase = henyeyGreensteinPhase(volume.anisotropy, cosine);
    const [originX, originY, originZ] = hit.point;
    if (occluded(scene, originX, originY, originZ, lightDirection[0], lightDirection[1], lightDirection[2], distance, shadowHit)) return;
    phaseCandidate.pdf = phase;
    const scale = phase * fogTransmittance(originX, originY, originZ, distance) * weight(phaseCandidate);
    addRadiance(
      depth + 1,
      throughput[0] * lightRadiance[0] * scale,
      throughput[1] * lightRadiance[1] * scale,
      throughput[2] * lightRadiance[2] * scale,
    );
  }

  /** Adds the light from one sampled direction: surface value, cosine, shadow ray. `weight` carries MIS and sampling. */
  function addDirect(depth, normal, distance, weight) {
    if (inMedium) {
      addMediumDirect(depth, distance, weight);
      return;
    }
    const cosine = normal[0] * lightDirection[0] + normal[1] * lightDirection[1] + normal[2] * lightDirection[2];
    if (cosine <= 0) return;
    evaluateSurface(surface, lightDirection[0], lightDirection[1], lightDirection[2]);
    const value = surface.value;
    if (value[0] + value[1] + value[2] <= 0) return;
    const originX = hit.point[0] + normal[0] * scene.surfaceOffset;
    const originY = hit.point[1] + normal[1] * scene.surfaceOffset;
    const originZ = hit.point[2] + normal[2] * scene.surfaceOffset;
    if (occluded(scene, originX, originY, originZ, lightDirection[0], lightDirection[1], lightDirection[2], distance, shadowHit)) return;
    const scale = cosine * weight(surface) * fogTransmittance(originX, originY, originZ, distance);
    addRadiance(
      depth,
      throughput[0] * value[0] * lightRadiance[0] * scale,
      throughput[1] * value[1] * lightRadiance[1] * scale,
      throughput[2] * value[2] * lightRadiance[2] * scale,
    );
  }

  // Past the first hit one light is drawn at random instead of all of them, so a scene with many lights costs one shadow
  // ray per bounce. `selectionProbability` is the chance that this light was the one drawn; dividing by it keeps the sum unbiased.
  let selectionProbability = 1;
  const fullWeight = () => 1 / selectionProbability;

  // A light skips a part whose mask has its bit clear, at every bounce, so it is no bounce source there either.
  const reaches = light => inMedium || (hit.material.lightMask >> light.bit & 1) === 1;

  function sampleSun(depth, normal) {
    if (!reaches(lights.sun)) return;
    const cosineTheta = 1 - random.next() * (1 - sunCosineMax);
    const sineTheta = Math.sqrt(Math.max(0, 1 - cosineTheta * cosineTheta));
    const phi = 2 * Math.PI * random.next();
    const across = sineTheta * Math.cos(phi);
    const along = sineTheta * Math.sin(phi);
    for (let axis = 0; axis < 3; axis++) lightDirection[axis] = sunFrame[axis] * across + sunFrame[3 + axis] * along + sunFrame[6 + axis] * cosineTheta;
    for (let channel = 0; channel < 3; channel++) lightRadiance[channel] = lights.sun.color[channel];
    addDirect(depth, normal, scene.farDistance, fullWeight);
  }

  function aimAt(targetX, targetY, targetZ) {
    const deltaX = targetX - hit.point[0];
    const deltaY = targetY - hit.point[1];
    const deltaZ = targetZ - hit.point[2];
    const distanceSquared = deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
    const distance = Math.sqrt(distanceSquared);
    lightDirection[0] = deltaX / distance;
    lightDirection[1] = deltaY / distance;
    lightDirection[2] = deltaZ / distance;
    return { distance, distanceSquared };
  }

  function randomOnSphere(radius, out) {
    const height = 2 * random.next() - 1;
    const angle = 2 * Math.PI * random.next();
    const ring = Math.sqrt(1 - height * height);
    out[0] = radius * ring * Math.cos(angle);
    out[1] = radius * height;
    out[2] = radius * ring * Math.sin(angle);
  }

  const jitter = new Float64Array(3);

  function samplePointLight(depth, normal, light) {
    if (!reaches(light)) return;
    randomOnSphere(light.radius, jitter);
    const { distance, distanceSquared } = aimAt(light.position[0] + jitter[0], light.position[1] + jitter[1], light.position[2] + jitter[2]);
    if (distance < 1e-6) return;
    const strength = light.intensity * pointLightFalloff(distanceSquared, light);
    for (let channel = 0; channel < 3; channel++) lightRadiance[channel] = light.color[channel] * strength;
    addDirect(depth, normal, distance - scene.surfaceOffset, fullWeight);
  }

  function sampleSpotLight(depth, normal, light) {
    if (!reaches(light)) return;
    randomOnSphere(light.radius, jitter);
    const { distance, distanceSquared } = aimAt(light.position[0] + jitter[0], light.position[1] + jitter[1], light.position[2] + jitter[2]);
    if (distance < 1e-6) return;
    const axisCosine = -(light.direction[0] * lightDirection[0] + light.direction[1] * lightDirection[1] + light.direction[2] * lightDirection[2]);
    const inside = axisCosine - light.cosineHalfAngle;
    if (inside <= 0) return;
    const mask = light.blend > 0 && inside < light.blend ? smoothstep(inside / light.blend) : 1;
    const strength = light.intensity * pointLightFalloff(distanceSquared, light) * mask * (light.profile ? profileGain(light.profile, axisCosine) : 1);
    for (let channel = 0; channel < 3; channel++) lightRadiance[channel] = light.color[channel] * strength;
    addDirect(depth, normal, distance - scene.surfaceOffset, fullWeight);
  }

  function sampleAreaLight(depth, normal, light) {
    if (!reaches(light)) return;
    const across = (random.next() - 0.5) * light.width;
    const along = (random.next() - 0.5) * light.height;
    const pointX = light.position[0] + light.across[0] * across + light.along[0] * along;
    const pointY = light.position[1] + light.across[1] * across + light.along[1] * along;
    const pointZ = light.position[2] + light.across[2] * across + light.along[2] * along;
    const { distance, distanceSquared } = aimAt(pointX, pointY, pointZ);
    if (distance < 1e-6) return;
    const emitCosine = -(light.normal[0] * lightDirection[0] + light.normal[1] * lightDirection[1] + light.normal[2] * lightDirection[2]);
    if (emitCosine <= 0) return;
    const strength = light.intensity * emitCosine / distanceSquared * (light.profile ? profileGain(light.profile, emitCosine) : 1);
    for (let channel = 0; channel < 3; channel++) lightRadiance[channel] = light.color[channel] * strength;
    addDirect(depth, normal, distance - scene.surfaceOffset, fullWeight);
  }

  let environmentSampledPdf = 0;
  const environmentWeight = candidate => {
    const lightPdf = environmentSampledPdf * selectionProbability;
    const total = lightPdf * lightPdf + candidate.pdf * candidate.pdf;
    return lightPdf * lightPdf / total / lightPdf;
  };

  function sampleEnvironmentLight(depth, normal) {
    environmentSampledPdf = sampleEnvironment(environment, random.next(), random.next(), random.next(), random.next(), lightDirection);
    if (!(environmentSampledPdf > 0)) return;
    environmentRadiance(environment, lightDirection[0], lightDirection[1], lightDirection[2], lightRadiance);
    addDirect(depth, normal, scene.farDistance, environmentWeight);
  }

  const emitterCount = (lights.sun ? 1 : 0) + lights.points.length + lights.spots.length + lights.areas.length + (environment ? 1 : 0);

  function addEveryLight(depth, normal) {
    selectionProbability = 1;
    if (lights.sun) sampleSun(depth, normal);
    for (const light of lights.points) samplePointLight(depth, normal, light);
    for (const light of lights.spots) sampleSpotLight(depth, normal, light);
    for (const light of lights.areas) sampleAreaLight(depth, normal, light);
    if (environment) sampleEnvironmentLight(depth, normal);
  }

  const lightCount = lights.points.length + lights.spots.length + lights.areas.length;
  const useLightTree = resolveLightSelection(options.lightSelection, lights) === 'tree' && lightCount > 1;
  const lightTree = useLightTree ? buildLightTree(lights) : null;
  const drawRandom = () => random.next();
  function sampleLightByIndex(depth, normal, index) {
    if (index < lights.points.length) return samplePointLight(depth, normal, lights.points[index]);
    index -= lights.points.length;
    if (index < lights.spots.length) return sampleSpotLight(depth, normal, lights.spots[index]);
    return sampleAreaLight(depth, normal, lights.areas[index - lights.spots.length]);
  }

  const linkedLightsByMask = new Map();
  const allLights = () => [...lights.points, ...lights.spots, ...lights.areas];
  /** The sampling-order indices of the local lights the hit part is lit by; every light inside a medium. */
  function linkedLights() {
    const mask = inMedium ? -1 : hit.material.lightMask;
    let linked = linkedLightsByMask.get(mask);
    if (!linked) {
      linked = [];
      allLights().forEach((light, index) => {
        if ((mask >> light.bit & 1) === 1) linked.push(index);
      });
      linkedLightsByMask.set(mask, linked);
    }
    return linked;
  }

  /** One emitter by the light tree: the sun and the sky keep a uniform share, the local lights share theirs down the tree. */
  function addOneLightByTree(depth, normal) {
    const lightsShare = lightCount / emitterCount;
    let remaining = Math.floor(random.next() * emitterCount);
    if (lights.sun) {
      if (remaining === 0) {
        selectionProbability = 1 / emitterCount;
        return sampleSun(depth, normal);
      }
      remaining--;
    }
    if (remaining >= lightCount) {
      selectionProbability = 1 / emitterCount;
      return sampleEnvironmentLight(depth, normal);
    }
    const linked = linkedLights();
    if (linked.length < lightCount) {
      // The tree weighs a node by every light under it, linked or not, so a receiver with light linking draws uniformly among the lights it can see.
      selectionProbability = 1 / emitterCount;
      if (linked.length === 0) return;
      selectionProbability = lightsShare / linked.length;
      sampleLightByIndex(depth, normal, linked[Math.floor(random.next() * linked.length)]);
      selectionProbability = 1 / emitterCount;
      return;
    }
    const picked = chooseLightFromTree(lightTree, hit.point[0], hit.point[1], hit.point[2], normal[0], normal[1], normal[2], drawRandom);
    selectionProbability = 1 / emitterCount;
    if (picked.lightIndex < 0) return;
    selectionProbability = lightsShare * picked.probability;
    sampleLightByIndex(depth, normal, picked.lightIndex);
    // The sky is drawn with its uniform share whatever light was chosen: that share weighs the next escape ray.
    selectionProbability = 1 / emitterCount;
  }

  function addOneLight(depth, normal) {
    selectionProbability = 1 / emitterCount;
    let remaining = Math.floor(random.next() * emitterCount);
    if (lights.sun) {
      if (remaining === 0) return sampleSun(depth, normal);
      remaining--;
    }
    if (remaining < lights.points.length) return samplePointLight(depth, normal, lights.points[remaining]);
    remaining -= lights.points.length;
    if (remaining < lights.spots.length) return sampleSpotLight(depth, normal, lights.spots[remaining]);
    remaining -= lights.spots.length;
    if (remaining < lights.areas.length) return sampleAreaLight(depth, normal, lights.areas[remaining]);
    return sampleEnvironmentLight(depth, normal);
  }

  function addLights(depth, normal) {
    const firstHitByTree = useLightTree && lightCount > LIGHT_TREE_FIRST_HIT_LIGHTS;
    if ((depth === 0 && !firstHitByTree) || emitterCount <= 1) addEveryLight(depth, normal);
    else if (useLightTree) addOneLightByTree(depth, normal);
    else addOneLight(depth, normal);
  }

  function addEscape(depth, previousPdf, afterMirror) {
    if (!environment) return;
    environmentRadiance(environment, direction[0], direction[1], direction[2], sky);
    let weight = 1;
    if (!afterMirror) {
      const environmentSide = environmentPdf(environment, direction[0], direction[1], direction[2]) * selectionProbability;
      weight = previousPdf * previousPdf / (previousPdf * previousPdf + environmentSide * environmentSide);
    }
    addRadiance(depth, throughput[0] * sky[0] * weight, throughput[1] * sky[1] * weight, throughput[2] * sky[2] * weight);
  }

  function recordFeatures(normal, isGlass) {
    features.albedo[0] = isGlass ? 1 : hit.color[0];
    features.albedo[1] = isGlass ? 1 : hit.color[1];
    features.albedo[2] = isGlass ? 1 : hit.color[2];
    features.normal[0] = normal[0];
    features.normal[1] = normal[1];
    features.normal[2] = normal[2];
    features.depth = hit.distance;
  }

  function survivesRoulette(depth) {
    if (depth < RUSSIAN_ROULETTE_START) return true;
    const survival = Math.min(0.95, Math.max(0.05, Math.max(throughput[0], throughput[1], throughput[2])));
    if (random.next() >= survival) return false;
    for (let channel = 0; channel < 3; channel++) throughput[channel] /= survival;
    return true;
  }

  /**
   * Draws the distance to the next scattering event along the segment. When it falls inside the fog before the segment ends,
   * puts the event in `hit.point` and returns true; otherwise the ray crosses the fog (or misses it) unchanged, because the
   * chance of not scattering is exactly the transmittance that the sampling would otherwise multiply in.
   */
  function scatterInFog(originX, originY, originZ, segmentLength) {
    const { volume } = scene;
    if (!volumeInterval(volume, originX, originY, originZ, direction[0], direction[1], direction[2], segmentLength, volumeSpan)) return false;
    const eventDistance = volumeSpan[0] - Math.log(1 - random.next()) / volume.density;
    if (eventDistance >= volumeSpan[1]) return false;
    hit.point[0] = originX + direction[0] * eventDistance;
    hit.point[1] = originY + direction[1] * eventDistance;
    hit.point[2] = originZ + direction[2] * eventDistance;
    return true;
  }

  /** Lights the scattering event, then turns `direction` by a Henyey-Greenstein draw. Returns the draw's density. */
  function scatterInMedium(depth) {
    const { volume } = scene;
    for (let channel = 0; channel < 3; channel++) throughput[channel] *= volume.albedo[channel];
    inMedium = true;
    addLights(depth, normal);
    inMedium = false;
    const cosine = sampleHenyeyGreensteinCosine(volume.anisotropy, random.next());
    const sine = Math.sqrt(Math.max(0, 1 - cosine * cosine));
    const azimuth = 2 * Math.PI * random.next();
    buildFrame(direction, mediumFrame);
    for (let axis = 0; axis < 3; axis++) {
      scatteredDirection[axis] = mediumFrame[axis] * sine * Math.cos(azimuth) + mediumFrame[3 + axis] * sine * Math.sin(azimuth) + mediumFrame[6 + axis] * cosine;
    }
    for (let axis = 0; axis < 3; axis++) direction[axis] = scatteredDirection[axis];
    return henyeyGreensteinPhase(volume.anisotropy, cosine);
  }

  // A scattering local volume is lit by the sky's mean radiance and by the sun through a shadow ray, as the rasterizer lights it.
  const localVolumeLighting = scene.localVolumes?.some(volume => volume.scatter > 0)
    ? {
      sun: lights.sun,
      ambient: meanEnvironmentRadiance(environment),
      sunVisibility: (pointX, pointY, pointZ) => (occluded(scene, pointX, pointY, pointZ, lights.sun.direction[0], lights.sun.direction[1], lights.sun.direction[2], scene.farDistance, shadowHit) ? 0 : 1),
    }
    : null;
  const crossLocalVolumes = scene.localVolumes ? createLocalVolumeCrossing(scene.localVolumes, localVolumeLighting) : null;
  const localEmitted = new Float64Array(3);

  const walkSubsurface = createRandomWalk(scene, random, intersect);
  const walkWeight = new Float64Array(3);

  /**
   * Sends the diffuse light of the hit through its subsurface random walk. On success the path stands where the walk left (or,
   * for a card with nothing behind it, on the near or far face), `normal` faces out of that point, `surface` is a white diffuse
   * lobe there with its lights added, and the throughput carries the walk. False when the walk ended inside the part.
   */
  function enterSubsurface(depth, subsurface) {
    const color = subsurface.color ?? hit.color;
    walkWeight.fill(1);
    const outcome = walkSubsurface(subsurface, color, hit.point[0], hit.point[1], hit.point[2], normal, hit.material, shadowHit, walkWeight);
    if (outcome === WALK_OUTCOME.lost) return false;
    const entryScale = surface.diffuseShare * subsurface.weight / surface.subsurfaceChance;
    if (outcome === WALK_OUTCOME.exit) {
      const facing = shadowHit.normal[0] * walkSubsurface.direction[0] + shadowHit.normal[1] * walkSubsurface.direction[1] + shadowHit.normal[2] * walkSubsurface.direction[2] < 0 ? -1 : 1;
      for (let axis = 0; axis < 3; axis++) {
        hit.point[axis] = shadowHit.point[axis];
        normal[axis] = shadowHit.normal[axis] * facing;
      }
      for (let channel = 0; channel < 3; channel++) throughput[channel] *= walkWeight[channel] * entryScale;
    } else {
      // A card: half of the colour is reflected on the side the ray came from and half is transmitted diffusely through it.
      if (random.next() < 0.5) for (let axis = 0; axis < 3; axis++) normal[axis] = -normal[axis];
      for (let channel = 0; channel < 3; channel++) throughput[channel] *= color[channel] * entryScale;
    }
    setWhiteDiffuse(surface, normal);
    addLights(depth, normal);
    return true;
  }

  /** Follows one camera ray. Leaves the radiance in `radiance` and the first-hit features in `features`. */
  function trace(originX, originY, originZ, directionX, directionY, directionZ, pixel, sample) {
    random.reset(pixel, sample, options.seed);
    radiance[0] = 0;
    radiance[1] = 0;
    radiance[2] = 0;
    throughput[0] = 1;
    throughput[1] = 1;
    throughput[2] = 1;
    features.albedo.fill(1);
    featuresRecorded = false;
    // A ray that finds nothing has the sky as its feature: one fixed normal and depth, so the filter treats sky as one surface.
    features.normal[0] = 0;
    features.normal[1] = 0;
    features.normal[2] = 1;
    features.depth = 0;
    direction[0] = directionX;
    direction[1] = directionY;
    direction[2] = directionZ;
    let positionX = originX;
    let positionY = originY;
    let positionZ = originZ;
    let previousPdf = 0;
    let afterMirror = true;
    for (let depth = 0; depth <= options.bounces; depth++) {
      const found = intersect(scene, positionX, positionY, positionZ, direction[0], direction[1], direction[2], hit, depth === 0);
      const scattersInFog = scene.volume && scatterInFog(positionX, positionY, positionZ, found ? hit.distance : scene.farDistance);
      if (crossLocalVolumes) {
        const segmentLength = scattersInFog ? Math.hypot(hit.point[0] - positionX, hit.point[1] - positionY, hit.point[2] - positionZ) : (found ? hit.distance : scene.farDistance);
        crossLocalVolumes(positionX, positionY, positionZ, direction[0], direction[1], direction[2], segmentLength, random.next(), throughput, localEmitted);
        addRadiance(depth, localEmitted[0], localEmitted[1], localEmitted[2]);
      }
      if (scattersInFog) {
        previousPdf = scatterInMedium(depth);
        afterMirror = false;
        positionX = hit.point[0];
        positionY = hit.point[1];
        positionZ = hit.point[2];
        if (!survivesRoulette(depth)) break;
        continue;
      }
      if (!found) {
        addEscape(depth, previousPdf, afterMirror);
        break;
      }
      const material = hit.material;
      const entering = hit.normal[0] * direction[0] + hit.normal[1] * direction[1] + hit.normal[2] * direction[2] < 0;
      const facing = entering ? 1 : -1;
      normal[0] = hit.normal[0] * facing;
      normal[1] = hit.normal[1] * facing;
      normal[2] = hit.normal[2] * facing;
      const isGlass = hit.transmission > 0 && random.next() < hit.transmission;
      if (!featuresRecorded) {
        recordFeatures(normal, isGlass);
        featuresRecorded = true;
      }
      const emissionScale = hit.material.emissionFresnel > 0
        ? fresnelSchlick(-(direction[0] * normal[0] + direction[1] * normal[1] + direction[2] * normal[2]), hit.material.emissionFresnel)
        : 1;
      addRadiance(depth, throughput[0] * hit.emission[0] * emissionScale, throughput[1] * hit.emission[1] * emissionScale, throughput[2] * hit.emission[2] * emissionScale);
      const viewX = -direction[0];
      const viewY = -direction[1];
      const viewZ = -direction[2];
      if (isGlass) {
        const alpha = roughnessToAlpha(hit.roughness);
        if (!sampleGlass(normal, viewX, viewY, viewZ, entering, material.ior, alpha, random.next(), random.next(), random.next(), direction)) break;
        const refracted = direction[0] * normal[0] + direction[1] * normal[1] + direction[2] * normal[2] < 0;
        if (refracted) {
          throughput[0] *= hit.color[0];
          throughput[1] *= hit.color[1];
          throughput[2] *= hit.color[2];
        }
        afterMirror = true;
      } else {
        prepareSurface(surface, material, hit.metallic, hit.roughness, hit.color, normal, viewX, viewY, viewZ, hit.clearcoat);
        const subsurface = material.subsurface;
        if (subsurface) splitSubsurface(surface, subsurface.weight);
        addLights(depth, normal);
        let lobeUnit = random.next();
        if (subsurface) {
          if (lobeUnit < surface.subsurfaceChance) {
            if (!enterSubsurface(depth, subsurface)) break;
            lobeUnit = 0;
          } else {
            lobeUnit -= surface.subsurfaceChance;
          }
        }
        const isMirror = sampleSurface(surface, lobeUnit, random.next(), random.next(), direction);
        const cosine = direction[0] * normal[0] + direction[1] * normal[1] + direction[2] * normal[2];
        if (cosine <= 0) break;
        if (isMirror) {
          mirrorWeight(surface, mirror);
          for (let channel = 0; channel < 3; channel++) throughput[channel] *= mirror[channel];
          afterMirror = true;
        } else {
          evaluateSurface(surface, direction[0], direction[1], direction[2]);
          if (!(surface.pdf > 0)) break;
          for (let channel = 0; channel < 3; channel++) throughput[channel] *= surface.value[channel] * cosine / surface.pdf;
          previousPdf = surface.pdf;
          afterMirror = false;
        }
      }
      positionX = hit.point[0] + direction[0] * scene.surfaceOffset;
      positionY = hit.point[1] + direction[1] * scene.surfaceOffset;
      positionZ = hit.point[2] + direction[2] * scene.surfaceOffset;
      if (!survivesRoulette(depth)) break;
    }
  }

  return { trace, radiance, features };
}

// ---- Image ----

/** The display transform of the rasterizer's post pass (view transform, gamma 2.2, optional look) applied to linear pixels. */
export function toneMapToRgba8(linear, width, height, { viewTransform = 'aces', look = null } = {}) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  const plainCurve = viewTransform === 'aces' && !look;
  for (let pixel = 0; pixel < width * height; pixel++) {
    const color = plainCurve
      ? [0, 1, 2].map(channel => acesChannel(linear[pixel * 3 + channel]) ** (1 / 2.2))
      : displayColor([linear[pixel * 3], linear[pixel * 3 + 1], linear[pixel * 3 + 2]], { viewTransform, look });
    for (let channel = 0; channel < 3; channel++) rgba[pixel * 4 + channel] = Math.round(color[channel] * 255);
    rgba[pixel * 4 + 3] = 255;
  }
  return rgba;
}

/** Names what this scene asks for that the path tracer does not draw, so a result never claims more than it traced. */
export function describeIgnoredFeatures(parts, environment, backend = 'cpu', { kernelMaterials = false } = {}) {
  const notes = new Set();
  const fog = environment?.volumeFog;
  if (fog?.density > 0 && (fog.noiseAmount ?? 0.5) > 0) notes.add('volumeFog is traced as a uniform medium: noiseAmount, noiseScale and drift are ignored.');
  if (fog?.density > 0 && fog.ambient) notes.add('volumeFog.ambient is not added: the fog is lit by the traced lights and sky.');
  const hasSoftFalloff = [...(environment?.pointLights ?? []), ...(environment?.spotLights ?? [])].some(light => light.softFalloff === true);
  if (hasSoftFalloff && !kernelMaterials) notes.add('softFalloff is ignored: only the native cycles kernel draws a light as an oriented disk, the other tracers draw a sphere.');
  if (!environment?.map) notes.add('There is no environment map, so the sky is black and only the lights shine.');
  if (environment?.cameraIntensity !== undefined && !kernelMaterials) notes.add('cameraIntensity is ignored: only the native cycles kernel draws the sky a camera ray sees at its own strength, the other tracers use the map intensity.');
  for (const part of parts) {
    const material = part.material ?? {};
    for (const field of IGNORED_MAP_FIELDS) if (material[field]) notes.add(`${field} is ignored.`);
    if (material.tag && material.tag !== 'surface') notes.add(`${material.tag} materials are traced as plain surfaces.`);
    if (material.alphaMode === 'blend' && hasGraphOpacity(material)) notes.add('A graph opacity output is traced as a cutout at 0.5.');
    else if (material.alphaMode === 'blend' && !kernelMaterials) notes.add('Blended transparency is traced as opaque.');
    if (!kernelMaterials && (material.layerMaps?.clearcoatTexture || material.transmissionMap)) notes.add('Graph clearcoat and transmission masks are read by the CPU tracer; the GPU tracers use the factors.');
    if (kernelMaterials && hasSplitLayerMap(material)) notes.add('A clearcoat or sheen colour map is ignored when the layer has a roughness above 0 kept in another map.');
    if (material.emissionFresnel > 0 && backend !== 'cpu') notes.add('emission fresnel is ignored by the GPU path tracers; the cpu backend applies it.');
    for (const [name, isUsed, kernelShades] of IGNORED_LAYERS) if (!(kernelMaterials && kernelShades) && isUsed(material, kernelMaterials)) notes.add(`${name} is ignored.`);
  }
  return [...notes];
}

/**
 * Renders rows `rowStart` up to `rowEnd` and returns their buffers (colour, albedo, normal, depth, variance), row
 * major from the band's first row. A pixel's random numbers depend only on its place in the whole image, so bands
 * can be drawn in any order, on any thread, and give the same pixels.
 */
/**
 * True when the mean luminance of a pixel is known well enough: its standard error, relative to the mean plus a small
 * floor so that near-black pixels do not ask for endless samples, is under `threshold`. It reads only the pixel's own
 * samples, so the decision is the same on any thread and in any band split.
 */
function hasConverged(sumLuminance, sumLuminanceSquares, sampleCount, threshold) {
  const mean = sumLuminance / sampleCount;
  const sampleVariance = Math.max(0, sumLuminanceSquares / sampleCount - mean * mean) * sampleCount / (sampleCount - 1);
  const standardError = Math.sqrt(sampleVariance / sampleCount);
  return standardError < threshold * (mean + CONVERGENCE_LUMINANCE_FLOOR);
}

function isConvergenceCheckDue(sampleCount, options) {
  if (!(options.noiseThreshold > 0)) return false;
  if (sampleCount < ADAPTIVE_MINIMUM_SAMPLES) return false;
  return (sampleCount - ADAPTIVE_MINIMUM_SAMPLES) % ADAPTIVE_BATCH_SAMPLES === 0;
}

export function renderBand(scene, camera, options, rowStart, rowEnd, shouldStop = () => {}) {
  const tracer = createPathTracer(scene, options);
  const { width, height, samples } = options;
  const pixelCount = (rowEnd - rowStart) * width;
  const color = new Float32Array(pixelCount * 3);
  const albedo = new Float32Array(pixelCount * 3);
  const normal = new Float32Array(pixelCount * 3);
  const depth = new Float32Array(pixelCount);
  const variance = new Float32Array(pixelCount);
  const samplesTaken = new Uint16Array(pixelCount);
  for (let row = rowStart; row < rowEnd; row++) {
    shouldStop();
    for (let column = 0; column < width; column++) {
      const pixel = row * width + column;
      const slot = (row - rowStart) * width + column;
      let sumLuminance = 0;
      let sumLuminanceSquares = 0;
      let taken = 0;
      while (taken < samples) {
        const sample = taken;
        const jitterX = hashJitter(pixel, sample, options.seed, 1);
        const jitterY = hashJitter(pixel, sample, options.seed, 2);
        const screenX = ((column + jitterX) / width * 2 - 1) * camera.halfWidth;
        const screenY = (1 - (row + jitterY) / height * 2) * camera.halfHeight;
        const directionX = camera.forward[0] + camera.right[0] * screenX + camera.above[0] * screenY;
        const directionY = camera.forward[1] + camera.right[1] * screenX + camera.above[1] * screenY;
        const directionZ = camera.forward[2] + camera.right[2] * screenX + camera.above[2] * screenY;
        const length = Math.hypot(directionX, directionY, directionZ);
        tracer.trace(camera.eye[0], camera.eye[1], camera.eye[2], directionX / length, directionY / length, directionZ / length, pixel, sample);
        const { radiance, features } = tracer;
        const sampleLuminance = luminance(radiance[0], radiance[1], radiance[2]);
        sumLuminance += sampleLuminance;
        sumLuminanceSquares += sampleLuminance * sampleLuminance;
        for (let channel = 0; channel < 3; channel++) {
          color[slot * 3 + channel] += radiance[channel];
          albedo[slot * 3 + channel] += features.albedo[channel];
          normal[slot * 3 + channel] += features.normal[channel];
        }
        depth[slot] += features.depth;
        taken++;
        if (isConvergenceCheckDue(taken, options) && hasConverged(sumLuminance, sumLuminanceSquares, taken, options.noiseThreshold)) break;
      }
      for (let channel = 0; channel < 3; channel++) {
        color[slot * 3 + channel] /= taken;
        albedo[slot * 3 + channel] /= taken;
        normal[slot * 3 + channel] /= taken;
      }
      depth[slot] /= taken;
      const meanLuminance = sumLuminance / taken;
      variance[slot] = Math.max(0, sumLuminanceSquares / taken - meanLuminance * meanLuminance) / Math.max(taken - 1, 1);
      samplesTaken[slot] = taken;
    }
  }
  return { color, albedo, normal, depth, variance, samplesTaken };
}

function hashJitter(pixel, sample, seed, dimension) {
  let mixed = Math.imul(pixel ^ 0x51ed270b, 0x9e3779b1) ^ Math.imul(sample + dimension * 0x632be5ab, 0x85ebca6b) ^ Math.imul(seed + 0x1b873593, 0xc2b2ae35);
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x7feb352d);
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x846ca68b);
  mixed ^= mixed >>> 16;
  return (mixed >>> 0) / 4294967296;
}

function totalSamples(samplesTaken) {
  let total = 0;
  for (let pixel = 0; pixel < samplesTaken.length; pixel++) total += samplesTaken[pixel];
  return total;
}

function normalizeNormals(normal, pixelCount) {
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const length = Math.hypot(normal[pixel * 3], normal[pixel * 3 + 1], normal[pixel * 3 + 2]);
    if (length === 0) continue;
    for (let axis = 0; axis < 3; axis++) normal[pixel * 3 + axis] /= length;
  }
}

function copyBand(buffers, band, rowStart, width) {
  const pixelOffset = rowStart * width;
  for (const name of ['color', 'albedo', 'normal']) buffers[name].set(band[name], pixelOffset * 3);
  for (const name of ['depth', 'variance', 'samplesTaken']) buffers[name].set(band[name], pixelOffset);
}

/** Draws bands on a pool of module workers, handing the next band to whichever worker finishes first. */
function renderBandsInWorkers(scene, camera, options, buffers, shouldStop) {
  const bandCount = Math.ceil(options.height / WORKER_BAND_ROWS);
  const workerCount = Math.min(options.threads, bandCount);
  const workers = [];
  const { tracer: _tracer, ...transferableScene } = scene;
  return new Promise((resolve, reject) => {
    let nextBand = 0;
    let finishedBands = 0;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearInterval(clock);
      for (const worker of workers) worker.terminate();
      if (error) reject(error);
      else resolve();
    };
    const clock = setInterval(() => {
      try {
        shouldStop();
      } catch (error) {
        finish(error);
      }
    }, 250);
    const assign = (worker) => {
      if (nextBand >= bandCount) return;
      const rowStart = nextBand * WORKER_BAND_ROWS;
      nextBand++;
      worker.postMessage({ type: 'band', rowStart, rowEnd: Math.min(rowStart + WORKER_BAND_ROWS, options.height) });
    };
    for (let index = 0; index < workerCount; index++) {
      const worker = new Worker(new URL(WORKER_FILE, import.meta.url), { type: 'module' });
      workers.push(worker);
      worker.onerror = (event) => finish(new Error(`Path tracer worker failed: ${event.message}`));
      worker.onmessage = (event) => {
        if (event.data.type === 'ready') {
          assign(worker);
          return;
        }
        copyBand(buffers, event.data.band, event.data.rowStart, options.width);
        finishedBands++;
        if (finishedBands === bandCount) finish();
        else assign(worker);
      };
      worker.postMessage({ type: 'scene', scene: transferableScene, camera, options });
    }
  });
}

/**
 * Renders one still. `scene` is `{ parts, environment, camera }` as the rasterizer takes them. Resolves with the linear
 * pixels, the tone-mapped RGBA bytes, and a report. Rejects, and returns nothing, when `maxSeconds` runs out.
 * `threads` above 1 uses module workers where the platform has them; the pixels are the same either way.
 */
export async function renderPathTracedImage({ parts, environment = {}, camera }, rawOptions = {}) {
  const options = normalizePathTracerOptions(rawOptions);
  const started = performance.now();
  const shouldStop = () => {
    if ((performance.now() - started) / 1000 > options.maxSeconds) throw new Error(`The path trace passed its ${options.maxSeconds} second limit and was stopped.`);
  };
  const { width, height } = options;
  const view = createCamera(camera, width, height);
  const scene = buildTraceScene(parts, environment);
  if (options.backend !== 'cpu') refuseLocalVolumes(scene, `backend "${options.backend}"`);
  const pixelCount = width * height;
  const buffers = {
    color: new Float32Array(pixelCount * 3), albedo: new Float32Array(pixelCount * 3), normal: new Float32Array(pixelCount * 3),
    depth: new Float32Array(pixelCount), variance: new Float32Array(pixelCount), samplesTaken: new Uint16Array(pixelCount),
  };
  const threads = typeof Worker === 'function' ? options.threads : 1;
  let gpuName = null;
  let gpuCompileSeconds = 0;
  let gpuKernelCompiles = 0;
  if (options.backend === 'gpu' || options.backend === 'webgpu') {
    const { traceOnGpu, gpuKernelCompileCount } = await (options.backend === 'webgpu' ? import('./path-tracer-webgpu.js') : import('./path-tracer-gpu.js'));
    const traced = await traceOnGpu(scene, view, options, shouldStop);
    gpuName = traced.gpu;
    gpuCompileSeconds = traced.compileSeconds;
    gpuKernelCompiles = gpuKernelCompileCount();
    copyBand(buffers, traced, 0, width);
  } else if (threads > 1) {
    await renderBandsInWorkers(scene, view, { ...options, threads }, buffers, shouldStop);
  } else {
    copyBand(buffers, renderBand(scene, view, options, 0, height, shouldStop), 0, width);
  }
  shouldStop();
  const tracedSeconds = (performance.now() - started) / 1000;
  normalizeNormals(buffers.normal, pixelCount);
  const { samplesTaken, ...denoiseInputs } = buffers;
  const linear = options.denoiser === 'wavelet' ? denoiseRadiance({ width, height, ...denoiseInputs }) : buffers.color;
  return {
    width, height, linear, rgba: toneMapToRgba8(linear, width, height, options), features: denoiseInputs,
    report: {
      width, height, samples: options.samples, bounces: options.bounces, seed: options.seed, denoised: options.denoiser === 'wavelet',
      denoiser: options.denoiser, threads,
      backend: options.backend, ...(gpuName ? { gpu: gpuName, gpuCompileSeconds, gpuKernelCompiles } : {}),
      averageSamples: totalSamples(samplesTaken) / pixelCount, noiseThreshold: options.noiseThreshold,
      triangles: scene.indices.length / 3, tracedSeconds, seconds: (performance.now() - started) / 1000,
      ignored: describeIgnoredFeatures(parts, environment, options.backend),
    },
  };
}

// Cook is the public name of the path tracer.
export const Cook = renderPathTracedImage;
