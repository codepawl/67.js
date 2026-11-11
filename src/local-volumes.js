import { finiteRange } from './volumetric.js';
import { localVolumeNoiseFactor } from './local-volume-noise.js';

// Local volumes: up to MAX_LOCAL_VOLUMES boxes, spheres or parts (shape "mesh") that absorb and emit light and, with `scatter`, scatter
// the key light and the sky, for candle haze, smoke puffs and glowing fog in one place. They sit beside environment.volumeFog (the one scattering volume) and need no fog. The post pass marches
// each one separately and composites them from the nearest entry to the farthest, so overlapping volumes are an approximation.

export const MAX_LOCAL_VOLUMES = 8;
export const LOCAL_VOLUME_SHAPES = Object.freeze(['box', 'sphere', 'mesh']);
export const LOCAL_VOLUME_FIT = Object.freeze(['bounds', 'mesh']);
export const LOCAL_VOLUME_FIELDS = Object.freeze(['shape', 'part', 'fit', 'center', 'size', 'radius', 'density', 'falloff', 'absorption', 'emission', 'emissionStrength', 'scatter', 'noiseAmount', 'noiseScale', 'steps']);
export const LOCAL_VOLUME_MAXIMUM_STEPS = 32;

function vectorField(value, minimum, maximum, label) {
  if (!Array.isArray(value) || value.length !== 3) throw new TypeError(`${label} must be an array of three numbers`);
  return value.map(component => finiteRange(component, minimum, maximum, label));
}

function resolveLocalVolume(input, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError(`${label} must be an object`);
  for (const field of Object.keys(input)) {
    if (!LOCAL_VOLUME_FIELDS.includes(field)) throw new TypeError(`${label} has no field "${field}"; use ${LOCAL_VOLUME_FIELDS.join(', ')}`);
  }
  const shape = input.shape ?? 'box';
  if (!LOCAL_VOLUME_SHAPES.includes(shape)) throw new RangeError(`${label}.shape must be one of ${LOCAL_VOLUME_SHAPES.join(', ')}`);
  const resolved = {
    shape,
    ...(shape === 'mesh' ? {} : { center: vectorField(input.center, -1e5, 1e5, `${label}.center`) }),
    density: finiteRange(input.density ?? 1, 0, 100, `${label}.density`),
    falloff: finiteRange(input.falloff ?? 0.5, 0, 1, `${label}.falloff`),
    absorption: vectorField(input.absorption ?? [1, 1, 1], 0, 1, `${label}.absorption`),
    emission: vectorField(input.emission ?? [0, 0, 0], 0, 1, `${label}.emission`),
    emissionStrength: finiteRange(input.emissionStrength ?? 1, 0, 1000, `${label}.emissionStrength`),
    scatter: finiteRange(input.scatter ?? 0, 0, 1, `${label}.scatter`),
    noiseAmount: finiteRange(input.noiseAmount ?? 0, 0, 1, `${label}.noiseAmount`),
    noiseScale: finiteRange(input.noiseScale ?? 1, 0.001, 100, `${label}.noiseScale`),
    steps: finiteRange(input.steps ?? 16, 4, LOCAL_VOLUME_MAXIMUM_STEPS, `${label}.steps`),
  };
  if (!Number.isInteger(resolved.steps)) throw new RangeError(`${label}.steps must be an integer`);
  if (shape === 'mesh') {
    if (typeof input.part !== 'string' || input.part === '') throw new TypeError(`${label}.part must be the name of the part that bounds the volume`);
    for (const field of ['center', 'size', 'radius']) {
      if (input[field] !== undefined) throw new TypeError(`${label}.${field} belongs to a box or a sphere; a mesh volume takes its place and size from the part named in ${label}.part`);
    }
    if (resolved.scatter > 0 && (input.fit ?? 'bounds') === 'mesh') throw new RangeError(`${label}.scatter is not drawn inside a volume that fits the closed mesh; use fit "bounds" or scatter 0`);
    resolved.part = input.part;
    resolved.fit = input.fit ?? 'bounds';
    if (!LOCAL_VOLUME_FIT.includes(resolved.fit)) throw new RangeError(`${label}.fit must be one of ${LOCAL_VOLUME_FIT.join(', ')}`);
    return resolved;
  }
  if (input.part !== undefined || input.fit !== undefined) throw new TypeError(`${label}.part and ${label}.fit belong to shape "mesh"`);
  if (shape === 'sphere') {
    if (input.size !== undefined) throw new TypeError(`${label}.size belongs to a box; a sphere takes radius`);
    resolved.radius = finiteRange(input.radius, 0.001, 1e4, `${label}.radius`);
  } else {
    if (input.radius !== undefined) throw new TypeError(`${label}.radius belongs to a sphere; a box takes size [width, height, depth]`);
    resolved.size = vectorField(input.size, 0.001, 1e4, `${label}.size`);
  }
  return resolved;
}

/** Checks a list of local volumes and returns them with every default filled in. Throws an error that names the field. */
export function resolveLocalVolumes(input, label = 'localVolumes') {
  if (!Array.isArray(input)) throw new TypeError(`${label} must be an array of volumes`);
  if (input.length > MAX_LOCAL_VOLUMES) throw new RangeError(`${label} holds at most ${MAX_LOCAL_VOLUMES} volumes, got ${input.length}`);
  return input.map((volume, index) => resolveLocalVolume(volume, `${label}[${index}]`));
}

/** The uniform arrays the post shader reads, one vec4 per volume. Pass resolved volumes. */
export function createLocalVolumeBuffers() {
  const size = MAX_LOCAL_VOLUMES * 4;
  return { count: 0, meshParts: [], centers: new Float32Array(size), extents: new Float32Array(size), absorption: new Float32Array(size), emission: new Float32Array(size), steps: new Float32Array(size), axes: new Float32Array(size * 3) };
}

const IDENTITY_AXES = Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1]);

// The w of a packed centre tells the shader how to find the volume: 0 a box, 1 a sphere, 2 a closed mesh read from the mesh pass.
export const PACKED_SHAPE_MESH = 2;

export function packLocalVolumes(volumes, buffers) {
  if (volumes.some(volume => volume.shape === 'mesh' && !volume.center)) throw new RangeError('A mesh volume names a part: bind it with bindLocalVolumeParts before packing');
  buffers.count = volumes.length;
  buffers.meshParts = [];
  volumes.forEach((volume, index) => {
    const at = index * 4;
    const half = volume.shape === 'sphere' ? [volume.radius, volume.radius, volume.radius] : volume.size.map(extent => extent / 2);
    const packedShape = volume.shape === 'sphere' ? 1 : volume.part ? PACKED_SHAPE_MESH : 0;
    buffers.centers.set([...volume.center, packedShape], at);
    buffers.extents.set([...half, volume.falloff], at);
    buffers.absorption.set([...volume.absorption.map(channel => channel * volume.density), volume.noiseAmount], at);
    buffers.emission.set([...volume.emission.map(channel => channel * volume.emissionStrength), volume.noiseScale], at);
    buffers.steps.set([volume.steps, packedShape === PACKED_SHAPE_MESH ? buffers.meshParts.length : 0, volume.scatter ?? 0, 0], at);
    if (packedShape === PACKED_SHAPE_MESH) buffers.meshParts.push({ part: volume.part, label: `environment.localVolumes[${index}]` });
    const axes = volume.axes ?? IDENTITY_AXES;
    for (let axis = 0; axis < 3; axis++) buffers.axes.set([axes[axis * 3], axes[axis * 3 + 1], axes[axis * 3 + 2], 0], (index * 3 + axis) * 4);
  });
  return buffers;
}

/**
 * How much the key light of a scattering volume is scaled over the single-scatter estimate. A smoke thick enough to show form scatters the sun many times
 * and reads about as bright as a surface in the same sun, which one isotropic scatter (1 / 4 pi of the key colour) leaves far too dark; the gain keeps the
 * sunlit side clearly above the shaded side. The rasterizer and the CPU path tracer both apply it.
 */
export const LOCAL_VOLUME_KEY_GAIN = 3;

/**
 * How much the faded outer share of a volume counts toward the depth the light crosses: the profile used for the sun and sky depth is
 * `min(profile * saturation, 1)`. The many scatters of a real smoke spread light through its thin fringe as through its body, so a sun
 * ray running along the faded top or side skin is shaded by the whole volume, not by the skin's low density. With the plain profile that
 * skin is lit far above the core and reads as a bright rim around the form.
 */
export const LOCAL_VOLUME_LIGHT_DEPTH_SATURATION = 3;

/**
 * How many times the volume's own depth toward the sun counts in the key light's attenuation. Counting it more than once keeps the shaded
 * side of the smoke clearly darker than the sunlit side, the way the many scatters of a real smoke take the light from its shade.
 */
export const LOCAL_VOLUME_SHADOW_STRENGTH = 3;

/** The share of the mean sky radiance the sky term of a scattering volume keeps. The sky lights the whole volume evenly, so a high share flattens the form the sun gives it. */
export const LOCAL_VOLUME_SKY_GAIN = 0.5;

/** Samples the march takes per cell of the density noise at least: fewer step over whole cells and the dither of the start offset shows as pixel-pitch grain (#855). */
export const LOCAL_VOLUME_STEPS_PER_NOISE_CELL = 2;

/**
 * The samples a ray takes through a noisy volume: the volume's `steps`, raised so that each noise cell along `length` gets
 * LOCAL_VOLUME_STEPS_PER_NOISE_CELL of them, up to LOCAL_VOLUME_MAXIMUM_STEPS. Without noise it is `steps`. The post shader repeats the rule.
 */
export function localVolumeStepCount(volume, length) {
  if (!(volume.noiseAmount > 0)) return volume.steps;
  const cellSteps = Math.ceil(length * volume.noiseScale * LOCAL_VOLUME_STEPS_PER_NOISE_CELL);
  return Math.min(LOCAL_VOLUME_MAXIMUM_STEPS, Math.max(volume.steps, cellSteps));
}

/**
 * How much of the sun's elevation the depth toward the sun keeps (1 is the true direction). A low sun lights a smoke box through its top face as
 * quickly as through its side, so with the true direction the top edge glows as bright as the sunward edge and the gradient across the form is lost;
 * flattening the direction measures the depth the light crosses sideways, as the many scatters of a real smoke spread it. Above 0 so a sun straight
 * overhead keeps a direction.
 */
export const LOCAL_VOLUME_SUN_FLATTEN = 0.1;

function fadeProfile(ratio) {
  const clamped = Math.min(1, Math.max(0, ratio));
  return 1 - clamped * clamped * (3 - 2 * clamped);
}

/** The density factor of a volume at a point: 1 at the core, fading over the outer `falloff` share, times the noise factor (up to 2) when `noiseAmount` is above 0, as the post shader does. */
export function localVolumeProfile(volume, x, y, z, withNoise = true) {
  if (volume.shape === 'mesh') return 1;
  let offsetX = x - volume.center[0];
  let offsetY = y - volume.center[1];
  let offsetZ = z - volume.center[2];
  if (volume.axes) {
    const axes = volume.axes;
    const alongX = axes[0] * offsetX + axes[1] * offsetY + axes[2] * offsetZ;
    const alongY = axes[3] * offsetX + axes[4] * offsetY + axes[5] * offsetZ;
    offsetZ = axes[6] * offsetX + axes[7] * offsetY + axes[8] * offsetZ;
    offsetX = alongX;
    offsetY = alongY;
  }
  let profile = 1;
  if (volume.shape === 'sphere') {
    const distance = Math.hypot(offsetX, offsetY, offsetZ) / volume.radius;
    if (distance >= 1) return 0;
    if (volume.falloff > 0) profile = fadeProfile((distance - (1 - volume.falloff)) / volume.falloff);
  } else {
    const ratioX = Math.abs(offsetX) / (volume.size[0] / 2);
    const ratioY = Math.abs(offsetY) / (volume.size[1] / 2);
    const ratioZ = Math.abs(offsetZ) / (volume.size[2] / 2);
    if (Math.max(ratioX, ratioY, ratioZ) >= 1) return 0;
    if (volume.falloff > 0) {
      // The distance past the core box, which is round at the corners: the plain largest ratio fades along boxes with mitred creases.
      const core = 1 - volume.falloff;
      const fadeDistance = Math.hypot(Math.max(ratioX - core, 0), Math.max(ratioY - core, 0), Math.max(ratioZ - core, 0));
      profile = fadeProfile(fadeDistance / volume.falloff);
    }
  }
  if (withNoise && volume.noiseAmount > 0) profile *= localVolumeNoiseFactor(volume, x, y, z);
  return profile;
}

/** Where a ray is inside a volume, as distances along it: writes `[entry, exit]` into `out`, clipped to `[0, limit]`, and returns true; false when it misses. */
export function localVolumeInterval(volume, originX, originY, originZ, directionX, directionY, directionZ, limit, out) {
  let entry = 0;
  let exit = limit;
  if (volume.shape === 'sphere') {
    const offsetX = originX - volume.center[0];
    const offsetY = originY - volume.center[1];
    const offsetZ = originZ - volume.center[2];
    const along = offsetX * directionX + offsetY * directionY + offsetZ * directionZ;
    const discriminant = along * along - (offsetX * offsetX + offsetY * offsetY + offsetZ * offsetZ - volume.radius * volume.radius);
    if (discriminant <= 0) return false;
    const root = Math.sqrt(discriminant);
    entry = Math.max(entry, -along - root);
    exit = Math.min(exit, -along + root);
  } else {
    const axes = volume.axes;
    const offsetX = originX - volume.center[0];
    const offsetY = originY - volume.center[1];
    const offsetZ = originZ - volume.center[2];
    for (let axis = 0; axis < 3; axis++) {
      const origin = axis === 0 ? originX : axis === 1 ? originY : originZ;
      let direction = axis === 0 ? directionX : axis === 1 ? directionY : directionZ;
      let relative = volume.center[axis] - origin;
      if (axes) {
        const at = axis * 3;
        relative = -(axes[at] * offsetX + axes[at + 1] * offsetY + axes[at + 2] * offsetZ);
        direction = axes[at] * directionX + axes[at + 1] * directionY + axes[at + 2] * directionZ;
      }
      const halfSize = volume.size[axis] / 2;
      if (direction === 0) {
        if (Math.abs(relative) > halfSize) return false;
        continue;
      }
      const first = (relative - halfSize) / direction;
      const second = (relative + halfSize) / direction;
      entry = Math.max(entry, Math.min(first, second));
      exit = Math.min(exit, Math.max(first, second));
    }
  }
  if (!(entry < exit)) return false;
  out[0] = entry;
  out[1] = exit;
  return true;
}
